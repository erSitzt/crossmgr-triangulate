/** One read as delivered by the reader bridge (server/llrp_client.py). */
export interface Read {
  epc: string;
  port: number;
  rssi: number;
  phase?: number | null; // rad, 0..2π
  doppler?: number | null; // Hz
  channel?: number | null;
  ts: number; // µs
  n?: number;
  walk?: number; // mock reader walk playback: sequence number of the walk
}

/** Aggregated reads of one reference tag on one reader port. */
export interface PortStats {
  count: number;
  ratePerS: number;
  medianRssi: number;
  madRssi: number; // median absolute deviation, dB
  /** circular mean phase per channel, with its resultant length (1 = perfectly stable) */
  phase: Record<number, { mean: number; r: number; count: number }>;
}

export interface Capture {
  durationS: number;
  /** epc -> port -> stats (ports without reads are absent) */
  tags: Record<string, Record<number, PortStats>>;
  ports: number[];
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Aggregates a capture of static reference tags. The Impinj phase has a π ambiguity between
 * inventory rounds, so the circular mean is taken over 2θ and halved (result in 0..π).
 */
export function aggregate(reads: Read[], ports?: number[]): Capture {
  if (!reads.length) return { durationS: 0, tags: {}, ports: ports ?? [] };
  let t0 = Infinity, t1 = -Infinity;
  const groups = new Map<string, Read[]>();
  const seenPorts = new Set<number>(ports);
  for (const r of reads) {
    t0 = Math.min(t0, r.ts);
    t1 = Math.max(t1, r.ts);
    seenPorts.add(r.port);
    const k = `${r.epc}|${r.port}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = []));
    g.push(r);
  }
  const durationS = Math.max((t1 - t0) / 1e6, 1e-3);
  const tags: Capture['tags'] = {};
  for (const [k, g] of groups) {
    const [epc, portStr] = k.split('|');
    const rs = g.map((r) => r.rssi);
    const med = median(rs);
    const phase: PortStats['phase'] = {};
    const byCh = new Map<number, number[]>();
    for (const r of g) {
      if (r.phase == null) continue;
      const ch = r.channel ?? 0;
      let l = byCh.get(ch);
      if (!l) byCh.set(ch, (l = []));
      l.push(r.phase);
    }
    for (const [ch, ph] of byCh) {
      let c = 0, s = 0;
      for (const p of ph) {
        c += Math.cos(2 * p);
        s += Math.sin(2 * p);
      }
      const mean2 = Math.atan2(s, c);
      phase[ch] = { mean: ((mean2 + 2 * Math.PI) % (2 * Math.PI)) / 2, r: Math.hypot(c, s) / ph.length, count: ph.length };
    }
    (tags[epc] ??= {})[Number(portStr)] = {
      count: g.length,
      ratePerS: g.length / durationS,
      medianRssi: med,
      madRssi: median(rs.map((x) => Math.abs(x - med))),
      phase,
    };
  }
  return { durationS, tags, ports: [...seenPorts].sort((a, b) => a - b) };
}

/** Parses a recorded session (JSONL: header line + one read per line). */
export function parseSession(text: string): { header: Record<string, unknown> | null; reads: Read[] } {
  let header: Record<string, unknown> | null = null;
  const reads: Read[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.type === 'header') header = o;
    else if (o.epc !== undefined) reads.push(o as Read);
  }
  return { header, reads };
}
