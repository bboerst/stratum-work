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

/** The POOL_BLACKLIST names, for reads that exclude them in SQL (e.g. /api/unknown-parents, which hides them entirely). */
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
 * POOL_BLACKLIST hides pools from the realtime view only; their history stays available to downstream analysis
 * (first-seen, forks). Templates for a height above the chain tip are the work being handed out right now, i.e. the
 * realtime view under another URL, so they are filtered there. An unknown tip filters too (fail closed).
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
