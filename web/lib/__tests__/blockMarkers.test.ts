import { describe, expect, it } from 'vitest';
import { blockMarkers, formatUtcMillis, MAX_HEIGHT_STEP, type MarkerInput } from '../blockMarkers';

const T0 = 1_794_513_910_000;
const PARENT_A = 'aa'.repeat(32);
const PARENT_B = 'bb'.repeat(32);
const PARENT_C = 'cc'.repeat(32);
const OTHER_CHAIN = 'dd'.repeat(32);

const job = (offsetMs: number, height: number, prev_hash: string): MarkerInput => ({
  timestamp: T0 + offsetMs, height, prev_hash,
});

describe('blockMarkers', () => {
  it('marks the first job any feed sends on the new parent, not the baseline', () => {
    const points = [
      job(0, 100, PARENT_A),      // feed 1, baseline
      job(500, 100, PARENT_A),    // feed 2
      job(2_000, 101, PARENT_B),  // feed 2 switches first
      job(2_300, 101, PARENT_B),  // feed 1 follows
    ];
    expect(blockMarkers(points)).toEqual([{ height: 101, timestamp: T0 + 2_000 }]);
  });

  it("ignores a lagging feed's jobs on the old parent", () => {
    const points = [
      job(0, 100, PARENT_A),
      job(1_000, 101, PARENT_B),
      job(1_500, 100, PARENT_A),  // lagging feed, still on the old parent
      job(1_800, 101, PARENT_B),  // lagging feed catches up: parent already seen
      job(9_000, 102, PARENT_C),
    ];
    expect(blockMarkers(points)).toEqual([
      { height: 101, timestamp: T0 + 1_000 },
      { height: 102, timestamp: T0 + 9_000 },
    ]);
  });

  it('marks a height once when a second parent appears at it (competing block)', () => {
    const points = [
      job(0, 100, PARENT_A),
      job(1_000, 101, PARENT_B),
      job(1_200, 101, PARENT_C),
    ];
    expect(blockMarkers(points)).toEqual([{ height: 101, timestamp: T0 + 1_000 }]);
  });

  it("ignores other chains' heights mixed into the feeds", () => {
    const points = [
      job(0, 100, PARENT_A),
      job(500, 6_976_415, OTHER_CHAIN),          // far above: not the next block
      job(800, 100 + MAX_HEIGHT_STEP + 1, OTHER_CHAIN),
      job(2_000, 101, PARENT_B),
    ];
    expect(blockMarkers(points)).toEqual([{ height: 101, timestamp: T0 + 2_000 }]);
  });

  it('with the tip known, ignores another chain arriving first', () => {
    const points = [
      job(0, 6_976_415, OTHER_CHAIN),
      job(100, 6_976_416, 'ee'.repeat(32)),
      job(200, 100, PARENT_A),
      job(2_000, 101, PARENT_B),
    ];
    expect(blockMarkers(points, { tipHeight: 99 })).toEqual([{ height: 101, timestamp: T0 + 2_000 }]);
  });

  it('skips jobs without a prev hash', () => {
    const points = [
      job(0, 100, PARENT_A),
      { timestamp: T0 + 500, height: 101 },
      job(2_000, 101, PARENT_B),
    ];
    expect(blockMarkers(points)).toEqual([{ height: 101, timestamp: T0 + 2_000 }]);
  });

  it('matches prev hashes case-insensitively (stream vs database casing)', () => {
    const points = [
      job(0, 100, PARENT_A),
      job(1_000, 101, PARENT_B),
      job(1_100, 101, PARENT_B.toUpperCase()),
    ];
    expect(blockMarkers(points)).toHaveLength(1);
  });

  it('a complete height marks its first template', () => {
    const points = [job(300, 101, PARENT_B), job(900, 101, PARENT_B)];
    expect(blockMarkers(points, { completeHeight: 101 })).toEqual([{ height: 101, timestamp: T0 + 300 }]);
    expect(blockMarkers([], { completeHeight: 101 })).toEqual([]);
  });

  it('nothing to mark in an empty or single-height input', () => {
    expect(blockMarkers([])).toEqual([]);
    expect(blockMarkers([job(0, 100, PARENT_A), job(5, 100, PARENT_A)])).toEqual([]);
  });
});

describe('formatUtcMillis', () => {
  it('formats in UTC with milliseconds', () => {
    expect(formatUtcMillis(Date.UTC(2026, 10, 19, 3, 4, 5, 67))).toBe('03:04:05.067');
  });
});
