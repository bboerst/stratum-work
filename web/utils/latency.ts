/**
 * Latency-adjusted timestamp helpers.
 *
 * The collector stamps each message at socket-receive time (hex-encoded
 * nanoseconds) and, when it has an estimate, attaches `lat_ms` — the
 * estimated one-way pool->collector transmission time (RTT/2). Subtracting
 * it approximates when the pool actually sent the message. Messages without
 * an estimate (old data, brand-new connections) render raw, silently.
 */

const HEX_TIMESTAMP_RE = /^(0[xX])?[0-9a-fA-F]+$/;

/**
 * Subtract `latencyMs` from a hex-nanosecond timestamp string.
 * Returns the input unchanged when adjustment is disabled, latency is
 * absent/invalid, or the timestamp is not the collector hex format.
 */
export function adjustHexTimestamp(
  timestamp: string,
  latencyMs: number | null | undefined,
  enabled: boolean
): string {
  if (!enabled || latencyMs == null || !Number.isFinite(latencyMs) || latencyMs <= 0) {
    return timestamp;
  }
  if (!timestamp || !HEX_TIMESTAMP_RE.test(timestamp)) {
    return timestamp;
  }
  try {
    const hasPrefix = timestamp.startsWith('0x') || timestamp.startsWith('0X');
    const ns = BigInt('0x' + (hasPrefix ? timestamp.slice(2) : timestamp));
    const adjusted = ns - BigInt(Math.round(latencyMs * 1e6));
    if (adjusted <= BigInt(0)) return timestamp;
    const hex = adjusted.toString(16);
    return hasPrefix ? '0x' + hex : hex;
  } catch {
    return timestamp;
  }
}

type LatencyTimestampData = {
  timestamp: string;
  lat_ms?: number | null;
};

export function latencyMs(data: { lat_ms?: number | null }): number | null | undefined {
  return data.lat_ms;
}

/** Convenience wrapper for objects shaped like StratumV1Data. */
export function effectiveTimestamp(
  data: LatencyTimestampData,
  enabled: boolean
): string {
  return adjustHexTimestamp(data.timestamp, latencyMs(data), enabled);
}
