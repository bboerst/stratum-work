import { describe, expect, it } from 'vitest';
import { decodeCoinbaseScriptSigInfo } from '../bitcoinUtils';

const sig = (hex: string) => Buffer.from(hex, 'hex');
const tag = Buffer.from('/test-pool/').toString('hex');

describe('decodeCoinbaseScriptSigInfo height', () => {
  it('decodes a 3-byte push (Bitcoin today)', () => {
    expect(decodeCoinbaseScriptSigInfo(sig('0393e20e' + tag)).height).toBe(975507);
  });

  it('keeps working past 1,000,000 and at the 3-byte limit', () => {
    expect(decodeCoinbaseScriptSigInfo(sig('0340420f' + tag)).height).toBe(1_000_000);
    expect(decodeCoinbaseScriptSigInfo(sig('03ffff7f' + tag)).height).toBe(8_388_607);
  });

  it('honors the push length instead of assuming 3 bytes', () => {
    expect(decodeCoinbaseScriptSigInfo(sig('04000080' + '00' + tag)).height).toBe(8_388_608); // 4-byte push
    expect(decodeCoinbaseScriptSigInfo(sig('023412' + tag)).height).toBe(0x1234); // 2-byte push
    expect(decodeCoinbaseScriptSigInfo(sig('0111' + tag)).height).toBe(0x11); // 1-byte push
  });

  it('handles OP_1..OP_16', () => {
    expect(decodeCoinbaseScriptSigInfo(sig('51' + tag)).height).toBe(1);
    expect(decodeCoinbaseScriptSigInfo(sig('60' + tag)).height).toBe(16);
  });

  it('returns null for negative numbers and non-height pushes', () => {
    expect(decodeCoinbaseScriptSigInfo(sig('0393e28e' + tag)).height).toBeNull(); // sign bit set
    expect(decodeCoinbaseScriptSigInfo(sig('0b' + tag)).height).toBeNull(); // 11-byte push: a tag, not a height
    expect(decodeCoinbaseScriptSigInfo(sig('')).height).toBeNull();
  });
});
