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
export type PrevHashStatus = 'canonical' | 'stale' | 'unknown';

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
