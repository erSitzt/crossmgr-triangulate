import type { Setup, Vec3 } from '@antenna/model/types';
import { makeRng } from '@antenna/rf/rng';
import type { Read } from '../capture/stats';
import { makeRefModel } from '../solve/model';
import type { Survey } from '../survey/types';
import { channelFreqMHz, type Walk } from './walk';

export interface SynthWalkOptions {
  speedMs: number; // average walking speed
  speedJitter: number; // ± fraction, slow sinusoidal variation
  standS: number; // still at each end
  readsPerSecond: number; // all ports together; the reader visits the ports round-robin
  phaseNoiseRad: number;
  multipathM: number; // slowly varying range error (multipath), amplitude in metres
  sign: 1 | -1; // reader phase convention
  piJumps: boolean; // Impinj-style random π ambiguity
  channels: number[]; // hop sequence, 200 ms per channel (one entry = fixed)
  seed: number;
}

export const DEFAULT_SYNTH_WALK: SynthWalkOptions = {
  speedMs: 0.35,
  speedJitter: 0.25,
  standS: 3,
  readsPerSecond: 120,
  phaseNoiseRad: 0.1,
  multipathM: 0.005,
  sign: -1,
  piJumps: true,
  channels: [1],
  seed: 1,
};

/** Reads a reader would report while a tag is walked from → to through the `truth` setup. */
export function synthWalk(truth: Setup, survey: Survey, geom: { from: Vec3; to: Vec3; epc?: string; label?: string }, o: SynthWalkOptions): Walk {
  const { next, gauss } = makeRng(o.seed);
  const ants = truth.antennas.filter((a) => a.enabled);
  const tag = { epc: 'W', name: 'walk', pos: [...geom.from] as Vec3, axis: [0, 1, 0] as Vec3, enabled: true };
  const model = makeRefModel(truth, { ...survey, tags: [tag] });
  const ctx = new Map(ants.map((a) => [a.port, model.antennaCtx(a)]));
  const offset = new Map(ants.map((a) => [a.port, next() * 2 * Math.PI]));
  const mpPhase = new Map(ants.map((a) => [a.port, next() * 2 * Math.PI]));
  const L = Math.hypot(geom.to[0] - geom.from[0], geom.to[1] - geom.from[1], geom.to[2] - geom.from[2]);
  const u: Vec3 = [(geom.to[0] - geom.from[0]) / L, (geom.to[1] - geom.from[1]) / L, (geom.to[2] - geom.from[2]) / L];
  const epc = geom.epc ?? 'WALK0001';
  const dt = 1 / o.readsPerSecond;
  const t0Us = 1_700_000_000_000_000;
  const jitterPhase = next() * 2 * Math.PI;
  const reads: Read[] = [];
  let s = 0, arrived = Infinity;
  for (let k = 0; ; k++) {
    const t = k * dt;
    if (t > arrived + o.standS || t > 600) break;
    if (t > o.standS && s < L) {
      s = Math.min(L, s + o.speedMs * (1 + o.speedJitter * Math.sin(2 * Math.PI * 0.25 * t + jitterPhase)) * dt);
      if (s >= L) arrived = t;
    }
    for (let i = 0; i < 3; i++) tag.pos[i] = geom.from[i] + u[i] * s;
    const a = ants[k % ants.length];
    const l = model.link(ctx.get(a.port)!, 0);
    if (l.margin <= 0 || next() > 0.9) continue;
    const ch = o.channels[Math.floor(t / 0.2) % o.channels.length];
    const lambda = 299.792458 / channelFreqMHz(ch, 'etsi', truth.env.freqMHz);
    const d = Math.hypot(tag.pos[0] - a.position[0], tag.pos[1] - a.position[1], tag.pos[2] - a.position[2]);
    const mp = o.multipathM * Math.sin((2 * Math.PI * d) / 0.7 + mpPhase.get(a.port)!);
    let ph = (o.sign * 4 * Math.PI * (d + mp)) / lambda + offset.get(a.port)! + gauss() * o.phaseNoiseRad;
    if (o.piJumps && next() < 0.5) ph += Math.PI;
    ph = ((ph % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    reads.push({ epc, port: a.port, rssi: Math.round(l.rssiDbm * 100) / 100, phase: ph, doppler: null, channel: ch, ts: Math.round(t0Us + t * 1e6) });
  }
  return { id: `walk-${geom.label ?? 'w'}-${o.seed}`, label: geom.label ?? 'walk', epc, from: geom.from, to: geom.to, reads };
}
