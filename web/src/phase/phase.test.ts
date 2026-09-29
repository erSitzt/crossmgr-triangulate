import { describe, expect, it } from 'vitest';
import type { Setup, Vec3 } from '@antenna/model/types';
import { makeDefaultSetup } from '@antenna/presets/templates';
import { makeDefaultSurvey } from '../survey/types';
import { perturbSetup, synthCapture } from '../solve/synth';
import { fitRssi } from '../solve/rssiFit';
import { fitCombined } from './combined';
import { fitPhase } from './phaseFit';
import { DEFAULT_SYNTH_WALK, synthWalk } from './synthWalk';
import { channelFreqMHz, prepareWalk } from './walk';

/** Recommended walks: centre line low, across under the arch high, along the left edge in front of the upright. */
const WALKS: { from: Vec3; to: Vec3; label: string }[] = [
  { from: [-4, 0.4, 0], to: [4, 0.4, 0], label: 'centre low' },
  { from: [1.5, 1.6, -3.5], to: [1.5, 1.6, 3.5], label: 'across high' },
  { from: [-3, 0.3, -3.6], to: [3, 0.3, -3.6], label: 'left edge' },
];

const posErr = (truth: Setup, fitted: Setup['antennas']) =>
  truth.antennas.map((t) => {
    const f = fitted.find((a) => a.id === t.id)!;
    return Math.hypot(f.position[0] - t.position[0], f.position[1] - t.position[1], f.position[2] - t.position[2]);
  });

describe('walk preparation', () => {
  it('detects the still phases and unwraps through π jumps', () => {
    const s = makeDefaultSetup();
    const w = synthWalk(s, makeDefaultSurvey(), WALKS[0], { ...DEFAULT_SYNTH_WALK, speedJitter: 0, seed: 1 });
    const pw = prepareWalk(w);
    expect(pw.warnings).toEqual([]);
    expect(Math.abs(pw.tStart - 3)).toBeLessThan(0.4);
    expect(Math.abs(pw.tEnd - (3 + 8 / 0.35))).toBeLessThan(0.6);
    for (const seg of pw.segments) {
      const a = s.antennas.find((x) => x.port === seg.port)!;
      const e = seg.t.map((t, i) => {
        const x = -4 + Math.min(8, Math.max(0, (t - 3) * 0.35));
        return seg.rho[i] + Math.hypot(x - a.position[0], 0.4 - a.position[1], -a.position[2]);
      });
      const m = e.reduce((p, q) => p + q, 0) / e.length;
      expect(Math.sqrt(e.reduce((p, q) => p + (q - m) ** 2, 0) / e.length)).toBeLessThan(0.01);
    }
  });

  it('maps ETSI channels to frequencies', () => {
    expect(channelFreqMHz(1, 'etsi', 866)).toBeCloseTo(865.7, 6);
    expect(channelFreqMHz(4, 'etsi', 866)).toBeCloseTo(867.5, 6);
    expect(channelFreqMHz(null, 'etsi', 866)).toBe(866);
  });
});

describe('phase fit (synthetic)', () => {
  const plan0 = makeDefaultSetup();
  const survey = makeDefaultSurvey();

  it('locates free antennas to a few cm from three walks, with honest uncertainties', () => {
    const plan = { ...plan0, antennas: plan0.antennas.map((a) => ({ ...a, mount: undefined })) };
    const truth = perturbSetup(plan, { posM: 0.8, angDeg: 10, offsetDb: 1, seed: 3 });
    const walks = WALKS.map((g, i) => prepareWalk(synthWalk(truth, survey, g, { ...DEFAULT_SYNTH_WALK, seed: i + 1 })));
    const r = fitPhase(plan, walks, { specs: plan.antennas.map((a) => ({ antennaId: a.id, mode: 'free', fitOffset: false })) });
    expect(r.sign).toBe(DEFAULT_SYNTH_WALK.sign);
    for (const e of posErr(truth, r.antennas)) expect(e).toBeLessThan(0.05);
    for (const p of r.params) {
      const t = truth.antennas.find((a) => a.id === p.antennaId)!;
      const tv = t.position['xyz'.indexOf(p.key)];
      expect(Math.abs(p.value - tv)).toBeLessThan(4 * p.sd + 0.005);
    }
  });

  it('flags the mirror ambiguity of a single walk', () => {
    const plan = { ...plan0, antennas: plan0.antennas.map((a) => ({ ...a, mount: undefined })) };
    const truth = perturbSetup(plan, { posM: 0.8, angDeg: 10, offsetDb: 1, seed: 3 });
    const walks = [prepareWalk(synthWalk(truth, survey, WALKS[0], { ...DEFAULT_SYNTH_WALK, seed: 1 }))];
    const r = fitPhase(plan, walks, { specs: plan.antennas.map((a) => ({ antennaId: a.id, mode: 'free', fitOffset: false })) });
    expect(r.warnings.some((w) => w.includes('weakly determined'))).toBe(true);
  });

  it('combined with the RSSI grid: cm positions and better pitch than RSSI alone (truss mounts, 4 seeds)', () => {
    const specs = plan0.antennas.map((a) => ({ antennaId: a.id, mode: 'mount' as const, fitOffset: true }));
    let pitchC = 0, pitchR = 0;
    for (let s = 1; s <= 4; s++) {
      const truth = perturbSetup(plan0, { posM: 1, angDeg: 15, offsetDb: 1.5, seed: 200 + s });
      const walks = WALKS.map((g, i) => prepareWalk(synthWalk(truth, survey, g, { ...DEFAULT_SYNTH_WALK, seed: 10 * s + i })));
      const capture = synthCapture(truth, survey, { noiseDb: 3, seed: s });
      const c = fitCombined(plan0, walks, survey, capture, { specs });
      const r = fitRssi(plan0, survey, capture, { specs });
      for (const e of posErr(truth, c.setup.antennas)) expect(e).toBeLessThan(0.05);
      const pitch = (list: Setup['antennas']) => truth.antennas.reduce((sum, t) => sum + Math.abs(list.find((a) => a.id === t.id)!.pitchDeg - t.pitchDeg), 0);
      pitchC += pitch(c.setup.antennas);
      pitchR += pitch(r.antennas);
    }
    expect(pitchC).toBeLessThan(pitchR);
  });
});
