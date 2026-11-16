import { describe, expect, it } from 'vitest';
import { classifyPrevHashes } from '../forkStatus';
import { prevHashStatusOf } from '../../components/ForkTimeline';
import { reverseHex } from '../../utils/formatters';

const A = '00000000000000000001' + 'a'.repeat(44); // canonical parent
const B = '00000000000000000001' + 'b'.repeat(44); // a known non-best block (stale)
const C = '00000000000000000001' + 'c'.repeat(44); // a hash we have no block for

describe('classifyPrevHashes (#212)', () => {
  it('labels canonical, stale (a block we know) and unknown', () => {
    expect(classifyPrevHashes([A, B, C], A, new Set([A, B]))).toEqual({ [A]: 'canonical', [B]: 'stale', [C]: 'unknown' });
  });

  it('is case-insensitive', () => {
    expect(classifyPrevHashes([B.toUpperCase()], A.toUpperCase(), new Set([B]))).toEqual({ [B]: 'stale' });
  });

  it('returns null without a stored parent to compare with', () => {
    expect(classifyPrevHashes([A, B], null, new Set([A, B]))).toBeNull();
  });

  it('follows a reorg: the same hashes swap when the best parent changes', () => {
    const known = new Set([A, B]);
    expect(classifyPrevHashes([A, B], A, known)).toEqual({ [A]: 'canonical', [B]: 'stale' });
    expect(classifyPrevHashes([A, B], B, known)).toEqual({ [A]: 'stale', [B]: 'canonical' });
  });
});

describe('prevHashStatusOf (ForkTimeline)', () => {
  // The timeline works in template order: reverseHex of the block hash.
  const rawA = reverseHex(A), rawB = reverseHex(B), rawC = reverseHex(C);
  const server = { [A]: 'canonical', [B]: 'stale', [C]: 'unknown' } as const;

  it('uses the server statuses', () => {
    expect(prevHashStatusOf(rawA, rawA, server)).toBe('canonical');
    expect(prevHashStatusOf(rawB, rawA, server)).toBe('stale');
    expect(prevHashStatusOf(rawC, rawA, server)).toBe('unknown');
  });

  it('never calls a non-canonical parent stale without the server saying so', () => {
    expect(prevHashStatusOf(rawB, rawA, null)).toBe('unknown');
    expect(prevHashStatusOf(rawB, rawA, {})).toBe('unknown');
  });

  it('has no status without a canonical parent', () => {
    expect(prevHashStatusOf(rawB, null, server)).toBeNull();
  });
});
