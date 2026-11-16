/**
 * The sorted pool-name list behind the pool filter (components/PoolFilterContext.tsx). It's rebuilt from the stream
 * on every flush, but the set of pools rarely changes. The filter memoizes the list on a string key of the names, so
 * the array (and with it the filter context's value) stays the same object while the pools do, and its consumers
 * (the table, the charts) don't re-render on every flush.
 */

const SEP = "\u0000";

// The same ordering as a.localeCompare(b, undefined, { sensitivity: "base" }), without building a collator per call.
const collator = new Intl.Collator(undefined, { sensitivity: "base" });

/** Pool names sorted case-insensitively, as the pool filter lists them. */
export function sortPoolNames(names: Iterable<string>): string[] {
  return Array.from(names).sort(collator.compare);
}

/** A string that's equal for equal lists (same names, same order). */
export function poolListKey(names: readonly string[]): string {
  return names.length ? SEP + names.join(SEP) : "";
}

/** The list a poolListKey() came from. */
export function poolListFromKey(key: string): string[] {
  return key ? key.slice(1).split(SEP) : [];
}

/**
 * Every pool name the realtime views can show: live stream messages, the latest message per pool, and the shared
 * template buffer, which the initial load (/api/realtime-prefill) seeds before any live template arrives. Without the
 * buffer the filter stayed empty until the first live template.
 */
export function collectPoolNames(
  streamNames: Iterable<string | null | undefined>,
  latestByPool: Iterable<string>,
  bufferEntries: Iterable<{ data: { pool_name?: string | null } }>,
): string[] {
  const names = new Set<string>();
  for (const n of streamNames) if (n) names.add(n);
  for (const n of latestByPool) if (n) names.add(n);
  for (const e of bufferEntries) if (e.data.pool_name) names.add(e.data.pool_name);
  return sortPoolNames(names);
}
