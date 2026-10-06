import type { PoolTimelineEntry } from '@/lib/templates/types';
import { pairKey, type EvidenceChannel, type Observation } from './types';

/**
 * prevHash → pool → switch time. A pool's switch time is the earliest arrival of its first entry on that prevHash,
 * corrected by the template's latency. Each pool contributes at most one switch per prevHash; its very first entry in
 * the window is excluded because the moment it switched is unknown.
 */
export function switchTimes(timelines: ReadonlyMap<string, readonly PoolTimelineEntry[]>) {
  const out = new Map<string, Map<string, number>>();
  timelines.forEach((es, pool) => {
    const seen = new Set<string>();
    es.forEach((e, idx) => {
      const ph = e.template.prevHash;
      if (seen.has(ph)) return;
      seen.add(ph);
      if (idx === 0) return;
      const first = Math.min(...e.arrivals.map(a => a.receivedAtMs));
      const s = first - (e.template.latencyMs ?? 0);
      const m = out.get(ph) ?? new Map<string, number>();
      out.set(ph, m);
      m.set(pool, s);
    });
  });
  return out;
}

/**
 * Fisher's method: per-event p-values p_i combine to X = −2 Σ ln p_i ~ χ²(2m) under independence; returns −log₂ of its
 * survival P(χ²_{2m} ≥ X) = e^{−y} Σ_{k<m} y^k/k! with y = X/2, computed in log space. ≈0 in expectation when pools are
 * unrelated, however many events are observed; large only when a pair is consistently closer than chance.
 */
export function fisherBits(ps: readonly number[]): number {
  const m = ps.length;
  if (!m) return 0;
  const y = ps.reduce((a, p) => a - Math.log(Math.min(1, Math.max(p, Number.MIN_VALUE))), 0);
  if (y <= 0) return 0;
  const lnY = Math.log(y);
  let lnTerm = 0, lnMax = 0;
  const lnTerms: number[] = [0];
  for (let k = 1; k < m; k++) { lnTerm += lnY - Math.log(k); lnTerms.push(lnTerm); if (lnTerm > lnMax) lnMax = lnTerm; }
  const lnSum = lnMax + Math.log(lnTerms.reduce((a, t) => a + Math.exp(t - lnMax), 0));
  const lnSurvival = Math.min(0, -y + lnSum);
  return -lnSurvival / Math.LN2;
}

export const tipSwitch: EvidenceChannel = {
  id: 'tipSwitch',
  observe({ timelines }) {
    const observations: Observation[] = [];
    const comparable = new Map<string, number>();
    // Per pair: rank p-value on each new tip. Summing per-tip −log₂(p) would grow ~1.44 bits/tip even for unrelated
    // pools, so each tip is kept as a 0-bit observation (for detail) and the pair's evidence is one Fisher combination.
    const perPair = new Map<string, { a: string; b: string; ps: number[]; lastMs: number }>();
    switchTimes(timelines).forEach((m, prevHash) => {
      const ps = Array.from(m.keys()).sort();
      if (ps.length < 3) return;
      const gaps: { a: string; b: string; g: number }[] = [];
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        gaps.push({ a: ps[i], b: ps[j], g: Math.abs(m.get(ps[i])! - m.get(ps[j])!) });
      }
      const sorted = gaps.map(x => x.g).sort((x, y) => x - y);
      for (const { a, b, g } of gaps) {
        let c = 0;
        while (c < sorted.length && sorted[c] <= g) c++;
        const atMs = Math.min(m.get(a)!, m.get(b)!);
        const p = c / sorted.length;
        observations.push({ pools: [a, b], bits: 0, atMs, detail: { prevHash, gapMs: g, p } });
        const k = pairKey(a, b);
        comparable.set(k, (comparable.get(k) ?? 0) + 1);
        const rec = perPair.get(k) ?? { a, b, ps: [], lastMs: atMs };
        rec.ps.push(p);
        rec.lastMs = Math.max(rec.lastMs, atMs);
        perPair.set(k, rec);
      }
    });
    perPair.forEach(({ a, b, ps, lastMs }) => {
      observations.push({ pools: [a, b], bits: fisherBits(ps), atMs: lastMs, detail: { combined: true, events: ps.length } });
    });
    return { observations, comparable };
  },
};
