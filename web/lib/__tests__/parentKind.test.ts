import { describe, expect, it } from 'vitest';
import {
  bitcoinDifficulty, connectionLabel, meetsPow, parentKind, parentPowOk, targetFromBits, tipOffset, type ParentFacts,
} from '../parentKind';

// Public Bitcoin headers (block hash in display order, header bits)
const GENESIS = { hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f', bits: 0x1d00ffff };
const B125552 = { hash: '00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d', bits: 0x1a44b9f2 };
const hex64 = (n: bigint) => n.toString(16).padStart(64, '0');

describe('targetFromBits', () => {
  it('expands compact bits like SetCompact', () => {
    expect(targetFromBits(0x1d00ffff)).toBe(BigInt(0xffff) << BigInt(208));
    expect(targetFromBits(GENESIS.bits)).toBe(BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000'));
    expect(targetFromBits(B125552.bits)).toBe(BigInt(0x44b9f2) << BigInt(184));
    expect(targetFromBits('440711666')).toBe(BigInt(0x44b9f2) << BigInt(184));      // bigint columns arrive as strings
    expect(targetFromBits(0x03123456)).toBe(BigInt(0x123456));
    expect(targetFromBits(0x02123456)).toBe(BigInt(0x1234));                 // exponent below 3 shifts right
    expect(targetFromBits(0x1d000000)).toBe(BigInt(0));
  });
  it('has no target for a negative or overflowing encoding, or garbage', () => {
    expect(targetFromBits(0x04923456)).toBeNull();                    // sign bit
    expect(targetFromBits(0x23123456)).toBeNull();                    // beyond 256 bits
    expect(targetFromBits(-1)).toBeNull();
    expect(targetFromBits(2 ** 32)).toBeNull();
    expect(targetFromBits('x')).toBeNull();
  });
});

describe('meetsPow', () => {
  it('accepts real block hashes at their bits', () => {
    expect(meetsPow(GENESIS.hash, GENESIS.bits)).toBe(true);
    expect(meetsPow(B125552.hash, B125552.bits)).toBe(true);
    expect(meetsPow(B125552.hash.toUpperCase(), B125552.bits)).toBe(true);
  });
  it('reads the hash big-endian (display order): the byte-reversed hash fails', () => {
    const reversed = B125552.hash.match(/../g)!.reverse().join('');
    expect(meetsPow(reversed, B125552.bits)).toBe(false);
  });
  it('rejects a harder target than the block met', () => {
    expect(meetsPow(GENESIS.hash, B125552.bits)).toBe(false);
  });
  it('rejects the all-ff hash at any real target', () => {
    expect(meetsPow('f'.repeat(64), GENESIS.bits)).toBe(false);
    expect(meetsPow('f'.repeat(64), B125552.bits)).toBe(false);
  });
  it('accepts a hash exactly at the target and rejects target + 1', () => {
    const t = targetFromBits(B125552.bits)!;
    expect(meetsPow(hex64(t), B125552.bits)).toBe(true);
    expect(meetsPow(hex64(t + BigInt(1)), B125552.bits)).toBe(false);
    expect(meetsPow(hex64(BigInt(0)), 0x1d000000)).toBe(true);
    expect(meetsPow(hex64(BigInt(1)), 0x1d000000)).toBe(false);
  });
  it('rejects malformed hashes and invalid bits', () => {
    expect(meetsPow('00', GENESIS.bits)).toBe(false);
    expect(meetsPow('g'.repeat(64), GENESIS.bits)).toBe(false);
    expect(meetsPow(hex64(BigInt(0)), 0x04923456)).toBe(false);
  });
});

describe('parentPowOk', () => {
  it("uses Bitcoin's bits at h - 1 when stored, else the template's nbits", () => {
    expect(parentPowOk(GENESIS.hash, B125552.bits, GENESIS.bits)).toBe(true);    // Bitcoin's bits win
    expect(parentPowOk(GENESIS.hash, GENESIS.bits, B125552.bits)).toBe(false);
    expect(parentPowOk(GENESIS.hash, GENESIS.bits, null)).toBe(true);
  });
});

describe('parentKind', () => {
  const BITS = 0x17034219;
  const base: ParentFacts = { height: 900_001, tip: 900_000, nbits: BITS, bitcoinBitsPrev: BITS, bitcoinBitsAt: BITS, powOk: true };

  it('bitcoin_block: PoW at Bitcoin\'s target, Bitcoin\'s nbits, at the tip (a lost race)', () => {
    expect(parentKind(base)).toBe('bitcoin_block');
    expect(parentKind({ ...base, tip: 899_999 })).toBe('bitcoin_block');          // offset +1: one above our tip
    expect(parentKind({ ...base, tip: 900_001 })).toBe('bitcoin_block');          // offset -1
  });
  it('bitcoin_block above our stored tip: no Bitcoin bits at h - 1, PoW from the template nbits, offset 1', () => {
    expect(parentKind({ ...base, height: 900_002, bitcoinBitsPrev: null, bitcoinBitsAt: null })).toBe('bitcoin_block');
  });
  it("bitcoin_block far from the tip still, when the difficulty is Bitcoin's and the PoW holds (work can't be faked)", () => {
    expect(parentKind({ ...base, tip: 905_000 })).toBe('bitcoin_block');
  });
  it('invalid_parent: Bitcoin\'s height and nbits, but the hash misses the target', () => {
    expect(parentKind({ ...base, powOk: false })).toBe('invalid_parent');
    expect(parentKind({ ...base, height: 900_002, bitcoinBitsPrev: null, bitcoinBitsAt: null, powOk: false })).toBe('invalid_parent');
  });
  it('other_chain: nbits differ from Bitcoin\'s at that height, checked before PoW', () => {
    expect(parentKind({ ...base, nbits: 0x1d00ffff })).toBe('other_chain');
    // a lower-difficulty chain's block at a Bitcoin height fails Bitcoin's target: still another chain, not invalid
    expect(parentKind({ ...base, nbits: 0x1d00ffff, powOk: false })).toBe('other_chain');
  });
  it('other_chain: far above our tip (nothing stored there), whatever the PoW', () => {
    expect(parentKind({ ...base, height: 6_976_415, bitcoinBitsPrev: null, bitcoinBitsAt: null })).toBe('other_chain');
    expect(parentKind({ ...base, height: 900_003, bitcoinBitsPrev: null, bitcoinBitsAt: null, powOk: false })).toBe('other_chain');
  });
  it('other_chain: far below with different nbits', () => {
    expect(parentKind({ ...base, height: 890_000, nbits: 0x18034219, powOk: false })).toBe('other_chain');
  });
  it('a retarget height compares the nbits with the bits at h, not h - 1', () => {
    const h = 2016 * 447;
    const f = { ...base, height: h, tip: h - 1, nbits: 0x17030000, bitcoinBitsPrev: BITS, bitcoinBitsAt: 0x17030000 };
    expect(bitcoinDifficulty(f)).toBe(true);
    expect(parentKind(f)).toBe('bitcoin_block');
    expect(bitcoinDifficulty({ ...f, bitcoinBitsAt: null })).toBeNull();        // the new period's bits not stored yet
    expect(parentKind({ ...f, bitcoinBitsAt: null })).toBe('bitcoin_block');    // unknown difficulty, at the tip
    expect(parentKind({ ...f, bitcoinBitsAt: BITS })).toBe('other_chain');
  });
  it('undetermined without a tip or Bitcoin bits', () => {
    expect(parentKind({ ...base, tip: null, bitcoinBitsPrev: null, bitcoinBitsAt: null })).toBe('undetermined');
    // Bitcoin bits stored at h - 1 decide even without a tip
    expect(parentKind({ ...base, tip: null })).toBe('bitcoin_block');
  });
  it('tipOffset', () => {
    expect(tipOffset(101, 100)).toBe(0);
    expect(tipOffset(103, 100)).toBe(2);
    expect(tipOffset(5, null)).toBeNull();
  });
});

describe('connectionLabel', () => {
  it('letters a, b, … by rank, then cN', () => {
    expect([1, 2, 3, 26].map(connectionLabel)).toEqual(['a', 'b', 'c', 'z']);
    expect(connectionLabel(27)).toBe('c27');
  });
});
