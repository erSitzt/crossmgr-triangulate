import { describe, expect, it } from 'vitest';
import type { Setup } from '@antenna/model/types';
import { makeDefaultSetup } from '@antenna/presets/templates';
import { aggregate } from '../capture/stats';
import { gridSurvey, makeDefaultSurvey } from '../survey/types';
import { levenbergMarquardt } from './lm';
import { applyParams, buildParams, type AntennaFitSpec } from './params';
import { fitRssi } from './rssiFit';
import { perturbSetup, synthCapture } from './synth';

const survey36 = () => gridSurvey([-2.5, -0.8, 0.8, 2.5], [-3, 0, 3], [0.3, 0.8, 1.3]);

const errors = (truth: Setup, fitted: Setup['antennas']) =>
  truth.antennas.map((t) => {
    const f = fitted.find((a) => a.id === t.id)!;
    return {
      pos: Math.hypot(f.position[0] - t.position[0], f.position[1] - t.position[1], f.position[2] - t.position[2]),
      yaw: Math.abs(f.yawDeg - t.yawDeg),
      pitch: Math.abs(f.pitchDeg - t.pitchDeg),
      offset: Math.abs(f.cableLossDb - t.cableLossDb),
    };
  });

describe('levenberg-marquardt', () => {
  it('fits a circle centre', () => {
    const pts = Array.from({ length: 12 }, (_, i) => [2 + 3 * Math.cos(i), -1 + 3 * Math.sin(i)]);
    const f = (x: number[]) => pts.map(([px, py]) => Math.hypot(px - x[0], py - x[1]) - x[2]);
    const r = levenbergMarquardt(f, [0, 0, 1], [1e-4, 1e-4, 1e-4]);
    expect(r.x[0]).toBeCloseTo(2, 4);
    expect(r.x[1]).toBeCloseTo(-1, 4);
    expect(r.x[2]).toBeCloseTo(3, 4);
  });
});

describe('parameters', () => {
  it('round-trips free and mounted antennas', () => {
    const s = makeDefaultSetup();
    const specs: AntennaFitSpec[] = s.antennas.map((a, i) => ({ antennaId: a.id, mode: i === 0 ? 'free' : 'mount', fitOffset: true }));
    const { defs, x0 } = buildParams(s, specs);
    expect(defs.length).toBe(6 + 4 + 4);
    const same = applyParams(s, defs, x0);
    same.forEach((a, i) => {
      a.position.forEach((v, k) => expect(v).toBeCloseTo(s.antennas[i].position[k], 2));
      expect(a.cableLossDb).toBeCloseTo(s.antennas[i].cableLossDb, 6);
    });
    // moving a mounted antenna along its member moves its position
    const x = [...x0];
    x[defs.findIndex((d) => d.key === 'along')] += 0.5;
    const moved = applyParams(s, defs, x);
    expect(Math.abs(moved[1].position[1] - s.antennas[1].position[1])).toBeCloseTo(0.5, 2);
  });
});

describe('capture statistics', () => {
  it('aggregates reads and handles the π phase ambiguity', () => {
    const reads = Array.from({ length: 40 }, (_, i) => ({
      epc: 'A', port: 1, rssi: -50 - (i % 3), channel: 1, phase: (1.0 + (i % 2) * Math.PI) % (2 * Math.PI), ts: i * 100_000,
    }));
    const c = aggregate(reads);
    const st = c.tags.A[1];
    expect(st.count).toBe(40);
    expect(st.medianRssi).toBe(-51);
    expect(st.phase[1].mean).toBeCloseTo(1.0, 6);
    expect(st.phase[1].r).toBeCloseTo(1, 6);
  });
});

describe('rssi fit (synthetic recovery)', () => {
  it('model reproduces its own capture exactly at the true pose', () => {
    const s = makeDefaultSetup();
    const survey = makeDefaultSurvey();
    const cap = synthCapture(s, survey, { noiseDb: 0, seed: 1 });
    const specs = s.antennas.map((a) => ({ antennaId: a.id, mode: 'mount' as const, fitOffset: true }));
    const r = fitRssi(s, survey, cap, { specs, starts: 1 });
    expect(r.rmsDb).toBeLessThan(0.05);
    for (const e of errors(s, r.antennas)) expect(e.pos).toBeLessThan(0.01);
  });

  it('recovers mounted antennas from a 1 m / 15° wrong plan with 3 dB scatter (18 stakes)', () => {
    const plan = makeDefaultSetup();
    const survey = makeDefaultSurvey();
    const specs = plan.antennas.map((a) => ({ antennaId: a.id, mode: 'mount' as const, fitOffset: true }));
    let inside = 0, total = 0;
    for (const seed of [1, 2, 3, 4]) {
      const truth = perturbSetup(plan, { posM: 1, angDeg: 15, offsetDb: 1.5, seed: 100 + seed });
      const r = fitRssi(plan, survey, synthCapture(truth, survey, { noiseDb: 3, seed }), { specs, seed });
      for (const p of r.params) {
        const t = truth.antennas.find((a) => a.id === p.antennaId)!, pl = plan.antennas.find((a) => a.id === p.antennaId)!;
        const tv = p.key === 'yaw' ? t.yawDeg : p.key === 'pitch' ? t.pitchDeg : p.key === 'along' ? t.mount!.alongM : t.cableLossDb - pl.cableLossDb;
        const e = Math.abs(p.value - tv);
        total++;
        if (e <= 3 * p.sd) inside++;
        if (p.key === 'along') expect(e).toBeLessThan(0.3);
        if (p.key === 'yaw' && Math.abs(pl.pitchDeg) < 60) expect(e).toBeLessThan(8); // yaw of a downward antenna is weakly defined
        if (p.key === 'pitch') expect(e).toBeLessThan(12);
      }
    }
    // reported uncertainties are honest
    expect(inside / total).toBeGreaterThan(0.9);
  });

  it('recovers free antenna positions (less constrained, looser bounds)', () => {
    const plan = makeDefaultSetup();
    const truth = perturbSetup({ ...plan, antennas: plan.antennas.map((a) => ({ ...a, mount: undefined })) }, { posM: 0.7, angDeg: 12, offsetDb: 1, seed: 11 });
    const survey = survey36();
    const cap = synthCapture(truth, survey, { noiseDb: 2, seed: 4 });
    const specs = plan.antennas.map((a) => ({ antennaId: a.id, mode: 'free' as const, fitOffset: true }));
    const r = fitRssi(plan, survey, cap, { specs, starts: 16, seed: 9 });
    const e = errors(truth, r.antennas);
    for (const x of e) expect(x.pos).toBeLessThan(0.6);
  });
});

describe('validation and export', () => {
  it('prefers the true ground material and round-trips the fitted setup', async () => {
    const { groundScan, portSummary, compare } = await import('../validate/validate');
    const { mergeFitted } = await import('../export');
    const { groundPreset } = await import('@antenna/rf/ground');
    const plan = makeDefaultSetup();
    const wet = { ...plan, env: { ...plan.env, ground: groundPreset('asphalt'), terrainGround: groundPreset('asphalt') } };
    const survey = gridSurvey([-2, 0, 2], [-3, 0, 3], [0.3, 0.8, 1.3, 1.8]);
    const cap = synthCapture(wet, survey, { noiseDb: 0.5, seed: 2 });
    expect(groundScan(plan, plan.antennas, survey, cap)[0].presetId).toBe('asphalt');
    const sum = portSummary(compare(wet, wet.antennas, survey, cap));
    for (const p of sum) expect(p.rmsDb).toBeLessThan(1);
    const merged = mergeFitted(plan, plan.antennas.map((a) => ({ ...a, yawDeg: a.yawDeg + 3 })));
    merged.antennas.forEach((a, i) => expect(a.yawDeg).toBeCloseTo(plan.antennas[i].yawDeg + 3, 6));
    expect(merged.track).toEqual(plan.track);
  });
});
