/**
 * Every value in a template comes from a pool (#105): the decoders take hostile input without throwing, without
 * unbounded work, and without allocating more than their size caps. A seeded fuzz over the coinbase rebuild and every
 * decoder that reads it, plus whole stream messages with wrong types, through the template processor and change
 * detection. Seeded, so a failure reproduces; the seed and case are in the message.
 */
import { describe, expect, it } from 'vitest';
import { coinbaseHex, MAX_COINBASE_BYTES, MAX_EXTRANONCE2_LENGTH, parseCoinbase, rangeHex } from '../coinbaseParser';
import { decodeMergeMining } from '../mergeMining';
import { formatCoinbaseRaw } from '../formatters';
import {
  computeCoinbaseOutputs, computeCoinbaseOutputValue, computeCoinbaseScriptSigInfo, decodeCoinbaseScriptSigInfo,
  decodeOpReturnData, getCoinbaseTxDetails, getFormattedCoinbaseAsciiTag,
} from '../bitcoinUtils';
import { processTemplateData } from '../templateDataProcessor';
import { compareTemplates, createTemplateChangeTracker } from '../templateChangeDetection';
import type { StratumV1Data } from '../../lib/types';

/** mulberry32: small, seeded, good enough to spread cases. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (b: number[]) => b.map(x => x.toString(16).padStart(2, '0')).join('');
const le = (v: number, n: number) => Array.from({ length: n }, (_, i) => Math.floor(v / 256 ** i) & 0xff);

/** A well-formed coinbase: version, one null-prevout input with a height push and a tag, 2 outputs, locktime. */
function coinbase(r: () => number): { cb1: string; en1: string; en2: number; cb2: string } {
  const tag = Array.from({ length: 4 + Math.floor(r() * 12) }, () => 0x41 + Math.floor(r() * 26));
  const en1 = Array.from({ length: 4 }, () => Math.floor(r() * 256));
  const en2 = 4 + Math.floor(r() * 5);
  const sig = [0x03, ...le(977000 + Math.floor(r() * 1000), 3), tag.length, ...tag];
  const before = [...le(1, 4), 0x01, ...Array(32).fill(0), 0xff, 0xff, 0xff, 0xff, sig.length + en1.length + en2, ...sig];
  const out = (v: number, script: number[]) => [...le(v, 8), script.length, ...script];
  const after = [0xff, 0xff, 0xff, 0xff, 0x02,
    ...out(312500000, [0x76, 0xa9, 0x14, ...Array(20).fill(7), 0x88, 0xac]),
    ...out(0, [0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed, ...Array(32).fill(9)]), ...le(0, 4)];
  return { cb1: hex(before), en1: hex(en1), en2, cb2: hex(after) };
}

/** A hostile edit of a hex string: byte flips, a CompactSize bomb, truncation, junk, an odd digit or a huge blob. */
function mutate(s: string, r: () => number): string {
  const b = s.match(/../g) ?? [];
  switch (Math.floor(r() * 7)) {
    case 0: { for (let k = 0; k < 1 + r() * 4; k++) b[Math.floor(r() * b.length)] = hex([Math.floor(r() * 256)]); return b.join(''); }
    case 1: { const i = Math.floor(r() * b.length); b.splice(i, 0, 'ff', 'ff', 'ff', 'ff', 'ff', 'ff', 'ff', 'ff', 'ff'); return b.join(''); }
    case 2: return b.slice(0, Math.floor(r() * b.length)).join('');
    case 3: return s + 'zz';
    case 4: return s + 'a';
    case 5: return 'ab'.repeat(Math.floor(MAX_COINBASE_BYTES * (0.5 + r())));   // up to 1.5x the cap
    default: return s;
  }
}

const EN2: unknown[] = [-1, -32768, 0, 4, 8, MAX_EXTRANONCE2_LENGTH, MAX_EXTRANONCE2_LENGTH + 1, 32767, 1e6, 2e8, 2 ** 31,
  NaN, Infinity, 3.5, '8', '8000000', 'abc', null, undefined, {}];

function assertBounded(label: string, f: () => unknown) {
  const t = performance.now();
  let v: unknown;
  try { v = f(); } catch (e) { throw new Error(`${label} threw: ${String(e)}`); }
  const ms = performance.now() - t;
  if (ms > 250) throw new Error(`${label} took ${ms.toFixed(0)} ms`);
  if (typeof v === 'string' && v.length > MAX_COINBASE_BYTES * 2 + 64) throw new Error(`${label} returned ${v.length} chars`);
  return v;
}

describe('coinbaseHex', () => {
  const { cb1, en1, cb2 } = coinbase(rng(1));
  it('rebuilds a coinbase only from hex parts and an extranonce2 length in 0..64', () => {
    expect(coinbaseHex(cb1, en1, 4, cb2)).toBe(cb1 + en1 + '00000000' + cb2);
    expect(coinbaseHex(cb1, en1, '8', cb2)).toBe(cb1 + en1 + '00'.repeat(8) + cb2);
    expect(coinbaseHex(cb1, null, 0, cb2)).toBe(cb1 + cb2);
    for (const n of [-1, 65, 1e6, 2 ** 31, NaN, 3.5, 'abc', '8000000', null, {}]) expect(coinbaseHex(cb1, en1, n, cb2)).toBeNull();
    expect(coinbaseHex(cb1 + 'z', en1, 4, cb2)).toBeNull();
    expect(coinbaseHex(cb1 + 'a', en1, 4, cb2)).toBeNull();
    expect(coinbaseHex('ab'.repeat(MAX_COINBASE_BYTES), en1, 4, cb2)).toBeNull();
    expect(coinbaseHex(42, en1, 4, cb2)).toBeNull();
  });
  it('formatCoinbaseRaw and rangeHex give "" for parts that can\'t be a coinbase, never throw', () => {
    expect(formatCoinbaseRaw(cb1, en1, -1, cb2)).toBe('');
    expect(formatCoinbaseRaw(cb1, en1, 2e8, cb2)).toBe('');
    expect(rangeHex(cb1, en1, -1, cb2, { start: 0, end: 4 })).toBe('');
    expect(rangeHex(cb1, en1, 4, cb2, { start: 0, end: 4 })).toBe(cb1.slice(0, 8));
  });
});

describe('decoders under hostile input (seeded fuzz)', () => {
  it('a well-formed coinbase still decodes (the fuzz exercises real paths)', () => {
    const { cb1, en1, en2, cb2 } = coinbase(rng(2));
    const parsed = parseCoinbase(cb1, en1, en2, cb2);
    expect(parsed.ok).toBe(true);
    expect(parsed.outputs).toHaveLength(2);
    expect(computeCoinbaseOutputValue(formatCoinbaseRaw(cb1, en1, en2, cb2))).toBe(312500000);
    expect(getFormattedCoinbaseAsciiTag(cb1, en1, en2, cb2)).toMatch(/^[A-Z]{4,}$/);
  });

  it('never throws, stays fast and bounded, for 1,500 mutated coinbases and hostile extranonce2 lengths', () => {
    const SEED = 105;
    const r = rng(SEED);
    let parsedOk = 0;
    for (let i = 0; i < 1500; i++) {
      const c = coinbase(r);
      const cb1 = r() < 0.5 ? mutate(c.cb1, r) : c.cb1;
      const cb2 = r() < 0.5 ? mutate(c.cb2, r) : c.cb2;
      const en1 = r() < 0.15 ? mutate(c.en1, r) : c.en1;
      const en2 = (r() < 0.3 ? EN2[Math.floor(r() * EN2.length)] : c.en2) as number;
      const at = `seed ${SEED} case ${i}`;
      const p = assertBounded(`${at} parseCoinbase`, () => parseCoinbase(cb1, en1, en2, cb2)) as { ok: boolean };
      if (p.ok) parsedOk++;
      const raw = assertBounded(`${at} formatCoinbaseRaw`, () => formatCoinbaseRaw(cb1, en1, en2, cb2)) as string;
      assertBounded(`${at} decodeMergeMining`, () => decodeMergeMining(cb1, en1, en2, cb2));
      assertBounded(`${at} getFormattedCoinbaseAsciiTag`, () => getFormattedCoinbaseAsciiTag(cb1, en1, en2, cb2));
      assertBounded(`${at} computeCoinbaseOutputs`, () => computeCoinbaseOutputs(raw));
      assertBounded(`${at} computeCoinbaseOutputValue`, () => computeCoinbaseOutputValue(raw));
      assertBounded(`${at} computeCoinbaseScriptSigInfo`, () => computeCoinbaseScriptSigInfo(raw));
      assertBounded(`${at} getCoinbaseTxDetails`, () => getCoinbaseTxDetails(raw));
      assertBounded(`${at} decodeCoinbaseScriptSigInfo`, () => decodeCoinbaseScriptSigInfo(Buffer.from(cb1.slice(0, 400), 'hex')));
      assertBounded(`${at} decodeOpReturnData`, () => decodeOpReturnData(cb2.slice(0, 200 + Math.floor(r() * 200))));
    }
    // the mutations leave a real share of the cases parseable, so the decoders' deep paths ran too
    expect(parsedOk).toBeGreaterThan(300);
    expect(parsedOk).toBeLessThan(1500);
  });

  it('a whole stream message with wrong types goes through the processor and change detection without throwing', () => {
    const r = rng(311);
    const odd: unknown[] = [null, undefined, 42, -1, 'zz', {}, [], ['zz'], 'ab'.repeat(5000), true, 1e300];
    const pick = () => odd[Math.floor(r() * odd.length)];
    let prev: ReturnType<typeof processTemplateData> | null = null;
    const tracker = createTemplateChangeTracker();
    for (let i = 0; i < 600; i++) {
      const c = coinbase(r);
      const msg: Record<string, unknown> = {
        type: 'stratum_v1', pool_name: 'P', height: 977001, job_id: `j${i}`, timestamp: String(1_790_000_000_000_000 + i),
        prev_hash: '00'.repeat(32), version: '20000000', nbits: '17034219', ntime: '6a000000', clean_jobs: true,
        merkle_branches: ['11'.repeat(32)], coinbase1: c.cb1, extranonce1: c.en1, extranonce2_length: c.en2, coinbase2: c.cb2,
      };
      for (const k of Object.keys(msg)) if (k !== 'type' && k !== 'pool_name' && r() < 0.12) msg[k] = pick();
      const data = msg as unknown as StratumV1Data;
      const processed = assertBounded(`case ${i} processTemplateData`, () => processTemplateData(data)) as ReturnType<typeof processTemplateData>;
      expect(processed).toBeTruthy();
      if (prev) assertBounded(`case ${i} compareTemplates`, () => compareTemplates(prev!, processed));
      prev = processed;
      assertBounded(`case ${i} tracker.process`, () => tracker.process(data, { gapBefore: r() < 0.1 }));
    }
  });
});
