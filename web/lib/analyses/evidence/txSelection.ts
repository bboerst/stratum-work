import type { PoolTimelineEntry } from '@/lib/templates/types';
import { bits } from '../stats';
import { pairKey, type EvidenceChannel, type Observation } from './types';

/** Fraction of positions where both branch lists hold the same hash, over the longer list. */
export function partialScore(a: string[], b: string[]): number {
  const n = Math.max(a.length, b.length);
  if (!n) return 0;
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) m++;
  return m / n;
}

/** Latest entry with receivedAtMs <= t. The cursor only moves forward, so each timeline is walked once. */
function currentAt(entries: readonly PoolTimelineEntry[], t: number, cursor: { i: number }): PoolTimelineEntry | null {
  while (cursor.i + 1 < entries.length && entries[cursor.i + 1].template.receivedAtMs <= t) cursor.i++;
  const e = entries[cursor.i];
  return e && e.template.receivedAtMs <= t ? e : null;
}

export const txSelection: EvidenceChannel = {
  id: 'txSelection',
  observe({ timelines, nowMs }, p) {
    const pools = Array.from(timelines.keys()).sort();
    const firstSeen = new Map<string, number>();
    let start = Infinity;
    timelines.forEach(es => {
      for (const e of es) {
        const t = e.template.receivedAtMs;
        start = Math.min(start, t);
        if (t < (firstSeen.get(e.template.prevHash) ?? Infinity)) firstSeen.set(e.template.prevHash, t);
      }
    });
    const observations: Observation[] = [];
    const creditedPairs = new Set<string>(); // `${pairKey}#${branchKey}`
    const comparableStates = new Map<string, Set<string>>();
    const cursors = new Map(pools.map(pl => [pl, { i: 0 }]));
    if (!Number.isFinite(start)) return { observations, comparable: new Map() };

    for (let t = start; t <= nowMs; t += p.sampleMs) {
      const groups = new Map<string, PoolTimelineEntry[]>();
      for (const pool of pools) {
        const e = currentAt(timelines.get(pool)!, t, cursors.get(pool)!);
        if (!e) continue;
        const tp = e.template;
        if (t - tp.receivedAtMs > p.staleMs || tp.merkleBranches.length < p.minBranches) continue;
        if (t - (firstSeen.get(tp.prevHash) ?? t) < p.postTipSkipMs) continue;
        const g = groups.get(tp.prevHash) ?? [];
        g.push(e);
        groups.set(tp.prevHash, g);
      }
      groups.forEach(g => {
        const n = g.length;
        if (n < 2) return;
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
          const a = g[i].template, b = g[j].template;
          const k = pairKey(a.pool, b.pool);
          const s = comparableStates.get(k) ?? new Set<string>();
          comparableStates.set(k, s);
          s.add(a.pool < b.pool ? `${a.contentKey}|${b.contentKey}` : `${b.contentKey}|${a.contentKey}`);
        }
        const bySet = new Map<string, PoolTimelineEntry[]>();
        for (const e of g) {
          const key = e.template.merkleBranches.join(',');
          const arr = bySet.get(key) ?? [];
          arr.push(e);
          bySet.set(key, arr);
        }
        bySet.forEach((members, key) => {
          const k = members.length;
          if (k < 2) return;
          const names = members.map(m => m.template.pool).sort();
          // Each pool pair is credited at most once per branch set, however the sharing group grows.
          const fresh: [string, string][] = [];
          for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
            const id = `${pairKey(names[i], names[j])}#${key}`;
            if (!creditedPairs.has(id)) { creditedPairs.add(id); fresh.push([names[i], names[j]]); }
          }
          if (!fresh.length) return;
          const detail = { branches: members[0].template.merkleBranches, partial: 1, k, n };
          const b = bits(k, n);
          // All pairs new: one observation over the whole group. Otherwise one per newly sharing pair,
          // so aggregation (which credits every pair inside `pools`) never re-credits an earlier pair.
          if (fresh.length === (k * (k - 1)) / 2) observations.push({ pools: names, bits: b, atMs: t, detail });
          else for (const pr of fresh) observations.push({ pools: pr, bits: b, atMs: t, detail });
        });
      });
    }
    const comparable = new Map<string, number>();
    comparableStates.forEach((s, k) => comparable.set(k, s.size));
    return { observations, comparable };
  },
};
