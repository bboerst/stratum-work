import { describe, expect, it } from 'vitest';
import { classifyPrevHashes, unknownParentKinds, wentBack } from '../forkStatus';
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

describe('unknownParentKinds', () => {
  const BITS = '17023a04';                        // Bitcoin's bits at h - 1 and h
  const POW = '0000000000000000000' + '1'.repeat(45); // meets that target
  const NOPOW = 'f'.repeat(64);
  const t = (prev_hash: string, nbits: string) => ({ prev_hash, nbits });

  it('infers each unknown parent from its templates\' most common nbits; known ones are left out', () => {
    const status = { [A]: 'canonical', [POW]: 'unknown', [NOPOW]: 'unknown', [C]: 'unknown' } as const;
    const templates = [
      t(A, BITS), t(POW, BITS), t(POW, BITS), t(POW, '1d00ffff'),
      t(NOPOW, BITS),
      t(C, '1a0fffff'),
    ];
    expect(unknownParentKinds(status, templates, 900_001, BITS, BITS)).toEqual({
      [POW]: 'bitcoin_block', [NOPOW]: 'invalid_parent', [C]: 'other_chain',
    });
  });

  it('matches hashes case-insensitively and reads numeric nbits', () => {
    const status = { [POW]: 'unknown' } as const;
    expect(unknownParentKinds(status, [{ prev_hash: POW.toUpperCase(), nbits: 0x17023a04 }], 900_001, BITS, BITS))
      .toEqual({ [POW]: 'bitcoin_block' });
  });

  it('null without a status or without unknown parents', () => {
    expect(unknownParentKinds(null, [t(C, BITS)], 900_001, BITS, BITS)).toBeNull();
    expect(unknownParentKinds({ [A]: 'canonical', [B]: 'stale' }, [t(A, BITS)], 900_001, BITS, BITS)).toBeNull();
  });
});

describe('wentBack (the Forks row\'s fact line)', () => {
  // parents: 0 our best block, 1 an unknown parent, 2 the block before
  const parents = [{ status: 'canonical' as const }, { status: 'unknown' as const }, { status: 'previous' as const }];
  it('counts the pools that built on another parent, and those of them that then went back to the block before', () => {
    expect(wentBack({ parents, lanes: [
      { runs: [[0, 1, 0, 1], [20, 2, 0, 0], [60, 0, 0, 0]] },   // went back
      { runs: [[0, 1, 0, 1], [60, 0, 0, 0]] },                  // stayed
      { runs: [[0, 0, 0, 0]] },                                 // only on our best block: not counted
      { runs: [[0, 0, 0, 0], [5, 2, 0, 0], [9, 1, 0, 0]] },     // went back before building on another parent: not a return from it
    ] })).toEqual({ back: 1, of: 3 });
  });
  it('is null when none went back, or without our best block to judge by', () => {
    expect(wentBack({ parents, lanes: [{ runs: [[0, 1, 0, 0]] }] })).toBeNull();
    expect(wentBack({ parents: [{ status: null }, { status: 'previous' }], lanes: [{ runs: [[0, 0, 0, 0], [1, 1, 0, 0]] }] })).toBeNull();
  });
});
