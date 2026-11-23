import { describe, expect, it } from 'vitest';
import { axisDomain, buildTimeZones, mapTimeToVisual, placeBlockMarkers, type ArrivalBlock } from '../forkTimelineAxis';

const S = 1_000_000_000;             // 1 s in ns
const MS = 1_000_000;                // 1 ms in ns
const T0 = 1_790_000_000_000;        // ms since the epoch
const ns = (ms: number) => ms * MS;
const block = (hash: string, height: number, seen_ms: number | null, best = true, o: Partial<ArrivalBlock> = {}): ArrivalBlock =>
  ({ hash, height, seen_ms, best, miner: null, ...o });

describe('axisDomain', () => {
  it('is the templates span without blocks, or with blocks inside it or without a seen time', () => {
    expect(axisDomain(10, 20, null)).toEqual({ minNs: 10, maxNs: 20 });
    expect(axisDomain(ns(T0), ns(T0 + 60_000), [block('a', 1, T0 + 1000), block('b', 2, null)]))
      .toEqual({ minNs: ns(T0), maxNs: ns(T0 + 60_000) });
  });

  it('widens to arrivals just outside the templates, not to ones far away', () => {
    const blocks = [block('a', 1, T0 - 15_000), block('b', 2, T0 + 70_000), block('c', 2, T0 - 3_600_000, false)];
    expect(axisDomain(ns(T0), ns(T0 + 60_000), blocks)).toEqual({ minNs: ns(T0 - 15_000), maxNs: ns(T0 + 70_000) });
  });
});

describe('placeBlockMarkers', () => {
  it('places arrivals linearly on an uncompressed axis and skips blocks without a seen time', () => {
    const m = placeBlockMarkers([block('a', 100, T0 + 25_000), block('old', 99, null)], null, ns(T0), ns(T0 + 100_000), 5);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ hash: 'a', height: 100, pct: 25, edge: null, row: 0, seenMs: T0 + 25_000 });
  });

  it('puts arrivals outside the axis at its edges', () => {
    const m = placeBlockMarkers([block('late', 101, T0 + 200_000), block('early', 99, T0 - 1)], null, ns(T0), ns(T0 + 100_000), 5);
    expect(m.map(x => [x.hash, x.pct, x.edge])).toEqual([['early', 0, 'before'], ['late', 100, 'after']]);
  });

  it('maps onto a compressed axis: active zones exactly as the bars, a quiet stretch at its compressed position', () => {
    // events at 0 s and 300 s over a 600 s span: active zones around them, quiet stretches between
    const min = ns(T0), max = ns(T0 + 600_000);
    const zones = buildTimeZones([ns(T0 + 300_000)], min, max)!;
    expect(zones.some(z => z.type === 'gap')).toBe(true);
    const inActive = T0 + 301_000, inGap = T0 + 150_000;
    const m = placeBlockMarkers([block('act', 100, inActive), block('gap', 101, inGap, false)], zones, min, max, 0);
    const byHash = new Map(m.map(x => [x.hash, x]));
    expect(byHash.get('act')!.pct).toBeCloseTo(mapTimeToVisual(ns(inActive), zones, min, max - min), 9);
    const gap = zones.find(z => z.type === 'gap' && z.startNs <= ns(inGap) && ns(inGap) <= z.endNs)!;
    const g = byHash.get('gap')!;
    expect(g.pct).toBeGreaterThanOrEqual(gap.visualStartPct);
    expect(g.pct).toBeLessThanOrEqual(gap.visualEndPct);
    expect(g.seenMs).toBe(inGap);          // the label keeps the exact time
    expect(g.edge).toBeNull();
  });

  it('a zero-length axis (one template) puts an arrival at its start, never NaN', () => {
    const m = placeBlockMarkers([block('a', 1, T0)], null, ns(T0), ns(T0), 5);
    expect(m[0].pct).toBe(0);
    expect(Number.isNaN(mapTimeToVisual(ns(T0), null, ns(T0), 0))).toBe(false);
  });

  it('staggers labels of blocks arriving close together (a race), in arrival order', () => {
    const blocks = [
      block('best', 100, T0 + 16_000), block('stale', 100, T0 + 15_000, false, { stale_only: true }), block('next', 101, T0 + 90_000),
    ];
    const m = placeBlockMarkers(blocks, null, ns(T0), ns(T0 + 100_000), 5);
    expect(m.map(x => [x.hash, x.row])).toEqual([['stale', 0], ['best', 1], ['next', 0]]);
    expect(m[0]).toMatchObject({ best: false, staleOnly: true });
  });

  it('alternates rows for a run of close arrivals', () => {
    const m = placeBlockMarkers([1, 2, 3].map(i => block(`b${i}`, 100, T0 + i * 100)), null, ns(T0), ns(T0 + 100 * S / MS), 5);
    expect(m.map(x => x.row)).toEqual([0, 1, 0]);
  });
});
