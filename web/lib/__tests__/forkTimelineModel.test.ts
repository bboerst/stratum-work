import { describe, expect, it } from 'vitest';
import { forkTimelineModel, formatRelativeTime } from '../../components/ForkTimeline';
import { reverseHex } from '../../utils/formatters';

const S = 1_000_000_000;
const ACTIVE = '00' + 'aa'.repeat(31), STALE = '00' + 'bb'.repeat(31);
const n = (pool: string, sec: number, parent: string, invalid = false) =>
  ({ pool_name: pool, timestamp: (1_800_000_000 * S + sec * S).toString(16), prev_hash: reverseHex(parent), invalid });
const base = { canonicalBlockHash: ACTIVE, prevHashStatus: { [ACTIVE]: 'canonical' as const, [STALE]: 'stale' as const } };

describe('forkTimelineModel (the Forks rows and the height page)', () => {
  it('ends each pool\'s last run where it moved on, not at the last template of anyone', () => {
    const m = forkTimelineModel({ ...base, notifications: [n('A', 0, ACTIVE), n('B', 1, STALE), n('B', 600, STALE)],
      ends: { A: 1_800_000_000 * S + 30 * S } })!;
    const a = m.poolTimelines.find(p => p.poolName === 'A')!;
    const b = m.poolTimelines.find(p => p.poolName === 'B')!;
    const right = (p: typeof a) => p.visualSegments.at(-1)!.leftPct + p.visualSegments.at(-1)!.widthPct;
    expect(right(a)).toBeLessThan(right(b));
  });
  it('without ends, runs last to the last template (the height page, unchanged)', () => {
    const m = forkTimelineModel({ ...base, notifications: [n('A', 0, ACTIVE), n('B', 1, STALE), n('B', 600, STALE)] })!;
    const a = m.poolTimelines.find(p => p.poolName === 'A')!;
    expect(a.visualSegments.at(-1)!.leftPct + a.visualSegments.at(-1)!.widthPct).toBeCloseTo(100, 0);
  });
  it('draws invalid work as its own segment, and counts its start and end on the axis', () => {
    const notes = [n('A', 0, STALE), n('A', 1, STALE, true), n('A', 26, STALE), n('B', 0, ACTIVE), n('B', 600, ACTIVE)];
    const m = forkTimelineModel({ ...base, notifications: notes })!;
    const a = m.poolTimelines.find(p => p.poolName === 'A')!;
    // (a segment crossing a compressed quiet stretch is drawn in two pieces)
    expect(a.visualSegments.map(s => s.invalid).filter((v, i, all) => v !== all[i - 1])).toEqual([false, true, false]);
    // the 25 s of invalid work isn't squeezed into a sliver of the 10 minutes: the quiet stretch is compressed
    expect(m.compressed).toBe(true);
    expect(a.visualSegments.find(s => s.invalid)!.widthPct).toBeGreaterThan(20);
  });
  it('puts a block at our feeds\' first work on it, flagged, when no arrival was recorded (a stale-only block\'s poll time is no arrival)', () => {
    const m = forkTimelineModel({ ...base, notifications: [n('A', 0, ACTIVE), n('B', 1, STALE)],
      blocks: [{ hash: STALE, height: 100, seen_ms: 1_800_000_000_500, best: false, stale_only: true, work_ms: 1_800_000_001_000 },
               { hash: ACTIVE, height: 100, seen_ms: 1_800_000_000_000, best: true, work_ms: 1_800_000_000_000 },
               { hash: 'cc'.repeat(32), height: 101, seen_ms: null, best: true, work_ms: null }] })!;
    expect(m.seenBlocks.map(b => [b.hash, b.seen_ms, b.firstWork])).toEqual([
      [STALE, 1_800_000_001_000, true], [ACTIVE, 1_800_000_000_000, false]]);
  });
  it('never compresses a quiet stretch over a block\'s line', () => {
    const notes = [n('A', 0, ACTIVE), n('B', 1, ACTIVE), n('A', 600, ACTIVE), n('B', 601, ACTIVE)];
    const at = 1_800_000_000_000 + 300_000;
    const m = forkTimelineModel({ ...base, notifications: notes, blocks: [{ hash: STALE, height: 100, seen_ms: at, best: false }] })!;
    const t = at * 1_000_000;
    expect(m.timeZones?.some(z => z.type === 'gap' && z.startNs < t && z.endNs > t) ?? false).toBe(false);
  });
  it('never repeats a tick label', () => {
    const m = forkTimelineModel({ ...base, notifications: [n('A', 0, ACTIVE), n('B', 1, STALE), n('B', 40, ACTIVE), n('A', 77, ACTIVE)] })!;
    const labels = m.ticks.map(t => t.label);
    expect(labels.filter((l, i) => labels[i - 1] === l)).toEqual([]);
  });
  it('labels times in seconds up to two minutes', () => {
    expect([formatRelativeTime(72 * S), formatRelativeTime(77 * S), formatRelativeTime(626 * S), formatRelativeTime(30903 * S)])
      .toEqual(['72s', '77s', '10.4m', '8.6h']);
  });
});
