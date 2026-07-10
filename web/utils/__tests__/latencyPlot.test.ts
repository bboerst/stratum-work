import { describe, expect, it } from 'vitest';
import {
  buildLatencyPlot,
  headerLegendStartX,
  latencyColorIntensity,
  latencySampleFromMessage,
  pruneLatencySamples,
} from '../latencyPlot';

const nsHex = (ms: number) => (BigInt(ms) * BigInt(1_000_000)).toString(16);

describe('latencySampleFromMessage', () => {
  it('converts a stratum message with latency into a plot sample', () => {
    const timestamp = nsHex(1_700_000_000_123);
    const sample = latencySampleFromMessage({
      pool_name: 'Pool A',
      timestamp,
      lat_ms: 42.5,
      lat_m: 'tcp',
    });

    expect(sample).toEqual({
      id: `Pool A-${timestamp}-42.5`,
      poolName: 'Pool A',
      timestampMs: 1_700_000_000_123,
      latencyMs: 42.5,
      method: 'tcp',
    });
  });

  it('ignores messages without a finite positive latency estimate', () => {
    expect(latencySampleFromMessage({ pool_name: 'Pool A', timestamp: nsHex(10) })).toBeNull();
    expect(latencySampleFromMessage({ pool_name: 'Pool A', timestamp: nsHex(10), lat_ms: 0 })).toBeNull();
    expect(latencySampleFromMessage({ pool_name: 'Pool A', timestamp: nsHex(10), lat_ms: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('ignores messages with invalid timestamps or pool names', () => {
    expect(latencySampleFromMessage({ pool_name: '', timestamp: nsHex(10), lat_ms: 1 })).toBeNull();
    expect(latencySampleFromMessage({ pool_name: 'Pool A', timestamp: '', lat_ms: 1 })).toBeNull();
    expect(latencySampleFromMessage({ pool_name: 'Pool A', timestamp: 'not a time', lat_ms: 1 })).toBeNull();
  });
});

describe('pruneLatencySamples', () => {
  it('keeps only samples inside the rolling time window', () => {
    const samples = [
      { id: 'old', poolName: 'Pool A', timestampMs: 1_000, latencyMs: 10 },
      { id: 'new', poolName: 'Pool A', timestampMs: 61_000, latencyMs: 20 },
    ];

    expect(pruneLatencySamples(samples, 61_000, 30)).toEqual([samples[1]]);
  });
});

describe('buildLatencyPlot', () => {
  it('sorts pools alphabetically and returns shared time and latency domains', () => {
    const plot = buildLatencyPlot([
      { id: 'a1', poolName: 'Pool A', timestampMs: 1_000, latencyMs: 20 },
      { id: 'b1', poolName: 'Pool B', timestampMs: 3_000, latencyMs: 40 },
      { id: 'a2', poolName: 'Pool A', timestampMs: 2_000, latencyMs: 80 },
    ], {
      timeWindowSeconds: 10,
      newestTimestampMs: 3_000,
    });

    expect(plot.poolNames).toEqual(['Pool A', 'Pool B']);
    expect(plot.timeDomainMs).toEqual([-7_000, 3_000]);
    expect(plot.latencyDomainMs).toEqual([0, 96]);
    expect(plot.maxLatencyMs).toBe(80);
  });

  it('keeps a usable latency domain for empty and flat data', () => {
    const emptyPlot = buildLatencyPlot([], {
      timeWindowSeconds: 10,
      newestTimestampMs: 3_000,
    });
    expect(emptyPlot.latencyDomainMs).toEqual([0, 1]);

    const flatPlot = buildLatencyPlot([
      { id: 'a1', poolName: 'Pool A', timestampMs: 1_000, latencyMs: 0.25 },
    ], {
      timeWindowSeconds: 10,
      newestTimestampMs: 1_000,
    });
    expect(flatPlot.latencyDomainMs).toEqual([0, 1]);
  });

  it('keeps alphabetical ordering regardless of latest sample time', () => {
    const plot = buildLatencyPlot([
      { id: 'b1', poolName: 'Pool B', timestampMs: 3_000, latencyMs: 40 },
      { id: 'a1', poolName: 'Pool A', timestampMs: 1_000, latencyMs: 20 },
    ], {
      timeWindowSeconds: 10,
      newestTimestampMs: 3_000,
    });

    expect(plot.poolNames).toEqual(['Pool A', 'Pool B']);
  });
});

describe('latencyColorIntensity', () => {
  it('maps latency to a clamped 0-1 intensity range', () => {
    expect(latencyColorIntensity(0, 100)).toBe(0);
    expect(latencyColorIntensity(50, 100)).toBe(0.5);
    expect(latencyColorIntensity(150, 100)).toBe(1);
    expect(latencyColorIntensity(20, 0)).toBe(0);
  });
});

describe('headerLegendStartX', () => {
  it('places the legend after the measured stats text plus padding', () => {
    expect(headerLegendStartX([
      { x: 74, width: 50 },
      { x: 166, width: 174 },
    ], 28)).toBe(368);
  });

  it('falls back to the padding when there are no stats items', () => {
    expect(headerLegendStartX([], 28)).toBe(28);
  });
});
