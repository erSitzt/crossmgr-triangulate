import type { TagProfile, Vec3 } from '@antenna/model/types';

/**
 * A reference tag on a non-metallic stake at a surveyed position, in the crossmgr-antenna frame:
 * metres, origin = finish-line centre on the ground, +X travel, +Z rider's right, +Y up.
 */
export interface RefTag {
  epc: string;
  name: string;
  pos: Vec3;
  /** dipole axis in world coordinates (e.g. [0,1,0] = vertical) */
  axis: Vec3;
  enabled: boolean;
  note?: string;
}

export interface Survey {
  version: 1;
  name: string;
  tags: RefTag[];
  /** tag model used for all reference tags (free-standing, no bike, no metal) */
  tag: TagProfile;
}

/** Free-standing dipole inlay (Dogbone M730-like) on a plastic/wooden stake. */
export const REF_TAG_PROFILE: TagProfile = {
  id: 'ref-dogbone',
  name: 'Reference Dogbone (M730) on stake',
  sensitivityDbm: -22,
  gainDbi: 2,
  heightM: 1,
  axis: 'vertical',
  tiltBackDeg: 0,
  mount: 'other',
  side: 'none',
  shadowDb: 0,
  nearMetal: false,
  metalGapMm: 100,
  bodyLossDb: 0,
  polLossDb: 3,
  backscatterLossDb: 8,
  notes: 'No bike shadow, no body loss, no metal. Edit sensitivity/backscatter if you use another inlay.',
};

/** Grid of stakes: every X × every Z × every height; EPCs REF0001… as placeholders. */
export function gridSurvey(xs: number[], zs: number[], ys: number[], axis: Vec3 = [0, 1, 0]): Survey {
  const tags: RefTag[] = [];
  let n = 0;
  for (const x of xs)
    for (const z of zs)
      for (const y of ys) {
        n++;
        tags.push({ epc: `REF${String(n).padStart(4, '0')}`, name: `x${x} z${z} h${y}`, pos: [x, y, z], axis, enabled: true });
      }
  return { version: 1, name: 'Grid survey', tags, tag: { ...REF_TAG_PROFILE } };
}

/** Default: 3 × 3 stakes across the zone, 2 heights (18 tags; X -2/0/+2, Z -3/0/+3, 0.4/1.2 m). */
export const makeDefaultSurvey = () => gridSurvey([-2, 0, 2], [-3, 0, 3], [0.4, 1.2]);

export function parseSurvey(raw: unknown): Survey {
  const s = raw as Partial<Survey> & { tags?: Partial<RefTag>[] };
  const list = Array.isArray(raw) ? (raw as Partial<RefTag>[]) : s.tags;
  if (!Array.isArray(list)) throw new Error('survey: expected {tags:[…]} or an array of tags');
  const tags = list.map((t, i) => {
    if (!t.epc || !Array.isArray(t.pos) || t.pos.length !== 3) throw new Error(`survey: tag ${i + 1} needs epc and pos [x,y,z]`);
    return {
      epc: String(t.epc).toUpperCase(),
      name: t.name ?? String(t.epc),
      pos: t.pos.map(Number) as Vec3,
      axis: (Array.isArray(t.axis) && t.axis.length === 3 ? t.axis.map(Number) : [0, 1, 0]) as Vec3,
      enabled: t.enabled ?? true,
      note: t.note,
    };
  });
  return {
    version: 1,
    name: (!Array.isArray(raw) && s.name) || 'Survey',
    tags,
    tag: { ...REF_TAG_PROFILE, ...(!Array.isArray(raw) ? s.tag : undefined) },
  };
}
