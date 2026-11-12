// First-seen timing per pool at a block height (HistoricalPoolTiming, /api/block-pool-first-seen).
//
// A pool's first-seen time at height h is the earliest template *we* collected for h. If our collector for that
// pool wasn't connected when height h started (collector restarted, or reconnected mid-height), that is not the
// pool's real first template. We can only trust it when we also have a template from the same pool at h-1:
// that proves the collector was connected before h began. See #104.

export interface FirstSeenRow {
  poolName: string;
  firstSeenTimestamp: string;
  firstSeenLatencyMs?: number | null;
  /** False when we have no template from this pool at height - 1 (collector connected mid-height). */
  reliable?: boolean;
}

export interface PoolTimingRow extends FirstSeenRow {
  reliable: boolean;
  /** Nanoseconds after the earliest *reliable* pool. Can be negative for unreliable rows. */
  relativeTimeNs: number;
}

export interface PoolTiming {
  /** Sorted by relativeTimeNs. The first entry is "First". */
  reliable: PoolTimingRow[];
  /** Pools whose collector connected mid-height, sorted by observed time. */
  unreliable: PoolTimingRow[];
}

/** Mark each first-seen row reliable iff the same pool also has a template at the previous height. */
export function markFirstSeenReliability<T extends { poolName: string }>(
  rows: T[],
  poolsAtPreviousHeight: Iterable<string>,
): (T & { reliable: boolean })[] {
  const previous = new Set(poolsAtPreviousHeight);
  return rows.map(row => ({ ...row, reliable: previous.has(row.poolName) }));
}

/**
 * Parse a timestamp that is either hex-encoded nanoseconds or ISO-8601 into exact epoch nanoseconds (0n if
 * unparseable). BigInt because epoch nanoseconds (~1.8e18) exceed Number's exact range (2^53 ≈ 9e15): as a Number
 * they are only exact to ~256 ns, so differences must be taken before converting back.
 */
export function parseFirstSeenTimestampToNsBigInt(timestamp: string): bigint {
  if (!timestamp) return BigInt(0);
  const trimmed = timestamp.trim();

  // All hex characters: hex-encoded integer nanoseconds (collector format).
  if (/^[0-9a-fA-F]+$/.test(trimmed)) {
    return BigInt(`0x${trimmed}`);
  }

  // ISO 8601 without timezone (e.g. 2024-12-20T12:45:08.871633): treat as UTC, keep fractional seconds to ns.
  const isoMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?/);
  if (isoMatch) {
    const baseMs = Date.parse(`${isoMatch[1]}T${isoMatch[2]}Z`);
    if (!Number.isNaN(baseMs)) {
      const fractionNs = BigInt((isoMatch[3] || '').padEnd(9, '0').slice(0, 9));
      return BigInt(Math.max(0, baseMs)) * BigInt(1_000_000) + fractionNs;
    }
  }

  const parsedMs = Date.parse(trimmed);
  return Number.isNaN(parsedMs) ? BigInt(0) : BigInt(Math.max(0, parsedMs)) * BigInt(1_000_000);
}

/** Number version of {@link parseFirstSeenTimestampToNsBigInt}. Approximate (~256 ns) at today's epoch values. */
export function parseFirstSeenTimestampToNs(timestamp: string): number {
  return Number(parseFirstSeenTimestampToNsBigInt(timestamp));
}

/**
 * Compute relative first-seen times. Only reliable pools can anchor "First": an unreliable pool's observed time is
 * only an upper bound on its real first template, so using it as the baseline would mislead. If no pool is
 * reliable (e.g. the first height after the whole stack started), every row is unreliable and the baseline falls
 * back to the earliest observed time.
 *
 * Rows without a `reliable` field (older API responses) are treated as reliable.
 */
export function computePoolTiming(rows: FirstSeenRow[], latencyAdjusted: boolean): PoolTiming {
  // Exact arithmetic in BigInt; only the (small) relative differences are converted back to Number.
  const withNs = rows.map(row => {
    const rawNs = parseFirstSeenTimestampToNsBigInt(row.firstSeenTimestamp);
    const latencyMs = row.firstSeenLatencyMs;
    const adjust =
      latencyAdjusted && rawNs > BigInt(0) && latencyMs != null && Number.isFinite(latencyMs) && latencyMs > 0;
    const ns = adjust ? rawNs - BigInt(Math.round(latencyMs * 1_000_000)) : rawNs;
    return { row: { ...row, reliable: row.reliable !== false }, ns };
  });

  const candidates = withNs.some(r => r.row.reliable) ? withNs.filter(r => r.row.reliable) : withNs;
  const baseline = candidates.reduce((min, r) => (r.ns < min ? r.ns : min), candidates[0]?.ns ?? BigInt(0));

  const all: PoolTimingRow[] = withNs
    .map(({ row, ns }) => ({ ...row, relativeTimeNs: Number(ns - baseline) }))
    .sort((a, b) => a.relativeTimeNs - b.relativeTimeNs);

  return {
    reliable: all.filter(r => r.reliable),
    unreliable: all.filter(r => !r.reliable),
  };
}
