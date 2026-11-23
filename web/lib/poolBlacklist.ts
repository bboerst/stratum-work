const blacklistedPools: Set<string> = new Set(
  (process.env.POOL_BLACKLIST ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
);

export function isPoolBlacklisted(name: string | undefined | null): boolean {
  if (!name) return false;
  return blacklistedPools.has(name);
}

/** The POOL_BLACKLIST names, for reads that exclude them in SQL (with the tip rule: realtimeExclusion, below). */
export function blacklistedPoolNames(): string[] {
  return [...blacklistedPools];
}

export function filterBlacklistedItems<T>(
  items: T[],
  getPoolName: (item: T) => string | undefined | null
): T[] {
  if (blacklistedPools.size === 0) return items;
  return items.filter(item => !isPoolBlacklisted(getPoolName(item)));
}

/**
 * POOL_BLACKLIST hides live streaming only (the stream, the realtime pre-fill, templates above the tip); every analysis
 * view keeps the pool at mined heights (docs/methodology.md, "Pools excluded from the live site"). Templates for a
 * height above the chain tip are the work being handed out right now, i.e. the realtime view under another URL, so
 * they are filtered there. An unknown tip filters too (fail closed).
 */
export function filterBlacklistedAboveTip<T>(
  items: T[],
  height: number,
  tip: number | null | undefined,
  getPoolName: (item: T) => string | undefined | null
): T[] {
  if (blacklistedPools.size === 0) return items;
  if (typeof tip === 'number' && Number.isFinite(tip) && height <= tip) return items;
  return filterBlacklistedItems(items, getPoolName);
}

/**
 * filterBlacklistedAboveTip's rule for reads that filter in SQL (the Forks reads): POOL_BLACKLIST pools are left out
 * of the templates at heights above `tip` (all of them when the tip is unknown); at or below it, their work is history
 * and stays.
 */
export interface RealtimeExclusion {
  pools: string[];
  tip: number | null;            // our best-chain tip; null: unknown (fail closed)
}

export function realtimeExclusion(tip: number | null | undefined): RealtimeExclusion {
  return { pools: blacklistedPoolNames(), tip: typeof tip === 'number' && Number.isFinite(tip) ? tip : null };
}

/** The pools to leave out of a read of templates at `height`. */
export function excludedAt(ex: RealtimeExclusion, height: number): string[] {
  return ex.tip !== null && height <= ex.tip ? [] : ex.pools;
}

/** The pools to leave out of every height (another chain's work: its heights aren't Bitcoin's, so no tip applies). */
export const excludedEverywhere = (ex: RealtimeExclusion): RealtimeExclusion => ({ pools: ex.pools, tip: null });
