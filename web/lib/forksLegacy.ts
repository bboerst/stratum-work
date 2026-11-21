import { loadEpisodes } from "./forksSummary";
import { SHARE_RANGES, shortPathForParent, type ShareRange } from "./forksPath";

const LEGACY_RANGES: Record<string, ShareRange> = { "90d": "6e", "1y": "26e" };   // earlier links' wall-clock values
const PARENT_RE = /^[0-9a-f]{64}$/;

/**
 * The short link an old /forks?parent=<hash>[&range=…] link redirects to, or null (no parent, a malformed one, an
 * episode no summary has, or nothing to read). The link's range is tried first.
 */
export async function legacyParentPath(
  query: Record<string, string | string[] | undefined>, load = loadEpisodes,
): Promise<string | null> {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  const parent = one(query.parent)?.toLowerCase() ?? null;
  if (!parent || !PARENT_RE.test(parent)) return null;
  const asked = one(query.range) ?? "";
  const range = (Object.hasOwn(LEGACY_RANGES, asked) ? LEGACY_RANGES[asked] : asked) as ShareRange;
  return shortPathForParent(parent, load, SHARE_RANGES.includes(range) ? range : null);
}
