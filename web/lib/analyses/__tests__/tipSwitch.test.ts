import { describe, expect, it } from 'vitest';
import { runEvidence } from '../evidence/aggregate';
import { fisherBits, tipSwitch, switchTimes } from '../evidence/tipSwitch';
import { DEFAULT_PARAMS, pairKey } from '../evidence/types';
import { entry, timelines } from './evidenceFixtures';

// Direct chi-square survival for even df: P(χ²_{2m} ≥ 2y) = e^{-y} Σ_{k<m} y^k / k!
const fisherDirect = (ps: number[]) => {
  const y = ps.reduce((a, p) => a - Math.log(p), 0);
  let term = 1, sum = 0;
  for (let k = 0; k < ps.length; k++) { if (k > 0) term *= y / k; sum += term; }
  return -Math.log2(Math.exp(-y) * sum);
};
const combined = (r: { observations: { pools: string[]; bits: number; detail: unknown }[] }, a: string, b: string) =>
  r.observations.filter(o => o.pools.join() === [a, b].sort().join() && (o.detail as { combined?: boolean }).combined).reduce((s, o) => s + o.bits, 0);

describe('fisherBits', () => {
  it('matches the direct chi-square survival and is ~0 for p = 1', () => {
    expect(fisherBits([1 / 6, 1 / 6, 1 / 6])).toBeCloseTo(fisherDirect([1 / 6, 1 / 6, 1 / 6]), 9);
    expect(fisherBits([0.5, 0.2, 0.9, 0.01])).toBeCloseTo(fisherDirect([0.5, 0.2, 0.9, 0.01]), 9);
    expect(fisherBits([1, 1, 1])).toBeCloseTo(0, 9);
    expect(fisherBits([])).toBe(0);
  });
  it('stays finite for many strongly coupled events (log-space)', () => {
    const b = fisherBits(Array(500).fill(1e-3));
    expect(Number.isFinite(b)).toBe(true);
    expect(b).toBeGreaterThan(1000);
  });
});

describe('tipSwitch', () => {
  // Every pool starts on P0 so P1..P6 are genuine switches.
  const base = ['A', 'B', 'C', 'D'].map(p => entry(p, 0, { prevHash: 'P0' }));
  const blocks = [1, 2, 3, 4, 5, 6].flatMap(i => [
    entry('A', i * 600_000, { prevHash: `P${i}` }), entry('B', i * 600_000 + 3, { prevHash: `P${i}` }),
    entry('C', i * 600_000 + 400 + i * 37, { prevHash: `P${i}` }), entry('D', i * 600_000 + 900 - i * 51, { prevHash: `P${i}` }),
  ]);
  const tl = timelines(...base, ...blocks);
  it('corrects switch time by latency', () => {
    const t = timelines(entry('A', 0, { prevHash: 'P0' }), entry('A', 1000, { prevHash: 'P1', latencyMs: 40 }));
    expect(switchTimes(t).get('P1')!.get('A')).toBe(960);
  });
  it('tightly coupled pair accrues the most bits; P0 is skipped as partial', () => {
    const r = tipSwitch.observe({ timelines: tl, nowMs: 7 * 600_000 }, DEFAULT_PARAMS);
    expect(combined(r, 'A', 'B')).toBeGreaterThan(combined(r, 'C', 'D'));
    // A–B gap is the smallest of 6 pairs on each of 6 blocks: p = 1/6 six times, combined with Fisher's method.
    expect(combined(r, 'A', 'B')).toBeCloseTo(fisherDirect(Array(6).fill(1 / 6)), 5);
    // Per-tip observations carry detail only; the pair's evidence is the single combined observation.
    expect(r.observations.filter(o => !(o.detail as { combined?: boolean }).combined).every(o => o.bits === 0)).toBe(true);
    expect(r.comparable.get(pairKey('A', 'B'))).toBe(6);
    expect(r.observations.some(o => (o.detail as { prevHash?: string }).prevHash === 'P0')).toBe(false);
  });
  it('uses the earliest arrival across connections', () => {
    const e = entry('A', 1000, { prevHash: 'P1' });
    e.arrivals.push({ connectionId: 'A-eu', site: 'eu', mode: 'observe', receivedAtMs: 900, offsetMs: -100 });
    const t = timelines(entry('A', 0, { prevHash: 'P0' }), e);
    expect(switchTimes(t).get('P1')!.get('A')).toBe(900);
  });
  it('credits each pair once per prevHash, even when a pool revisits the tip or has several entries on it', () => {
    const es = [...base, ...blocks,
      // Extra entries on an already-switched tip (another connection, a reorg return) are not new switches.
      entry('A', 6 * 600_000 + 50, { prevHash: 'P6', connectionId: 'A-eu', merkleBranches: ['q', 'r', 's'] }),
      entry('B', 6 * 600_000 + 60, { prevHash: 'P5' }), entry('B', 6 * 600_000 + 70, { prevHash: 'P6', merkleBranches: ['t', 'u', 'v'] }),
    ];
    const r = tipSwitch.observe({ timelines: timelines(...es), nowMs: 7 * 600_000 }, DEFAULT_PARAMS);
    const perKey = new Map<string, number>();
    for (const o of r.observations.filter(x => !(x.detail as { combined?: boolean }).combined)) {
      const k = `${(o.detail as { prevHash: string }).prevHash}|${pairKey(o.pools[0], o.pools[1])}`;
      perKey.set(k, (perKey.get(k) ?? 0) + 1);
      expect(o.pools).toHaveLength(2);
    }
    expect(Array.from(perKey.values()).every(n => n === 1)).toBe(true);
    expect(r.comparable.get(pairKey('A', 'B'))).toBe(6);
    const { pairs } = runEvidence({ timelines: timelines(...es), nowMs: 7 * 600_000 }, {}, [tipSwitch]);
    expect(pairs.get(pairKey('A', 'B'))!.channels.tipSwitch.bits).toBeCloseTo(fisherDirect(Array(6).fill(1 / 6)), 5);
  });
  it('independent pools do not accumulate evidence: 40 pools × 12 tips yield no pair ≥ 16 bits', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pools = Array.from({ length: 40 }, (_, i) => `P${String(i).padStart(2, '0')}`);
    const es = pools.map(p => entry(p, 0, { prevHash: 'T0' }));
    for (let t = 1; t <= 12; t++) for (const p of pools) es.push(entry(p, t * 600_000 + Math.floor(rnd() * 2000), { prevHash: `T${t}` }));
    const { pairs } = runEvidence({ timelines: timelines(...es), nowMs: 13 * 600_000 }, {}, [tipSwitch]);
    const all = Array.from(pairs.values()).map(pe => pe.channels.tipSwitch.bits);
    expect(all).toHaveLength(780);
    expect(Math.max(...all)).toBeLessThan(16);
    expect(all.reduce((a, b) => a + b, 0) / all.length).toBeLessThan(2); // calibrated: ~1/ln2·E[-ln S] ≈ 1.44 bits, not 12 × 1.44
  });
});
