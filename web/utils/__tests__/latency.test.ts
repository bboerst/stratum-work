import { describe, expect, it } from 'vitest';
import { adjustHexTimestamp, effectiveTimestamp } from '../latency';

// 1_750_000_000_000_000_000 ns -> hex without 0x prefix (collector format)
const RAW_NS = BigInt('1750000000000000000');
const RAW_HEX = RAW_NS.toString(16);

describe('adjustHexTimestamp', () => {
  it('subtracts latency in milliseconds converted to ns from a hex timestamp', () => {
    const adjusted = adjustHexTimestamp(RAW_HEX, 12.5, true);
    expect(BigInt('0x' + adjusted)).toBe(RAW_NS - BigInt(12_500_000));
  });

  it('preserves a 0x prefix when present', () => {
    const adjusted = adjustHexTimestamp('0x' + RAW_HEX, 1, true);
    expect(adjusted.startsWith('0x')).toBe(true);
    expect(BigInt(adjusted)).toBe(RAW_NS - BigInt(1_000_000));
  });

  it('returns the raw value when disabled', () => {
    expect(adjustHexTimestamp(RAW_HEX, 12.5, false)).toBe(RAW_HEX);
  });

  it('returns the raw value when latency is missing, null, non-finite, or <= 0', () => {
    expect(adjustHexTimestamp(RAW_HEX, undefined, true)).toBe(RAW_HEX);
    expect(adjustHexTimestamp(RAW_HEX, null, true)).toBe(RAW_HEX);
    expect(adjustHexTimestamp(RAW_HEX, NaN, true)).toBe(RAW_HEX);
    expect(adjustHexTimestamp(RAW_HEX, -5, true)).toBe(RAW_HEX);
  });

  it('leaves non-hex (legacy ISO) timestamps untouched', () => {
    const iso = '2024-12-10T01:30:46.002175';
    expect(adjustHexTimestamp(iso, 10, true)).toBe(iso);
  });

  it('leaves empty/undefined-ish input untouched', () => {
    expect(adjustHexTimestamp('', 10, true)).toBe('');
  });

  it('returns the raw value when adjustment would go non-positive', () => {
    // tiny timestamp (255 ns) minus 1 ms would be negative
    expect(adjustHexTimestamp('ff', 1, true)).toBe('ff');
  });

  it('sub-millisecond latencies still adjust (rounded to nearest ns)', () => {
    const adjusted = adjustHexTimestamp(RAW_HEX, 0.0005, true);
    expect(BigInt('0x' + adjusted)).toBe(RAW_NS - BigInt(500));
  });
});

describe('effectiveTimestamp', () => {
  it('reads timestamp and shortened lat_ms from a data object', () => {
    const adjusted = effectiveTimestamp({ timestamp: RAW_HEX, lat_ms: 2 }, true);
    expect(BigInt('0x' + adjusted)).toBe(RAW_NS - BigInt(2_000_000));
  });

  it('ignores legacy latency_ms now that no data has been collected with it', () => {
    const adjusted = effectiveTimestamp({ timestamp: RAW_HEX, latency_ms: 3 } as { timestamp: string; lat_ms?: number }, true);
    expect(adjusted).toBe(RAW_HEX);
  });

  it('falls back silently without latency fields', () => {
    expect(effectiveTimestamp({ timestamp: RAW_HEX }, true)).toBe(RAW_HEX);
  });
});
