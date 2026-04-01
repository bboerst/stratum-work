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

export function filterBlacklistedItems<T>(
  items: T[],
  getPoolName: (item: T) => string | undefined | null
): T[] {
  if (blacklistedPools.size === 0) return items;
  return items.filter(item => !isPoolBlacklisted(getPoolName(item)));
}
