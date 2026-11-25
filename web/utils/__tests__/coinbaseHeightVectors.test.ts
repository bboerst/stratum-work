/**
 * The BIP34 height cases shared with the collector (collector-go/coinbase.go parseBIP34Height, which writes
 * templates.height): testdata/coinbase-height-vectors.json at the repo root. The web gives each case's `height`, or
 * the `web` override where it differs on purpose (with the reason in the file). A missing file fails, never skips.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { heightFromCoinbase1, parseCoinbase } from '../coinbaseParser';

interface Vector { name: string; coinbase1: string; height: string | null; web?: { height: string | null; why: string } }
const doc = JSON.parse(readFileSync(fileURLToPath(new URL('../../../testdata/coinbase-height-vectors.json', import.meta.url)), 'utf8')) as
  { version: number; cases: Vector[] };
const want = (v: Vector) => (v.web ? v.web.height : v.height);

// The rest of a coinbase after coinbase1: 4 extranonce1 bytes, 4 of extranonce2, then sequence, one output, locktime.
const EN1 = 'c0ffee00';
const CB2 = 'ffffffff' + '01' + '00f2052a01000000' + '01' + '51' + '00000000';

describe('shared coinbase height vectors', () => {
  it('has the file, version 1, and enough cases of each kind', () => {
    expect(doc.version).toBe(1);
    const withHeight = doc.cases.filter(c => want(c) !== null).length;
    expect(withHeight).toBeGreaterThanOrEqual(8);
    expect(doc.cases.length - withHeight).toBeGreaterThanOrEqual(10);
    expect(doc.cases.filter(c => c.web).every(c => c.web!.why.length > 0)).toBe(true);
  });

  for (const v of doc.cases) {
    it(`heightFromCoinbase1: ${v.name}`, () => {
      const h = heightFromCoinbase1(v.coinbase1);
      expect(h === null ? null : String(h)).toBe(want(v));
    });
  }

  it('the full parser gives the same height wherever the whole coinbase parses', () => {
    let parsed = 0;
    for (const v of doc.cases) {
      const p = parseCoinbase(v.coinbase1, EN1, 4, CB2);
      if (!p.ok) continue;
      parsed++;
      const h = p.scriptSig?.height ?? null;
      expect(h === null ? null : String(h), v.name).toBe(want(v));
    }
    expect(parsed).toBeGreaterThanOrEqual(15);
  });
});
