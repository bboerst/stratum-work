import type { PoolTimelineEntry } from '@/lib/templates/types';

type TL = ReadonlyMap<string, readonly PoolTimelineEntry[]>;

/** Per pool, per new prevHash: ms from the switch to the first template with ≥ 1 branch (0 if immediate, null if never). */
export function emptyBlockWindow(tl: TL): Map<string, { prevHash: string; emptyMs: number | null }[]> {
  const out = new Map<string, { prevHash: string; emptyMs: number | null }[]>();
  tl.forEach((es, pool) => {
    const rows: { prevHash: string; emptyMs: number | null }[] = [];
    for (let i = 1; i < es.length; i++) {
      const ph = es[i].template.prevHash;
      if (es[i - 1].template.prevHash === ph) continue;
      const s = es[i].template.receivedAtMs;
      let emptyMs: number | null = null;
      for (let j = i; j < es.length && es[j].template.prevHash === ph; j++) {
        if (es[j].template.merkleBranches.length > 0) { emptyMs = es[j].template.receivedAtMs - s; break; }
      }
      rows.push({ prevHash: ph, emptyMs });
    }
    out.set(pool, rows);
  });
  return out;
}

/** Per pool: consecutive job gaps, median gap (null if < 3 gaps), and each job's phase within that gap. */
export function jobCadence(tl: TL): Map<string, { intervalsMs: number[]; dominantMs: number | null; phases: number[] }> {
  const out = new Map<string, { intervalsMs: number[]; dominantMs: number | null; phases: number[] }>();
  tl.forEach((es, pool) => {
    const ts = es.map(e => e.template.receivedAtMs);
    const intervalsMs = ts.slice(1).map((t, i) => t - ts[i]);
    const sorted = intervalsMs.slice().sort((a, b) => a - b);
    const dominantMs = sorted.length >= 3 ? sorted[Math.floor(sorted.length / 2)] : null;
    const phases = dominantMs ? ts.map(t => (t % dominantMs) / dominantMs) : [];
    out.set(pool, { intervalsMs, dominantMs, phases });
  });
  return out;
}

/** Latest merge-mining commitments per pool, plus identical latest content held by ≥ 2 pools. */
export function mergeMiningMap(tl: TL): {
  protocols: string[];
  cells: { pool: string; protocol: string; latest: string }[];
  shared: { protocol: string; content: string; pools: string[] }[];
} {
  const cells: { pool: string; protocol: string; latest: string }[] = [];
  const holders = new Map<string, { protocol: string; content: string; pools: string[] }>();
  const pools = Array.from(tl.keys()).sort((a, b) => a.localeCompare(b));
  for (const pool of pools) {
    const es = tl.get(pool)!;
    const last = es[es.length - 1];
    if (!last) continue;
    const mm = last.template.mergeMiningCommitments;
    for (const protocol of Object.keys(mm)) {
      const latest = mm[protocol];
      cells.push({ pool, protocol, latest });
      const k = `${protocol}\u0000${latest}`;
      const h = holders.get(k) ?? { protocol, content: latest, pools: [] };
      h.pools.push(pool);
      holders.set(k, h);
    }
  }
  const protocols = Array.from(new Set(cells.map(c => c.protocol))).sort();
  const shared = Array.from(holders.values())
    .filter(h => h.pools.length >= 2)
    .sort((a, b) => a.protocol.localeCompare(b.protocol) || a.content.localeCompare(b.content));
  return { protocols, cells, shared };
}
