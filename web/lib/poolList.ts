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
