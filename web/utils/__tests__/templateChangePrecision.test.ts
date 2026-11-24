import { beforeEach, describe, expect, test } from 'vitest';

import { createTemplateChangeTracker, TemplateChangeType as T, TemplateChangeResult } from '../templateChangeDetection';
import { clearProcessedDataCache, processTemplateData } from '../templateDataProcessor';
import { StratumV1Data } from '@/lib/types';

// Precision of template change detection: every difference between two consecutive templates must be reported, and
// identical content must report nothing. Coinbases are built field by field (like a pool's stratum server does), so
// each test can change exactly one thing; the property test at the end mutates random fields and random bytes.

// --- coinbase builder --------------------------------------------------------------------------------------------

const le = (n: number, bytes: number) => {
  let s = '';
  for (let i = 0; i < bytes; i++) s += (Math.floor(n / 256 ** i) % 256).toString(16).padStart(2, '0');
  return s;
};
const push = (hex: string) => {
  const n = hex.length / 2;
  if (n > 75) throw new Error('push too long for this builder');
  return n.toString(16).padStart(2, '0') + hex;
};
const ascii = (t: string) => Buffer.from(t, 'ascii').toString('hex');
const varint = (n: number) => n.toString(16).padStart(2, '0'); // < 0xfd in these tests

interface Output { value: number; script: string }
interface Spec {
  height: number;
  auxRoot?: string; // 32 bytes hex
  auxSize?: number;
  auxNonce?: number;
  time?: number; // pushed Unix time
  tag: string;
  counter?: string; // pushed binary data before the extranonce
  suffix?: string; // raw scriptSig bytes after the extranonce
  sequence: number;
  outputs: Output[];
  locktime: number;
  txVersion: number;
}

const p2wpkh = (id: number) => '0014' + le(id, 1).repeat(20);
const opReturn = (dataHex: string) => '6a' + push(dataHex);
const WITNESS = opReturn('aa21a9ed' + '11'.repeat(32));
const RSK = opReturn(ascii('RSKBLOCK:') + '22'.repeat(32));

function baseSpec(): Spec {
  return {
    height: 900_000,
    auxRoot: '33'.repeat(32),
    auxSize: 1,
    auxNonce: 0,
    time: 1_750_000_000,
    tag: '/TestPool/',
    counter: '0102',
    suffix: '',
    sequence: 0xffffffff,
    outputs: [
      { value: 312_500_000, script: p2wpkh(1) },
      { value: 0, script: WITNESS },
      { value: 0, script: RSK },
    ],
    locktime: 0,
    txVersion: 2,
  };
}

/** Split into stratum parts: coinbase1 ends where the extranonce starts (inside the last scriptSig push). */
function build(spec: Spec, en1: string, en2Len: number): Pick<StratumV1Data, 'coinbase1' | 'coinbase2' | 'extranonce1' | 'extranonce2_length'> {
  let before = push(le(spec.height, 3));
  if (spec.auxRoot) before += push('fabe6d6d' + spec.auxRoot + le(spec.auxSize ?? 1, 4) + le(spec.auxNonce ?? 0, 4));
  if (spec.time !== undefined) before += push(le(spec.time, 4));
  before += push(ascii(spec.tag));
  if (spec.counter) before += push(spec.counter);
  const enLen = en1.length / 2 + en2Len;
  before += enLen.toString(16).padStart(2, '0'); // push header of the extranonce
  const after = spec.suffix ?? '';
  const sigLen = before.length / 2 + enLen + after.length / 2;
  const coinbase1 = le(spec.txVersion, 4) + '01' + '00'.repeat(32) + 'ffffffff' + varint(sigLen) + before;
  const outs = spec.outputs.map(o => le(o.value, 8) + varint(o.script.length / 2) + o.script).join('');
  const coinbase2 = after + le(spec.sequence, 4) + varint(spec.outputs.length) + outs + le(spec.locktime, 4);
  return { coinbase1, coinbase2, extranonce1: en1, extranonce2_length: en2Len };
}

let clock = 0;
function template(spec: Spec, o: Partial<StratumV1Data> = {}, en1 = 'a1b2c3d4', en2Len = 8): StratumV1Data {
  clock += 1;
  return {
    pool_name: 'P',
    timestamp: (BigInt(1_750_000_000) * BigInt(1e9) + BigInt(clock) * BigInt(1e6)).toString(16),
    job_id: `j${clock}`,
    height: spec.height,
    prev_hash: 'ab'.repeat(32),
    version: '20000000',
    clean_jobs: false,
    first_transaction: '',
    fee_rate: 0,
    merkle_branches: ['cd'.repeat(32)],
    nbits: '17031234',
    ntime: le(spec.time ?? 1_750_000_000, 4).match(/../g)!.reverse().join(''), // big-endian hex, like stratum
    ...build(spec, en1, en2Len),
    ...o,
  };
}

function diff(a: StratumV1Data, b: StratumV1Data): TemplateChangeResult {
  const tracker = createTemplateChangeTracker();
  tracker.process(a);
  return tracker.process(b);
}

const mutate = (f: (s: Spec) => void): Spec => {
  const s = baseSpec();
  f(s);
  return s;
};

beforeEach(() => {
  clearProcessedDataCache();
  clock = 0;
});

describe('builder sanity', () => {
  test('the built coinbase parses into the fields it was built from', () => {
    const p = processTemplateData(template(baseSpec()));
    expect(p.coinbase.parsed).toBe(true);
    expect(p.coinbase.scriptSigTags).toBe('/TestPool/');
    expect(p.coinbase.scriptSigTime).toBe(1_750_000_000);
    expect(p.coinbase.scriptSigData).toContain('0102');
    expect(p.auxPowHash).toBe('33'.repeat(32));
    expect(p.coinbase.outputValues).toEqual([312_500_000, 0, 0]);
    expect([...p.opReturnProtocols.keys()]).toEqual(['WitnessCommitment', 'RSK Block']);
  });

  test('identical content (new job id and receive time) reports nothing', () => {
    const r = diff(template(baseSpec()), template(baseSpec()));
    expect(r.status).toBe('compared');
    expect(r.changeTypes).toEqual([]);
  });
});

describe('scriptSig, field by field (coinbaseParser byte map)', () => {
  test('a counter in pushed data -> S only', () => {
    const r = diff(template(baseSpec()), template(mutate(s => { s.counter = '0103'; })));
    expect(r.changeTypes).toEqual([T.SCRIPTSIG_DATA]);
    expect(r.changeDetails.scriptSigData).toBeDefined();
  });

  test('a pushed data value that grows a byte -> S (push layout changes with it)', () => {
    const r = diff(template(baseSpec()), template(mutate(s => { s.counter = '010203'; })));
    expect(r.changeTypes).toEqual([T.SCRIPTSIG_DATA]);
  });

  test('a pushed Unix time -> Y (and nTime when the pool moves both)', () => {
    const a = template(baseSpec());
    const b = template(mutate(s => { s.time = 1_750_000_005; }), { ntime: a.ntime });
    expect(diff(a, b).changeTypes).toEqual([T.SCRIPTSIG_TIME]);
  });

  test('the text tag -> Z only, even when its push length changes', () => {
    const r = diff(template(baseSpec()), template(mutate(s => { s.tag = '/TestPool970/'; })));
    expect(r.changeTypes).toEqual([T.COINBASE_ASCII]);
  });

  test('bytes after the extranonce -> S', () => {
    const r = diff(template(mutate(s => { s.suffix = 'aa'; })), template(mutate(s => { s.suffix = 'ab'; })));
    expect(r.changeTypes).toEqual([T.SCRIPTSIG_DATA]);
  });

  test('AuxPoW root, size and nonce -> A, K, J', () => {
    expect(diff(template(baseSpec()), template(mutate(s => { s.auxRoot = '44'.repeat(32); }))).changeTypes).toEqual([T.AUXPOW_HASH]);
    expect(diff(template(baseSpec()), template(mutate(s => { s.auxSize = 2; }))).changeTypes).toEqual([T.AUXPOW_MERKLE_SIZE]);
    expect(diff(template(baseSpec()), template(mutate(s => { s.auxNonce = 7; }))).changeTypes).toEqual([T.AUXPOW_NONCE]);
  });

  test('the extranonce is not content: only a new extranonce1 (a new session) shows, as R', () => {
    const a = template(baseSpec());
    expect(diff(a, template(baseSpec(), {}, 'ffffffff')).changeTypes).toEqual([T.SESSION]);
    expect(diff(a, template(baseSpec(), {}, 'a1b2c3d4', 4)).changeTypes).toEqual([T.EXTRANONCE2_LENGTH]);
  });
});

describe('outputs', () => {
  test('a payout moving between outputs with the same total -> Q', () => {
    const a = template(mutate(s => { s.outputs = [{ value: 200, script: p2wpkh(1) }, { value: 100, script: p2wpkh(2) }]; }));
    const b = template(mutate(s => { s.outputs = [{ value: 150, script: p2wpkh(1) }, { value: 150, script: p2wpkh(2) }]; }));
    const r = diff(a, b);
    expect(r.changeTypes).toEqual([T.COINBASE_OUTPUT_VALUE]);
    expect(r.changeDetails.coinbaseOutputValue).toMatchObject({ old: 300, new: 300, oldValues: [200, 100], newValues: [150, 150] });
  });

  test('a payout address -> U', () => {
    const r = diff(template(baseSpec()), template(mutate(s => { s.outputs[0].script = p2wpkh(9); })));
    expect(r.changeTypes).toEqual([T.COINBASE_OUTPUTS]);
  });

  test('an unknown OP_RETURN payload -> its own type, not silence', () => {
    const a = template(mutate(s => { s.outputs.push({ value: 0, script: opReturn('0102030405') }); }));
    const b = template(mutate(s => { s.outputs.push({ value: 0, script: opReturn('0102030406') }); }));
    expect(diff(a, b).changeTypes).toEqual([T.OP_RETURN_OTHER]);
  });

  test('OCB1 is identified and labelled', () => {
    const ocb1 = (tail: string) => opReturn(ascii('OCB1') + tail);
    const a = template(mutate(s => { s.outputs.push({ value: 0, script: ocb1('00112233445566778899aabbccddeeff') }); }));
    const b = template(mutate(s => { s.outputs.push({ value: 0, script: ocb1('00112233445566778899aabbccddee00') }); }));
    expect([...processTemplateData(a).opReturnProtocols.keys()]).toContain('OCB1');
    expect(diff(a, b).changeTypes).toEqual([T.OP_RETURN_OCB1]);
  });

  test('a repeated protocol: a change to the second copy is seen', () => {
    const two = (x: string) => mutate(s => { s.outputs.push({ value: 0, script: opReturn('0102') }, { value: 0, script: opReturn(x) }); });
    const r = diff(template(two('0a0b')), template(two('0a0c')));
    expect(r.changeTypes).toEqual([T.OP_RETURN_OTHER]);
    expect(r.changeDetails.opReturnProtocols?.changed).toEqual(['Unknown #2']);
  });

  test('a second push after the first in an OP_RETURN is compared too', () => {
    const a = template(mutate(s => { s.outputs.push({ value: 0, script: opReturn('0102') + push('aa') }); }));
    const b = template(mutate(s => { s.outputs.push({ value: 0, script: opReturn('0102') + push('ab') }); }));
    expect(diff(a, b).changeTypes).toEqual([T.OP_RETURN_OTHER]);
  });
});

describe('the rest of the template', () => {
  test('sequence, locktime and tx version -> I, L, X', () => {
    expect(diff(template(baseSpec()), template(mutate(s => { s.sequence = 0; }))).changeTypes).toEqual([T.INPUT_SEQUENCE]);
    expect(diff(template(baseSpec()), template(mutate(s => { s.locktime = 5; }))).changeTypes).toEqual([T.TX_LOCKTIME]);
    expect(diff(template(baseSpec()), template(mutate(s => { s.txVersion = 1; }))).changeTypes).toEqual([T.TX_VERSION]);
  });

  test('a coinbase that does not parse still reports a change (O)', () => {
    const a = template(baseSpec(), { coinbase1: 'zz', coinbase2: '00' });
    const b = template(baseSpec(), { coinbase1: 'zz', coinbase2: '01' });
    expect(diff(a, b).changeTypes).toEqual([T.OTHER]);
  });

  test('a change in the coinbase prevout (no field of its own) still reports O', () => {
    const a = template(baseSpec());
    const b = { ...a, job_id: 'x', timestamp: (BigInt('0x' + a.timestamp) + BigInt(1)).toString(16),
      coinbase1: a.coinbase1.slice(0, 12) + '01' + a.coinbase1.slice(14) };
    expect(diff(a, b).changeTypes).toEqual([T.OTHER]);
  });
});

// --- property test ------------------------------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The template's content: everything except the job id and receive time. */
const content = (t: StratumV1Data) => JSON.stringify([t.height, t.prev_hash, t.version, t.nbits, t.ntime, t.clean_jobs,
  t.merkle_branches, t.coinbase1, t.extranonce1, t.extranonce2_length, t.coinbase2]);

describe('property: a change is reported if and only if the content differs', () => {
  test('2,000 random single mutations (fields and raw bytes)', () => {
    const rand = rng(20261124);
    const pick = <X,>(xs: X[]) => xs[Math.floor(rand() * xs.length)];
    const hexByte = () => Math.floor(rand() * 256).toString(16).padStart(2, '0');
    const flip = (hex: string) => {
      if (hex.length < 2) return hex;
      const i = Math.floor(rand() * (hex.length / 2)) * 2;
      let b = hexByte();
      while (b === hex.slice(i, i + 2)) b = hexByte();
      return hex.slice(0, i) + b + hex.slice(i + 2);
    };

    const mutations: ((t: StratumV1Data) => StratumV1Data)[] = [
      t => t, // no change
      t => ({ ...t, coinbase1: flip(t.coinbase1) }),
      t => ({ ...t, coinbase2: flip(t.coinbase2) }),
      t => ({ ...t, merkle_branches: [flip(t.merkle_branches[0])] }),
      t => ({ ...t, prev_hash: flip(t.prev_hash) }),
      t => ({ ...t, version: flip(t.version) }),
      t => ({ ...t, nbits: flip(t.nbits!) }),
      t => ({ ...t, ntime: flip(t.ntime!) }),
      t => ({ ...t, extranonce1: flip(t.extranonce1) }),
      t => ({ ...t, clean_jobs: true }),
      t => ({ ...t, height: t.height + pick([-1, 1]) }),
    ];

    let reported = 0;
    for (let i = 0; i < 2000; i++) {
      clearProcessedDataCache();
      const spec = baseSpec();
      if (rand() < 0.5) spec.auxRoot = undefined;
      if (rand() < 0.3) spec.time = undefined;
      if (rand() < 0.3) spec.counter = undefined;
      if (rand() < 0.3) spec.suffix = hexByte();
      if (rand() < 0.3) spec.outputs.push({ value: 0, script: opReturn(hexByte() + hexByte() + hexByte()) });
      const a = template(spec);
      const m = pick(mutations);
      const b = { ...m(a), job_id: 'next', timestamp: (BigInt('0x' + a.timestamp) + BigInt(1000)).toString(16) };
      const r = diff(a, b);
      const changed = content(a) !== content(b);
      if (changed !== r.changeTypes.length > 0) {
        throw new Error(`mutation ${i}: content ${changed ? 'differs' : 'equal'}, reported ${JSON.stringify(r.changeTypes)}\n` +
          `a=${JSON.stringify(a)}\nb=${JSON.stringify(b)}`);
      }
      if (changed) reported++;
    }
    expect(reported).toBeGreaterThan(1500); // the no-change mutation is about 1 in 11
  });
});
