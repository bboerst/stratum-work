/**
 * Fork visual (ForkTimeline): what each prev hash seen in a height's templates is, relative to the chain as stored
 * now (#212). Derived at read time, so it follows reorgs: the canonical parent is re-read from the best chain on
 * every request.
 *
 *   canonical  the best block at height - 1 (the block the next block built on, as far as the node knows)
 *   stale      a block we know (stored in blocks, or recorded as a stale side block) that isn't that best block
 *   unknown    a hash we have no block for: a tip our node never saw, or not a block at all
 *
 * Hashes are block hashes in display order (lower-case hex), like blocks.block_hash.
 */
import { parentKind, parentPowOk, type ParentKind } from './parentKind';

export type PrevHashStatus = 'canonical' | 'stale' | 'unknown';

/**
 * The Forks timeline's parents also include `previous`: our best block at height - 2, which a pool went back to (work
 * at height - 1). Never a parent at the height, so never judged canonical, stale or unknown, and not hatched.
 */
export type LaneStatus = PrevHashStatus | 'previous';

export function classifyPrevHashes(
  hashes: Iterable<string>,
  canonical: string | null | undefined,
  known: ReadonlySet<string>,
): Record<string, PrevHashStatus> | null {
  if (!canonical) return null; // no stored block at height - 1: nothing to compare with
  const c = canonical.toLowerCase();
  const out: Record<string, PrevHashStatus> = {};
  for (const raw of hashes) {
    const h = raw.toLowerCase();
    out[h] = h === c ? 'canonical' : known.has(h) ? 'stale' : 'unknown';
  }
  return out;
}

/**
 * For each `unknown` parent, the kind lib/parentKind.ts infers (the same rules as the Forks page), from the height's
 * templates: their most common nbits per parent, against the bits of our best blocks at h - 1 and h. A height page with
 * a fork has a best block at h - 1 (otherwise there is no status), so the tip is taken as h - 1: a competitor of it.
 * Bits are 8-digit hex as stored (blocks.bits, templates' nbits).
 */
export function unknownParentKinds(
  status: Record<string, PrevHashStatus> | null,
  templates: Iterable<{ prev_hash: string; nbits: string | number }>,
  height: number,
  bitsPrev: string | null | undefined,
  bitsAt: string | null | undefined,
): Record<string, ParentKind> | null {
  if (!status) return null;
  const unknown = Object.keys(status).filter(h => status[h] === 'unknown');
  if (unknown.length === 0) return null;
  const counts = new Map<string, Map<number, number>>();
  for (const t of templates) {
    const h = String(t.prev_hash).toLowerCase();
    if (status[h] !== 'unknown') continue;
    const nbits = typeof t.nbits === 'number' ? t.nbits : parseInt(String(t.nbits), 16);
    if (!Number.isInteger(nbits)) continue;
    const m = counts.get(h) ?? new Map<number, number>();
    m.set(nbits, (m.get(nbits) ?? 0) + 1);
    counts.set(h, m);
  }
  const bits = (b: string | null | undefined) => (b ? parseInt(b, 16) : null);
  const prev = bits(bitsPrev), at = bits(bitsAt);
  const out: Record<string, ParentKind> = {};
  for (const h of unknown) {
    const m = counts.get(h);
    if (!m) continue;
    const nbits = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    out[h] = parentKind({
      height, tip: height - 1, nbits, bitcoinBitsPrev: prev, bitcoinBitsAt: at,
      powOk: parentPowOk(h, nbits, prev),
    });
  }
  return out;
}

/**
 * The Forks timeline's fact line: of the pools that built on a parent other than our best block at the height, how
 * many then went back to the block before (a `previous` run after their first run on such a parent). Null without our
 * best block among the parents to judge by, or when none went back. Runs: [at, parent index, ...].
 */
export function wentBack(l: {
  parents: readonly { status: LaneStatus | null }[];
  lanes: readonly { runs: readonly (readonly number[])[] }[];
}): { back: number; of: number } | null {
  if (!l.parents.some(p => p.status === 'canonical')) return null;
  const status = (r: readonly number[]) => l.parents[r[1]]?.status ?? null;
  let back = 0, of = 0;
  for (const lane of l.lanes) {
    const first = lane.runs.findIndex(r => status(r) !== 'canonical' && status(r) !== 'previous');
    if (first < 0) continue;
    of++;
    if (lane.runs.slice(first + 1).some(r => status(r) === 'previous')) back++;
  }
  return back > 0 ? { back, of } : null;
}
