import { describe, expect, it } from 'vitest';
import { computePoolTiming, markFirstSeenReliability, parseFirstSeenTimestampToNs } from '../poolTiming';

// Epoch nanoseconds exceed Number's exact range, so build test timestamps with BigInt (ES2017 target: no `n` literals).
const T0 = BigInt('1794437000000000000');
const hexNs = (offsetNs: number) => (T0 + BigInt(offsetNs)).toString(16).padStart(16, '0');

describe('markFirstSeenReliability', () => {
  it('is reliable only for pools that also have a template at the previous height', () => {
    const rows = [{ poolName: 'A' }, { poolName: 'B' }, { poolName: 'C' }];
    expect(markFirstSeenReliability(rows, ['A', 'C', 'Z']).map(r => [r.poolName, r.reliable])).toEqual([
      ['A', true],
      ['B', false],
      ['C', true],
    ]);
  });

  it('treats every pool as unreliable when nothing was seen at the previous height', () => {
    expect(markFirstSeenReliability([{ poolName: 'A' }], []).every(r => !r.reliable)).toBe(true);
  });
});

describe('computePoolTiming', () => {
  it('anchors "First" on the earliest reliable pool, not an earlier unreliable one', () => {
    const timing = computePoolTiming(
      [
        { poolName: 'late-reliable', firstSeenTimestamp: hexNs(2_000_000_000), reliable: true },
        { poolName: 'early-unreliable', firstSeenTimestamp: hexNs(0), reliable: false },
        { poolName: 'first-reliable', firstSeenTimestamp: hexNs(500_000_000), reliable: true },
      ],
      false,
    );
    expect(timing.reliable.map(r => [r.poolName, r.relativeTimeNs])).toEqual([
      ['first-reliable', 0],
      ['late-reliable', 1_500_000_000],
    ]);
    expect(timing.unreliable.map(r => [r.poolName, r.relativeTimeNs])).toEqual([['early-unreliable', -500_000_000]]);
  });

  it('falls back to the earliest observed time when no pool is reliable', () => {
    const timing = computePoolTiming(
      [
        { poolName: 'B', firstSeenTimestamp: hexNs(1_000_000), reliable: false },
        { poolName: 'A', firstSeenTimestamp: hexNs(0), reliable: false },
      ],
      false,
    );
    expect(timing.reliable).toEqual([]);
    expect(timing.unreliable.map(r => [r.poolName, r.relativeTimeNs])).toEqual([
      ['A', 0],
      ['B', 1_000_000],
    ]);
  });

  it('treats rows without a reliable field (older API responses) as reliable', () => {
    const timing = computePoolTiming([{ poolName: 'A', firstSeenTimestamp: hexNs(0) }], false);
    expect(timing.reliable.map(r => r.poolName)).toEqual(['A']);
    expect(timing.unreliable).toEqual([]);
  });

  it('subtracts latency only when latency adjustment is on', () => {
    const rows = [
      { poolName: 'A', firstSeenTimestamp: hexNs(0), firstSeenLatencyMs: 0, reliable: true },
      { poolName: 'B', firstSeenTimestamp: hexNs(100_000_000), firstSeenLatencyMs: 80, reliable: true },
    ];
    expect(computePoolTiming(rows, false).reliable.find(r => r.poolName === 'B')?.relativeTimeNs).toBe(100_000_000);
    expect(computePoolTiming(rows, true).reliable.find(r => r.poolName === 'B')?.relativeTimeNs).toBe(20_000_000);
  });
});

describe('parseFirstSeenTimestampToNs', () => {
  it('parses hex nanoseconds and ISO-8601 (as UTC)', () => {
    expect(parseFirstSeenTimestampToNs('00000000000003e8')).toBe(1000);
    expect(parseFirstSeenTimestampToNs('2024-12-20T12:45:08.871633')).toBe(
      Date.parse('2024-12-20T12:45:08Z') * 1_000_000 + 871_633_000,
    );
    expect(parseFirstSeenTimestampToNs('')).toBe(0);
  });
});

describe('precision', () => {
  it('keeps nanosecond differences exact at real epoch values (beyond 2^53)', () => {
    const timing = computePoolTiming(
      [
        { poolName: 'A', firstSeenTimestamp: hexNs(0), reliable: true },
        { poolName: 'B', firstSeenTimestamp: hexNs(1), reliable: true },
      ],
      false,
    );
    expect(timing.reliable.map(r => r.relativeTimeNs)).toEqual([0, 1]);
  });
});
