import type { Antenna, Setup, Vec3 } from '@antenna/model/types';
import { memberPoint } from '@antenna/model/normalize';
import { boresight } from '@antenna/rf/math';

/**
 * How an antenna's pose is estimated:
 *  free  – position x/y/z plus yaw/pitch
 *  mount – stays on its truss member: offset along the member plus yaw/pitch (3 unknowns instead of 5)
 *  angles – position taken as known (e.g. from the phase fit), only yaw/pitch are fitted
 *  fixed – pose taken as measured, only the gain offset may be fitted
 */
export type PoseMode = 'free' | 'mount' | 'angles' | 'fixed';

export interface AntennaFitSpec {
  antennaId: string;
  mode: PoseMode;
  fitOffset: boolean; // per-port extra one-way loss (dB), e.g. real cable/connector/antenna gain vs datasheet
}

export interface Priors {
  posSdM: number; // how far the real antenna may be from the planned one
  angSdDeg: number;
  offsetSdDb: number;
}

export const DEFAULT_PRIORS: Priors = { posSdM: 1.5, angSdDeg: 25, offsetSdDb: 2 };

export type ParamKey = 'x' | 'y' | 'z' | 'yaw' | 'pitch' | 'along' | 'offset';

export interface ParamDef {
  antennaId: string;
  key: ParamKey;
  step: number; // finite-difference step
  prior: { mean: number; sd: number };
}

const STEP: Record<ParamKey, number> = { x: 0.005, y: 0.005, z: 0.005, along: 0.005, yaw: 0.1, pitch: 0.1, offset: 0.02 };

export function buildParams(
  setup: Setup,
  specs: AntennaFitSpec[],
  priors: Priors = DEFAULT_PRIORS,
  only?: 'position',
): { defs: ParamDef[]; x0: number[] } {
  const defs: ParamDef[] = [];
  const x0: number[] = [];
  const add = (antennaId: string, key: ParamKey, mean: number, sd: number) => {
    defs.push({ antennaId, key, step: STEP[key], prior: { mean, sd } });
    x0.push(mean);
  };
  for (const s of specs) {
    const a = setup.antennas.find((x) => x.id === s.antennaId);
    if (!a) continue;
    const mode = s.mode === 'mount' && !a.mount ? 'free' : s.mode;
    if (mode === 'free') {
      add(a.id, 'x', a.position[0], priors.posSdM);
      add(a.id, 'y', a.position[1], priors.posSdM);
      add(a.id, 'z', a.position[2], priors.posSdM);
    } else if (mode === 'mount') add(a.id, 'along', a.mount!.alongM, priors.posSdM);
    if (only === 'position') continue;
    if (mode !== 'fixed') {
      add(a.id, 'yaw', a.yawDeg, priors.angSdDeg);
      add(a.id, 'pitch', a.pitchDeg, priors.angSdDeg);
    }
    if (s.fitOffset) add(a.id, 'offset', 0, priors.offsetSdDb);
  }
  return { defs, x0 };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Same placement rule as crossmgr-antenna's normalizeSetup: the panel sits in front of the truss member. */
export function mountedPosition(setup: Setup, a: Antenna): Vec3 {
  const t = setup.trusses.find((x) => x.id === a.mount!.trussId);
  if (!t) return a.position;
  const p = memberPoint(t, a.mount!.member, a.mount!.alongM);
  const prof = setup.antennaProfiles.find((x) => x.id === a.profileId) ?? setup.antennaProfiles[0];
  const b = boresight(a.yawDeg, a.pitchDeg);
  const off = t.sectionM / 2 + (prof?.sizeM[2] ?? 0.05) / 2 + 0.03;
  return [p[0] + b[0] * off, p[1] + b[1] * off, p[2] + b[2] * off];
}

/**
 * Applies a parameter vector to the setup's antennas. The fitted offset is added to cableLossDb,
 * so the returned antennas can be dropped into a crossmgr-antenna setup as they are.
 */
export function applyParams(setup: Setup, defs: ParamDef[], x: number[], round = false): Antenna[] {
  const byId = new Map<string, Antenna>(setup.antennas.map((a) => [a.id, { ...a, position: [...a.position] as Vec3, mount: a.mount && { ...a.mount } }]));
  const moved = new Set<string>();
  defs.forEach((d, i) => {
    const a = byId.get(d.antennaId)!;
    const v = x[i];
    switch (d.key) {
      case 'x': a.position[0] = v; a.mount = undefined; break;
      case 'y': a.position[1] = v; a.mount = undefined; break;
      case 'z': a.position[2] = v; a.mount = undefined; break;
      case 'along': a.mount!.alongM = v; moved.add(a.id); break;
      case 'yaw': a.yawDeg = v; moved.add(a.id); break;
      case 'pitch': a.pitchDeg = v; moved.add(a.id); break;
      case 'offset': a.cableLossDb += v; break;
    }
  });
  for (const id of moved) {
    const a = byId.get(id)!;
    if (a.mount) a.position = mountedPosition(setup, a);
  }
  const out = setup.antennas.map((a) => byId.get(a.id)!);
  if (round)
    for (const a of out) {
      a.position = a.position.map(r3) as Vec3;
      a.yawDeg = Math.round(a.yawDeg * 10) / 10;
      a.pitchDeg = Math.round(a.pitchDeg * 10) / 10;
      a.cableLossDb = Math.round(a.cableLossDb * 10) / 10;
      if (a.mount) a.mount.alongM = r3(a.mount.alongM);
    }
  return out;
}
