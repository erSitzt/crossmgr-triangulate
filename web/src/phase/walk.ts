import type { Vec3 } from '@antenna/model/types';
import type { Read } from '../capture/stats';

/**
 * A phase walk: one tag carried along a straight, marked line (from → to) at a steady pace.
 * Protocol: stand still on the start mark for ~3 s, walk to the end mark, stand still ~3 s.
 * The still phases anchor the walk: before the motion starts the tag is at `from`, after it
 * ends at `to`. The speed in between is estimated (shared by all antennas).
 */
export interface Walk {
  id: string;
  label: string;
  epc: string;
  from: Vec3;
  to: Vec3;
  reads: Read[];
}

export type Region = 'etsi' | 'fcc';

/** Channel index → centre frequency (MHz). ETSI: the 4 channels of EN 302 208 in the R420's ETSI region. */
export function channelFreqMHz(channel: number | null | undefined, region: Region, fallbackMHz: number): number {
  if (!channel) return fallbackMHz;
  if (region === 'etsi') return channel >= 1 && channel <= 4 ? 865.7 + 0.6 * (channel - 1) : fallbackMHz;
  return channel >= 1 && channel <= 50 ? 902.75 + 0.5 * (channel - 1) : fallbackMHz;
}

/** One gap-free run of reads on one port and channel: unwrapped round-trip phase as a range (m). */
export interface Segment {
  port: number;
  channel: number;
  lambda: number;
  t: number[]; // s, relative to the walk's first read
  rho: number[]; // unwrapped 2θ · λ / 8π = range change in metres, up to an unknown offset and sign
}

export interface PreparedWalk {
  walk: Walk;
  t0Us: number;
  tStart: number; // s: motion starts (tag leaves `from`)
  tEnd: number; // s: motion ends (tag reaches `to`)
  lengthM: number;
  segments: Segment[];
  readsPerPort: Record<number, number>;
  warnings: string[];
}

export interface PrepareOptions {
  region?: Region;
  fallbackMHz?: number;
  maxGapS?: number; // a longer gap between two reads of a series breaks the unwrapping
  minSegmentReads?: number;
  moveThresholdM?: number; // range change within `moveWindowS` that counts as motion
  moveWindowS?: number;
}

const TWO_PI = 2 * Math.PI;
const wrapPi = (a: number) => a - TWO_PI * Math.round(a / TWO_PI);

/**
 * Splits the walk's reads into per-port/channel segments and unwraps them. Works on 2θ, which
 * removes the π ambiguity of the Impinj phase report; the unambiguous range step is then λ/8
 * (≈ 4 cm) between consecutive reads of one series, so walk slowly (≤ 0.5 m/s) on a fixed channel.
 */
export function prepareWalk(walk: Walk, o: PrepareOptions = {}): PreparedWalk {
  const region = o.region ?? 'etsi';
  const fallback = o.fallbackMHz ?? 866.5;
  const maxGap = o.maxGapS ?? 0.12;
  const minReads = o.minSegmentReads ?? 8;
  const warnings: string[] = [];
  const reads = walk.reads.filter((r) => r.epc === walk.epc && r.phase != null).sort((a, b) => a.ts - b.ts);
  const lengthM = Math.hypot(walk.to[0] - walk.from[0], walk.to[1] - walk.from[1], walk.to[2] - walk.from[2]);
  if (!reads.length) return { walk, t0Us: 0, tStart: 0, tEnd: 0, lengthM, segments: [], readsPerPort: {}, warnings: [`No reads with phase for ${walk.epc}.`] };
  const t0Us = reads[0].ts;

  const series = new Map<string, Read[]>();
  const readsPerPort: Record<number, number> = {};
  for (const r of reads) {
    const k = `${r.port}|${r.channel ?? 0}`;
    let l = series.get(k);
    if (!l) series.set(k, (l = []));
    l.push(r);
    readsPerPort[r.port] = (readsPerPort[r.port] ?? 0) + 1;
  }

  const segments: Segment[] = [];
  for (const list of series.values()) {
    const { port } = list[0];
    const channel = list[0].channel ?? 0;
    const lambda = 299.792458 / channelFreqMHz(channel, region, fallback);
    const k = lambda / (4 * TWO_PI); // 2θ = 8π d / λ  →  d = 2θ · λ / 8π
    let cur: Segment | null = null;
    let prevT = -Infinity, prevPh = 0, acc = 0;
    for (const r of list) {
      const t = (r.ts - t0Us) / 1e6;
      const ph = 2 * r.phase!;
      if (!cur || t - prevT > maxGap) {
        if (cur && cur.t.length >= minReads) segments.push(cur);
        cur = { port, channel, lambda, t: [], rho: [] };
        acc = ph;
      } else acc += wrapPi(ph - prevPh);
      cur.t.push(t);
      cur.rho.push(acc * k);
      prevT = t;
      prevPh = ph;
    }
    if (cur && cur.t.length >= minReads) segments.push(cur);
  }

  // motion = the mean range over one window differs from the mean over the window before it
  // (window means are robust against single noisy reads)
  const win = o.moveWindowS ?? 0.4, thr = o.moveThresholdM ?? 0.01;
  let tStart = Infinity, tEnd = -Infinity;
  for (const s of segments) {
    const n = s.t.length;
    const cs = [0];
    for (let i = 0; i < n; i++) cs.push(cs[i] + s.rho[i]);
    const mean = (a: number, b: number) => (cs[b] - cs[a]) / Math.max(1, b - a);
    let a = 0, b = 0;
    for (let c = 0; c < n; c++) {
      while (s.t[c] - s.t[b] > win) b++; // [b, c] = current window
      while (s.t[b] - s.t[a] > win) a++; // [a, b) = previous window
      if (b - a < 3 || c - b < 3) continue;
      if (Math.abs(mean(b, c + 1) - mean(a, b)) > thr) {
        tStart = Math.min(tStart, s.t[b]);
        tEnd = Math.max(tEnd, s.t[b]);
      }
    }
  }
  const tLast = (reads[reads.length - 1].ts - t0Us) / 1e6;
  if (!Number.isFinite(tStart)) {
    warnings.push('No motion detected – was the tag carried along the line?');
    tStart = 0;
    tEnd = tLast;
  } else {
    if (tStart < 0.5) warnings.push('No still phase at the start mark – assuming the walk starts with the first read.');
    if (tLast - tEnd < 0.5) warnings.push('No still phase at the end mark – assuming the walk ends with the last read.');
  }
  const dur = tEnd - tStart;
  if (dur > 0 && lengthM / dur > 0.8) warnings.push(`Average ${(lengthM / dur).toFixed(2)} m/s – walk slower (≤ 0.5 m/s) so the phase can be unwrapped.`);
  const broken = [...series.values()].length ? segments.length / series.size : 0;
  if (broken > 4) warnings.push(`Phase series break up into ${segments.length} segments – reads too sparse (channel hopping? too fast?).`);
  return { walk, t0Us, tStart, tEnd, lengthM, segments, readsPerPort, warnings };
}
