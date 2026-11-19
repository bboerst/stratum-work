/**
 * Unknown parents (/unknown-parents): what a parent hash that matches no block we know most likely is, INFERRED at
 * read time from stored facts. Pure functions, unit-tested in lib/__tests__/parentKind.test.ts. Nothing here is stored:
 * the kind is a judgement, and the page shows it as "inferred" next to the facts it rests on.
 *
 * The facts, per episode (one unknown parent; lib/db/unknown-parents.ts):
 *  - height h          the height its templates build (the most common one when they disagree), so the parent is at h - 1
 *  - tip               our highest stored Bitcoin block (best chain) that had arrived by the episode's first template
 *  - offset            h - 1 - tip: 0 = a competitor of our tip, 1 = a block above it, far off = not Bitcoin's height
 *  - nbits             the templates' nbits (the most common one)
 *  - bitcoin bits      bits of our best block at h - 1 (and at h, for a retarget height); null when none is stored
 *  - pow_ok            the parent hash, as a 256-bit integer, is <= the target from the Bitcoin bits at h - 1 (or from
 *                      the templates' nbits when no Bitcoin block is stored there)
 *
 * The rules (parentKind):
 *  1. Bitcoin's difficulty? The templates' nbits equal Bitcoin's bits at h - 1 (at a retarget height, h % 2016 == 0,
 *     the bits at h: the template's target is the new period's). Unknown when no Bitcoin block is stored there.
 *  2. Not Bitcoin's difficulty -> 'other_chain'. Also when it's unknown and the height isn't within 1 of our tip: the
 *     parent is above our chain, or below anything we store, with nothing that ties it to Bitcoin.
 *  3. Otherwise (Bitcoin's difficulty, or unknown difficulty right at our tip): pow_ok -> 'bitcoin_block' (a real block
 *     we never recorded: work at Bitcoin's target can't be faked), else 'invalid_parent' (not a valid block at all).
 *  4. No tip and no Bitcoin bits (an empty blocks table): 'undetermined'.
 * The nbits check comes before the PoW check on purpose: another chain's block at a lower difficulty fails Bitcoin's
 * target, and would otherwise read as an invalid Bitcoin parent.
 */

export type ParentKind = 'bitcoin_block' | 'other_chain' | 'invalid_parent' | 'undetermined';

export const PARENT_KINDS: readonly ParentKind[] = ['bitcoin_block', 'other_chain', 'invalid_parent', 'undetermined'];

/** The height window around our tip that still counts as "at the tip" (a block race, or a block just above it). */
export const NEAR_TIP = 1;
export const RETARGET_INTERVAL = 2016;

/**
 * The target a compact "bits" value encodes (Bitcoin's SetCompact): mantissa * 256^(exponent - 3). A negative or
 * overflowing encoding (sign bit set, or beyond 256 bits) has no valid target: null, so nothing meets it.
 */
export function targetFromBits(bits: number | bigint | string): bigint | null {
  const n = typeof bits === 'string' ? Number(bits) : Number(bits);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) return null;
  const exponent = n >>> 24;
  const mantissa = n & 0x007fffff;
  if ((n & 0x00800000) !== 0 && mantissa !== 0) return null;     // negative
  if (mantissa === 0) return BigInt(0);
  const target = exponent <= 3
    ? BigInt(mantissa >>> (8 * (3 - exponent)))
    : BigInt(mantissa) << BigInt(8 * (exponent - 3));
  return target >> BigInt(256) === BigInt(0) ? target : null;   // overflow
}

/** Whether a block hash (display order: the big-endian hex Bitcoin shows) meets the target of `bits`. */
export function meetsPow(blockHashHex: string, bits: number | bigint | string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(blockHashHex)) return false;
  const target = targetFromBits(bits);
  return target !== null && BigInt(`0x${blockHashHex}`) <= target;
}

export interface ParentFacts {
  height: number;                 // h: the templates' height (the parent is at h - 1)
  tip: number | null;             // our best-chain tip when the first template arrived (null: no block stored by then)
  nbits: number;                  // the templates' nbits
  bitcoinBitsPrev: number | null; // bits of our best block at h - 1
  bitcoinBitsAt: number | null;   // bits of our best block at h (only consulted at a retarget height)
  powOk: boolean;
}

/** h - 1 - tip, or null without a tip. */
export function tipOffset(height: number, tip: number | null): number | null {
  return tip === null ? null : height - 1 - tip;
}

/**
 * Whether the templates' nbits are Bitcoin's at that height: true / false, or null when we store no Bitcoin block to
 * compare with (at a retarget height, the block at h).
 */
export function bitcoinDifficulty(f: Pick<ParentFacts, 'height' | 'nbits' | 'bitcoinBitsPrev' | 'bitcoinBitsAt'>): boolean | null {
  const reference = f.height % RETARGET_INTERVAL === 0 ? f.bitcoinBitsAt : f.bitcoinBitsPrev;
  return reference === null ? null : reference === f.nbits;
}

/** The inferred kind (rules in the module comment). */
export function parentKind(f: ParentFacts): ParentKind {
  const difficulty = bitcoinDifficulty(f);
  const offset = tipOffset(f.height, f.tip);
  if (difficulty === false) return 'other_chain';
  if (difficulty === null) {
    if (offset === null) return 'undetermined';
    if (Math.abs(offset) > NEAR_TIP) return 'other_chain';
  }
  return f.powOk ? 'bitcoin_block' : 'invalid_parent';
}

/** The PoW fact: the parent against Bitcoin's bits at h - 1, or against the templates' own nbits without them. */
export function parentPowOk(parentHex: string, nbits: number, bitcoinBitsPrev: number | null): boolean {
  return meetsPow(parentHex, bitcoinBitsPrev ?? nbits);
}

/** Connection label of a pool's k-th source (1-based, in (site, replica) order): 'a', 'b', … 'z', then 'c27', …. */
export function connectionLabel(rank: number): string {
  return rank >= 1 && rank <= 26 ? String.fromCharCode(96 + rank) : `c${rank}`;
}
