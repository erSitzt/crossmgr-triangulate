import type { Antenna, Setup } from '@antenna/model/types';
import { makeRng } from '@antenna/rf/rng';
import type { Capture } from '../capture/stats';
import type { Survey } from '../survey/types';
import { inverse, levenbergMarquardt, normalMatrix } from './lm';
import { makeRefModel, type RefModel } from './model';
import { applyParams, buildParams, DEFAULT_PRIORS, type AntennaFitSpec, type ParamDef, type Priors } from './params';

export interface FitOptions {
  specs: AntennaFitSpec[];
  priors?: Priors;
  sigmaDb?: number; // expected model-vs-reality scatter of a median RSSI (multipath, tag detuning)
  huberDb?: number; // residuals beyond this are down-weighted
  starts?: number; // per antenna: planned pose + (starts-1) random draws from the priors
  seed?: number;
  maxIter?: number;
  /** tags without a single read on any port are usually missing/dead, not "out of range" */
  includeUnreadTags?: boolean;
}

export interface Observation {
  tagIndex: number;
  epc: string;
  port: number;
  rssi: number | null; // null = censored: tag present, but never read on this port
}

export interface ObsResult extends Observation {
  predicted: number;
  margin: number;
  residualDb: number | null; // measured - predicted
}

export interface ParamResult extends ParamDef {
  value: number;
  sd: number;
}

export interface FitResult {
  antennas: Antenna[];
  params: ParamResult[];
  obs: ObsResult[];
  cost: number;
  rmsDb: number;
  startsTried: number;
  iterations: number;
  warnings: string[];
}

/** Observations: every enabled surveyed tag × every port of an antenna in the setup. */
export function buildObservations(setup: Setup, survey: Survey, capture: Capture, includeUnreadTags = false): Observation[] {
  const ports = setup.antennas.filter((a) => a.enabled).map((a) => a.port);
  const out: Observation[] = [];
  survey.tags.forEach((t, tagIndex) => {
    if (!t.enabled) return;
    const byPort = capture.tags[t.epc];
    if (!byPort && !includeUnreadTags) return;
    for (const port of ports) out.push({ tagIndex, epc: t.epc, port, rssi: byPort?.[port]?.medianRssi ?? null });
  });
  return out;
}

const huber = (r: number, k: number) => (Math.abs(r) <= k ? r : Math.sign(r) * Math.sqrt(2 * k * Math.abs(r) - k * k));

interface Problem {
  model: RefModel;
  defs: ParamDef[];
  obs: Observation[];
  sigma: number;
  k: number;
  portToId: Map<number, string>;
}

function evaluate(p: Problem, x: number[]) {
  const antennas = applyParams(p.model.setup, p.defs, x);
  const ctxById = new Map(antennas.map((a) => [a.id, p.model.antennaCtx(a)]));
  return p.obs.map((o) => p.model.link(ctxById.get(p.portToId.get(o.port)!)!, o.tagIndex));
}

function residuals(p: Problem, x: number[]): number[] {
  const links = evaluate(p, x);
  const r: number[] = [];
  const kk = p.k / p.sigma;
  p.obs.forEach((o, i) => {
    const l = links[i];
    if (o.rssi === null) {
      // not read: the model must not predict a readable link (1 dB slack)
      r.push(huber(Math.max(0, l.margin + 1) / p.sigma, kk));
    } else {
      r.push(huber((o.rssi - l.rssiDbm) / p.sigma, kk));
      // read: the model must predict a readable link (the tag chip was powered)
      r.push(huber(Math.min(0, l.margin + 1) / p.sigma, kk));
    }
  });
  p.defs.forEach((d, i) => r.push((x[i] - d.prior.mean) / d.prior.sd));
  return r;
}

const sumSq = (r: number[]) => r.reduce((s, v) => s + v * v, 0);

/**
 * Robust least-squares fit of the antenna poses to the captured median RSSI (and to which tags were
 * not read at all). Every observation depends on one antenna only, so the problem separates: each
 * antenna is solved on its own with many starts, which finds the global minimum far more reliably
 * than one joint multi-start over all antennas.
 */
export function fitRssi(setup: Setup, survey: Survey, capture: Capture, opts: FitOptions): FitResult {
  const warnings: string[] = [];
  const priors = opts.priors ?? DEFAULT_PRIORS;
  const model = makeRefModel(setup, survey);
  const { defs, x0 } = buildParams(setup, opts.specs, priors);
  const obs = buildObservations(setup, survey, capture, opts.includeUnreadTags);
  const portToId = new Map(setup.antennas.filter((a) => a.enabled).map((a) => [a.port, a.id]));
  const sigma = opts.sigmaDb ?? 3, k = opts.huberDb ?? 6;
  const { gauss } = makeRng(opts.seed ?? 1);
  const starts = Math.max(1, opts.starts ?? 24);

  const x = [...x0];
  const sd = new Array(defs.length).fill(0);
  let cost = 0, iterations = 0;
  for (const a of setup.antennas.filter((a) => a.enabled)) {
    const idx = defs.map((d, i) => (d.antennaId === a.id ? i : -1)).filter((i) => i >= 0);
    const sub: Problem = { model, defs: idx.map((i) => defs[i]), obs: obs.filter((o) => o.port === a.port), sigma, k, portToId };
    const nRead = sub.obs.filter((o) => o.rssi !== null).length;
    if (nRead < 2 * idx.length) warnings.push(`${a.name}: only ${nRead} tags read for ${idx.length} unknowns – add reference tags in its beam or fix parameters.`);
    if (!idx.length) {
      cost += 0.5 * sumSq(residuals(sub, []));
      continue;
    }
    const sx0 = idx.map((i) => x0[i]);
    const f = (v: number[]) => residuals(sub, v);
    const steps = sub.defs.map((d) => d.step);
    let best: ReturnType<typeof levenbergMarquardt> | null = null;
    for (let s = 0; s < starts; s++) {
      const xs = s === 0 ? sx0 : sub.defs.map((d, j) => sx0[j] + gauss() * d.prior.sd);
      const res = levenbergMarquardt(f, xs, steps, { maxIter: opts.maxIter ?? 60 });
      iterations += res.iterations;
      if (!best || res.cost < best.cost) best = res;
    }
    const sol = best!;
    cost += sol.cost;
    // 1σ uncertainty from the Gauss–Newton covariance, inflated when residuals are larger than sigma
    const scale = Math.max(1, (2 * sol.cost) / Math.max(1, sol.r.length - idx.length));
    const cov = inverse(normalMatrix(sol.J));
    idx.forEach((i, j) => {
      x[i] = sol.x[j];
      sd[i] = cov ? Math.sqrt(Math.max(0, cov[j][j] * scale)) : Infinity;
    });
  }

  const params: ParamResult[] = defs.map((d, i) => ({ ...d, value: x[i], sd: sd[i] }));
  for (const q of params) {
    const lim = q.key === 'offset' ? 2 : q.key === 'yaw' || q.key === 'pitch' ? 10 : 0.5;
    if (q.sd > lim) warnings.push(`${setup.antennas.find((a) => a.id === q.antennaId)?.name ?? q.antennaId} ${q.key}: ±${q.sd.toFixed(2)} – weakly determined`);
  }

  const links = evaluate({ model, defs, obs, sigma, k, portToId }, x);
  const obsOut: ObsResult[] = obs.map((o, i) => ({
    ...o,
    predicted: links[i].rssiDbm,
    margin: links[i].margin,
    residualDb: o.rssi === null ? null : o.rssi - links[i].rssiDbm,
  }));
  const rs = obsOut.filter((o) => o.residualDb !== null).map((o) => o.residualDb!);
  return {
    antennas: applyParams(setup, defs, x, true),
    params,
    obs: obsOut,
    cost,
    rmsDb: rs.length ? Math.sqrt(sumSq(rs) / rs.length) : 0,
    startsTried: starts,
    iterations,
    warnings,
  };
}
