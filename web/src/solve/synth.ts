import type { Setup, Vec3 } from '@antenna/model/types';
import { makeRng } from '@antenna/rf/rng';
import type { Capture } from '../capture/stats';
import type { Survey } from '../survey/types';
import { makeRefModel } from './model';
import { mountedPosition } from './params';

export interface Deviation {
  posM: number; // max position error per axis (free antennas) / along the member (mounted)
  angDeg: number; // max yaw / pitch error
  offsetDb: number; // max extra one-way loss per port
  seed: number;
}

/** "Real world": the planned setup with random mounting errors. */
export function perturbSetup(setup: Setup, d: Deviation): Setup {
  const { next } = makeRng(d.seed);
  const u = () => 2 * next() - 1;
  const antennas = setup.antennas.map((a0) => {
    const a = { ...a0, position: [...a0.position] as Vec3, mount: a0.mount && { ...a0.mount } };
    a.yawDeg += u() * d.angDeg;
    a.pitchDeg += u() * d.angDeg;
    a.cableLossDb += u() * d.offsetDb;
    if (a.mount) {
      a.mount.alongM += u() * d.posM;
      a.position = mountedPosition(setup, a);
    } else a.position = a.position.map((v) => v + u() * d.posM) as Vec3;
    return a;
  });
  return { ...setup, antennas };
}

export interface SynthOptions {
  noiseDb: number; // per-spot scatter of the median RSSI vs the model (multipath etc.)
  seed: number;
  durationS?: number;
  readsPerSecond?: number; // per port, for a tag well inside the zone
}

/** Capture as the reader would deliver it for `truth`, aggregated per tag and port. */
export function synthCapture(truth: Setup, survey: Survey, o: SynthOptions): Capture {
  const { gauss } = makeRng(o.seed);
  const model = makeRefModel(truth, survey);
  const durationS = o.durationS ?? 10;
  const rate = o.readsPerSecond ?? 30;
  const tags: Capture['tags'] = {};
  const ants = truth.antennas.filter((a) => a.enabled);
  survey.tags.forEach((t, i) => {
    if (!t.enabled) return;
    for (const a of ants) {
      const l = model.link(model.antennaCtx(a), i);
      const noise = gauss() * o.noiseDb;
      if (l.margin + noise < 0) continue;
      const r = rate * Math.min(1, (l.margin + noise) / 6);
      const count = Math.max(1, Math.round(r * durationS));
      (tags[t.epc] ??= {})[a.port] = { count, ratePerS: count / durationS, medianRssi: l.rssiDbm + noise, madRssi: 1, phase: {} };
    }
  });
  return { durationS, tags, ports: ants.map((a) => a.port) };
}
