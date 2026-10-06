import { bits } from '../stats';
import { pairKey, type EvidenceChannel, type Observation } from './types';

interface Commit { key: string; protocol: string; content: string; pool: string; t: number }

export const payoutsMergeMining: EvidenceChannel = {
  id: 'payoutsMergeMining',
  observe({ timelines }, p) {
    const pools = Array.from(timelines.keys()).filter(k => (timelines.get(k) ?? []).length > 0).sort();
    const n = pools.length;
    const observations: Observation[] = [];
    const events: Set<string>[] = [];

    // Payouts: one event per distinct address, however many templates repeat it.
    const holders = new Map<string, Set<string>>();
    timelines.forEach((es, pool) => {
      for (const e of es) for (const a of e.template.payoutAddresses) {
        const s = holders.get(a) ?? new Set<string>();
        holders.set(a, s);
        s.add(pool);
      }
    });
    holders.forEach((s, address) => {
      events.push(s);
      if (s.size >= 2) observations.push({ pools: Array.from(s).sort(), bits: bits(s.size, n), atMs: 0, detail: { kind: 'address', address } });
    });

    // Commitments: one event per change of a pool's commitment, clustered across pools within mergeWindowMs.
    const cm: Commit[] = [];
    timelines.forEach((es, pool) => {
      // Only a commitment's first appearance for this pool is an event: connections that lag and interleave old and
      // new content (A: r1, A-eu: r0, A: r1) would otherwise re-emit r1 and credit the same pair twice.
      const seen = new Set<string>();
      for (const e of es) {
        const cur = e.template.mergeMiningCommitments;
        Object.keys(cur).forEach(protocol => {
          const content = cur[protocol], key = `${protocol}:${content}`;
          if (seen.has(key)) return;
          seen.add(key);
          cm.push({ key, protocol, content, pool, t: e.template.receivedAtMs });
        });
      }
    });
    cm.sort((a, b) => a.t - b.t);
    const byKey = new Map<string, Commit[]>();
    for (const c of cm) {
      const arr = byKey.get(c.key) ?? [];
      arr.push(c);
      byKey.set(c.key, arr);
    }
    byKey.forEach(list => {
      let i = 0;
      while (i < list.length) {
        const t0 = list[i].t, s = new Set<string>();
        let j = i;
        while (j < list.length && list[j].t - t0 <= p.mergeWindowMs) { s.add(list[j].pool); j++; }
        events.push(s);
        if (s.size >= 2) {
          observations.push({ pools: Array.from(s).sort(), bits: bits(s.size, n), atMs: t0, detail: { kind: 'commitment', protocol: list[i].protocol, content: list[i].content } });
        }
        i = j;
      }
    });

    const comparable = new Map<string, number>();
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      const c = events.filter(s => s.has(pools[a]) || s.has(pools[b])).length;
      if (c) comparable.set(pairKey(pools[a], pools[b]), c);
    }
    return { observations, comparable };
  },
};
