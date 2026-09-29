import type { Antenna, Setup } from '@antenna/model/types';
import { buildLinkCtx, evalLink, type AntennaCtx, type LinkCtx, type LinkResult } from '@antenna/rf/link';
import { rotYXZ } from '@antenna/rf/math';
import type { Survey } from '../survey/types';

/**
 * Forward model for static reference tags: crossmgr-antenna's link model (antenna pattern, tag
 * dipole, ground reflection, obstacles) evaluated for the surveyed tag positions. The scene part
 * (track height map, obstacles) is built once; antennas are swapped per evaluation.
 */
export interface RefModel {
  ctx: LinkCtx;
  setup: Setup;
  survey: Survey;
  antennaCtx(a: Antenna): AntennaCtx;
  link(a: AntennaCtx, tagIndex: number): LinkResult;
}

export function makeRefModel(setup: Setup, survey: Survey): RefModel {
  const ctx = buildLinkCtx({ ...setup, tag: survey.tag });
  const profile = (a: Antenna) => setup.antennaProfiles.find((p) => p.id === a.profileId) ?? setup.antennaProfiles[0];
  return {
    ctx,
    setup,
    survey,
    antennaCtx: (a) => ({ antenna: a, profile: profile(a), rot: rotYXZ(a.yawDeg, a.pitchDeg, a.rollDeg), pos: a.position }),
    link: (a, i) => {
      const t = survey.tags[i];
      return evalLink(ctx, a, t.pos, t.axis, survey.tag);
    },
  };
}
