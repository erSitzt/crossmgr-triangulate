import type { Antenna, Setup, Vec3 } from '@antenna/model/types';
import { makeRng } from '@antenna/rf/rng';
import { inverse, levenbergMarquardt, normalMatrix } from '../solve/lm';
import { applyParams, buildParams, DEFAULT_PRIORS, type AntennaFitSpec, type ParamDef, type Priors } from '../solve/params';
import type { ParamResult } from '../solve/rssiFit';
import type { PreparedWalk } from './walk';

export interface PhaseFitOptions {
  /**
   * Position part only: free and mount → x/y/z, angles/fixed → not moved. Mounted antennas are
   * fitted freely too: the phase measures the phase centre directly, while the panel position on a
   * truss member depends on the (much less certain) aim. The planned mount only sets the prior.
   */
  specs: AntennaFitSpec[];
  priors?: Priors;
  sigmaM?: number; // range scatter of one read (phase noise + multipath), metres
  huberM?: number;
  knotSpacingS?: number; // speed profile resolution
  smoothM?: number; // allowed change of speed between knots (as a second difference of position, m)
  starts?: number;
  seed?: number;
  maxIter?: number;
  /** multipath errors are correlated over ~λ/4 of tag motion: reads closer in time are not independent */
  correlationS?: number;
}

export interface WalkResult {
  label: string;
  knots: { t: number; s: number }[];
  rmsM: number;
  reads: number;
}

export interface PhaseFitResult {
  antennas: Antenna[];
  params: ParamResult[];
  walks: WalkResult[];
  sign: number; // +1: reported phase grows with distance, -1: falls
  rmsM: number;
  cost: number;
  iterations: number;
  warnings: string[];
}

interface WalkModel {
  pw: PreparedWalk;
  u: Vec3; // unit direction from → to
  knotT: number[]; // K+1 knot times; s(knotT[0]) = 0, s(knotT[K]) = L are fixed
  offset: number; // index of the first inner knot in the parameter vector
}

function buildWalkModel(pw: PreparedWalk, spacing: number, offset: number): WalkModel {
  const { from, to } = pw.walk;
  const L = Math.max(pw.lengthM, 1e-6);
  const u: Vec3 = [(to[0] - from[0]) / L, (to[1] - from[1]) / L, (to[2] - from[2]) / L];
  const dur = Math.max(pw.tEnd - pw.tStart, 1e-3);
  const K = Math.max(1, Math.round(dur / spacing));
  return { pw, u, knotT: Array.from({ length: K + 1 }, (_, k) => pw.tStart + (dur * k) / K), offset };
}

/**
 * Position along the line at time t (0 before the motion, L after it, piecewise linear in between)
 * and its dependence on the inner knots: s = s0·(1−w) + s1·w with parameter indices i0/i1 (−1 = fixed end).
 */
function sAt(m: WalkModel, x: number[], t: number): { s: number; i0: number; i1: number; w: number } {
  const T = m.knotT, K = T.length - 1, L = m.pw.lengthM;
  if (t <= T[0]) return { s: 0, i0: -1, i1: -1, w: 0 };
  if (t >= T[K]) return { s: L, i0: -1, i1: -1, w: 0 };
  const k = Math.min(K - 1, Math.floor(((t - T[0]) / (T[K] - T[0])) * K));
  const i0 = k === 0 ? -1 : m.offset + k - 1;
  const i1 = k + 1 === K ? -1 : m.offset + k;
  const s0 = i0 < 0 ? 0 : x[i0];
  const s1 = i1 < 0 ? L : x[i1];
  const w = (t - T[k]) / (T[k + 1] - T[k]);
  return { s: s0 + (s1 - s0) * w, i0, i1, w };
}

/** Huber pseudo-residual and its derivative. */
function huber(z: number, k: number): [number, number] {
  const a = Math.abs(z);
  if (a <= k) return [z, 1];
  const v = Math.sqrt(2 * k * a - k * k);
  return [Math.sign(z) * v, k / v];
}

/**
 * Antenna positions from phase walks. Per read the unwrapped round-trip phase gives
 *   ρ = sign · |antenna − tag(t)| + c_segment
 * with tag(t) on the walked line. Unknowns: antenna positions (free or along their truss member),
 * the walking profile s(t) (shared by all antennas), and one offset c per gap-free segment, which
 * is eliminated in closed form (variable projection: c = mean of ρ − sign·d over the segment).
 * The reader's phase sign convention is determined from the data.
 *
 * Geometry matters: walks on one line (or in one plane) leave a mirror ambiguity about it. Walk
 * crossing lines at clearly different heights, plus one close in front of antennas on the uprights.
 */
export function fitPhase(planned: Setup, walks: PreparedWalk[], opts: PhaseFitOptions): PhaseFitResult {
  const warnings: string[] = [];
  const moved = new Set(opts.specs.filter((s) => s.mode === 'free' || s.mode === 'mount').map((s) => s.antennaId));
  const setup: Setup = { ...planned, antennas: planned.antennas.map((a) => (moved.has(a.id) ? { ...a, mount: undefined } : a)) };
  const specs = opts.specs.map((s) => (s.mode === 'mount' ? { ...s, mode: 'free' as const } : s));
  const priors = opts.priors ?? DEFAULT_PRIORS;
  const sigma = opts.sigmaM ?? 0.01, hk = (opts.huberM ?? 0.03) / sigma;
  const smooth = opts.smoothM ?? 0.1;
  const { defs: aDefs, x0: aX0 } = buildParams(setup, specs, priors, 'position');
  const nA = aDefs.length;
  const x0 = [...aX0];
  const models: WalkModel[] = [];
  for (const pw of walks.filter((w) => w.segments.length)) {
    const m = buildWalkModel(pw, opts.knotSpacingS ?? 1, x0.length);
    const K = m.knotT.length - 1;
    for (let k = 1; k < K; k++) x0.push((pw.lengthM * k) / K);
    models.push(m);
  }
  if (!models.length) throw new Error('no walk with phase reads');
  const n = x0.length;
  const portToId = new Map(setup.antennas.filter((a) => a.enabled).map((a) => [a.port, a.id]));
  const paramsOf = new Map<string, number[]>(); // antenna id -> its parameter indices
  aDefs.forEach((d, i) => paramsOf.set(d.antennaId, [...(paramsOf.get(d.antennaId) ?? []), i]));

  const evaluate = (x: number[], sign: number, wantJ: boolean, perWalk?: { ss: number; n: number }[]) => {
    const ax = x.slice(0, nA);
    const antennas = applyParams(setup, aDefs, ax);
    const pos = new Map(antennas.map((a) => [a.id, a.position]));
    // d(position)/d(parameter): x/y/z trivially, `along` through the truss geometry
    const dPos: Vec3[] = aDefs.map((d, i) => {
      if (d.key === 'x') return [1, 0, 0];
      if (d.key === 'y') return [0, 1, 0];
      if (d.key === 'z') return [0, 0, 1];
      if (!wantJ) return [0, 0, 0];
      const h = 1e-4, xp = [...ax];
      xp[i] += h;
      const p1 = applyParams(setup, aDefs, xp).find((a) => a.id === d.antennaId)!.position;
      const p0 = pos.get(d.antennaId)!;
      return [(p1[0] - p0[0]) / h, (p1[1] - p0[1]) / h, (p1[2] - p0[2]) / h];
    });
    const r: number[] = [];
    const J: number[][] = [];
    models.forEach((m) => {
      const { from } = m.pw.walk;
      let ss = 0, cnt = 0;
      for (const seg of m.pw.segments) {
        const id = portToId.get(seg.port);
        const p = id && pos.get(id);
        if (!p) continue;
        const pIdx = paramsOf.get(id!) ?? [];
        const N = seg.t.length;
        const e = new Array<number>(N);
        const grads: number[][] = [];
        const mean = new Array<number>(n).fill(0);
        for (let i = 0; i < N; i++) {
          const q = sAt(m, x, seg.t[i]);
          const v: Vec3 = [from[0] + m.u[0] * q.s - p[0], from[1] + m.u[1] * q.s - p[1], from[2] + m.u[2] * q.s - p[2]];
          const d = Math.max(Math.hypot(v[0], v[1], v[2]), 1e-6);
          e[i] = seg.rho[i] - sign * d;
          if (!wantJ) continue;
          // e = ρ − sign·d ;  ∂d/∂antenna = −v/d · dPos ;  ∂d/∂s = v/d · u
          const g = new Array<number>(n).fill(0);
          for (const j of pIdx) g[j] = (sign * (v[0] * dPos[j][0] + v[1] * dPos[j][1] + v[2] * dPos[j][2])) / d;
          const ds = (-sign * (v[0] * m.u[0] + v[1] * m.u[1] + v[2] * m.u[2])) / d;
          if (q.i0 >= 0) g[q.i0] += ds * (1 - q.w);
          if (q.i1 >= 0) g[q.i1] += ds * q.w;
          for (const j of pIdx) mean[j] += g[j] / N;
          if (q.i0 >= 0) mean[q.i0] += (ds * (1 - q.w)) / N;
          if (q.i1 >= 0) mean[q.i1] += (ds * q.w) / N;
          grads.push(g);
        }
        const c = e.reduce((a, b) => a + b, 0) / N;
        for (let i = 0; i < N; i++) {
          const [hv, hd] = huber((e[i] - c) / sigma, hk);
          r.push(hv);
          ss += (e[i] - c) ** 2;
          cnt++;
          if (wantJ) J.push(grads[i].map((gv, j) => ((gv - mean[j]) * hd) / sigma));
        }
      }
      perWalk?.push({ ss, n: cnt });
      // smooth walking: penalise changes of speed between knots
      const K = m.knotT.length - 1;
      const idx = (k: number) => (k === 0 || k === K ? -1 : m.offset + k - 1);
      const sk = (k: number) => (k === 0 ? 0 : k === K ? m.pw.lengthM : x[idx(k)]);
      for (let k = 1; k < K; k++) {
        r.push((sk(k - 1) - 2 * sk(k) + sk(k + 1)) / smooth);
        if (wantJ) {
          const row = new Array<number>(n).fill(0);
          if (idx(k - 1) >= 0) row[idx(k - 1)] += 1 / smooth;
          row[idx(k)] -= 2 / smooth;
          if (idx(k + 1) >= 0) row[idx(k + 1)] += 1 / smooth;
          J.push(row);
        }
      }
    });
    aDefs.forEach((d, i) => {
      r.push((x[i] - d.prior.mean) / d.prior.sd);
      if (wantJ) {
        const row = new Array<number>(n).fill(0);
        row[i] = 1 / d.prior.sd;
        J.push(row);
      }
    });
    return { r, J };
  };

  const run = (sign: number, xs: number[], maxIter: number) =>
    levenbergMarquardt((x) => evaluate(x, sign, false).r, xs, [], { maxIter, jac: (x) => evaluate(x, sign, true).J });

  // sign convention: a short fit from the plan decides, then the multi-start runs with that sign
  const probe = [1, -1].map((sg) => ({ sign: sg, sol: run(sg, x0, 8) })).sort((a, b) => a.sol.cost - b.sol.cost);
  const sign = probe[0].sign;
  if (probe[1].sol.cost < probe[0].sol.cost * 1.5) warnings.push('Phase sign convention is ambiguous – check the walk geometry and reads.');
  const { gauss } = makeRng(opts.seed ?? 1);
  const starts = Math.max(1, opts.starts ?? 4);
  let best = run(sign, probe[0].sol.x, opts.maxIter ?? 60);
  let iterations = probe[0].sol.iterations + probe[1].sol.iterations + best.iterations;
  for (let s = 1; s < starts; s++) {
    const xs = x0.map((v, i) => (i < nA ? v + gauss() * aDefs[i].prior.sd * 0.5 : v));
    const sol = run(sign, xs, opts.maxIter ?? 60);
    iterations += sol.iterations;
    if (sol.cost < best.cost) best = sol;
  }

  const perWalk: { ss: number; n: number }[] = [];
  evaluate(best.x, sign, false, perWalk);
  const nSeg = models.reduce((a, m) => a + m.pw.segments.length, 0);
  // effective number of independent reads per segment: one per correlation time
  const corr = opts.correlationS ?? 0.25;
  let nReads = 0, nEff = 0;
  for (const m of models)
    for (const g of m.pw.segments) {
      nReads += g.t.length;
      nEff += Math.min(g.t.length, Math.max(1, (g.t[g.t.length - 1] - g.t[0]) / corr));
    }
  const scale = Math.max(1, (2 * best.cost) / Math.max(1, best.r.length - n - nSeg)) * Math.max(1, nReads / Math.max(1, nEff));
  const cov = inverse(normalMatrix(best.J));
  const params: ParamResult[] = aDefs.map((d: ParamDef, i) => ({ ...d, value: best.x[i], sd: cov ? Math.sqrt(Math.max(0, cov[i][i] * scale)) : Infinity }));
  for (const p of params)
    if (p.sd > 0.1) warnings.push(`${setup.antennas.find((a) => a.id === p.antennaId)?.name ?? p.antennaId} ${p.key}: ±${p.sd.toFixed(2)} m – weakly determined (walk another line, closer to it or at another height).`);
  for (const a of setup.antennas.filter((a) => a.enabled))
    if (!models.some((m) => m.pw.readsPerPort[a.port])) warnings.push(`${a.name}: no phase reads on port ${a.port} – position not measured.`);

  const walksOut: WalkResult[] = models.map((m, wi) => {
    const K = m.knotT.length - 1;
    return {
      label: m.pw.walk.label,
      knots: m.knotT.map((t, k) => ({ t, s: k === 0 ? 0 : k === K ? m.pw.lengthM : best.x[m.offset + k - 1] })),
      rmsM: Math.sqrt(perWalk[wi].ss / Math.max(1, perWalk[wi].n)),
      reads: perWalk[wi].n,
    };
  });
  const ss = perWalk.reduce((a, w) => a + w.ss, 0), cnt = perWalk.reduce((a, w) => a + w.n, 0);
  return {
    antennas: applyParams(setup, aDefs, best.x.slice(0, nA), true),
    params,
    walks: walksOut,
    sign,
    rmsM: Math.sqrt(ss / Math.max(1, cnt)),
    cost: best.cost,
    iterations,
    warnings,
  };
}
