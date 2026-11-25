/**
 * extranonce1 masking (#105): the pseudonym's properties, and maskTemplate / maskStreamMessage on the shapes the web
 * serves. All values are synthetic.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMasker, maskExtranonce1, maskStreamMessage, maskTemplate, maskTemplates, resetConnectionMaskForTests,
} from '../connectionMask';

const KEY = 'test-key-0123456789abcdef';
const mask = createMasker(KEY);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetConnectionMaskForTests();
});

describe('createMasker', () => {
  it('keeps the length, as lower-case hex, and never returns the input', () => {
    for (const raw of ['ab', '0011aabb', 'f00dfacecafe1234', 'A1B2C3D4', 'ab'.repeat(40)]) {
      const out = mask('PoolA', raw) as string;
      expect(out).toMatch(/^[0-9a-f]*$/);
      expect(out).toHaveLength(raw.length);
      expect(out).not.toBe(raw.toLowerCase());
    }
  });

  it('is deterministic for the same pool and value, and case-insensitive for hex', () => {
    expect(mask('PoolA', '0011aabb')).toBe(mask('PoolA', '0011aabb'));
    expect(mask('PoolA', '0011AABB')).toBe(mask('PoolA', '0011aabb'));
    expect(mask('PoolA', '0011aabb')).not.toBe(mask('PoolA', '0011aabc'));
  });

  it('separates pools', () => {
    expect(mask('PoolA', '0011aabb')).not.toBe(mask('PoolB', '0011aabb'));
    // The separator stops pool/value boundaries from colliding.
    expect(mask('Pool', 'a0011aab')).not.toBe(mask('Poola', '0011aab'));
  });

  it('depends on the key', () => {
    expect(createMasker('other-key')('PoolA', '0011aabb')).not.toBe(mask('PoolA', '0011aabb'));
  });

  it('passes null, undefined and empty through, and never throws on odd input', () => {
    expect(mask('PoolA', null)).toBeNull();
    expect(mask('PoolA', undefined)).toBeUndefined();
    expect(mask('PoolA', '')).toBe('');
    expect(mask(null, '0011aabb')).toHaveLength(8);
    expect(mask('PoolA', 'abc')).toMatch(/^[0-9a-f]{3}$/);            // odd-length hex
    const nonHex = mask('PoolA', 'not hex!') as string;                 // non-hex string
    expect(nonHex).toMatch(/^[0-9a-f]{8}$/);
    expect(mask('PoolA', 12345)).toMatch(/^[0-9a-f]{5}$/);              // a pool sending a number
    expect(() => mask('PoolA', { a: 1 })).not.toThrow();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(mask('PoolA', circular)).toBe('');
  });

  it('masks a Buffer (raw Postgres bytea) like its hex', () => {
    expect(mask('PoolA', Buffer.from('0011aabb', 'hex'))).toBe(mask('PoolA', '0011aabb'));
  });
});

describe('maskExtranonce1 (process key)', () => {
  it('uses EXTRANONCE1_MASK_KEY when set', () => {
    vi.stubEnv('EXTRANONCE1_MASK_KEY', KEY);
    expect(maskExtranonce1('PoolA', '0011aabb')).toBe(mask('PoolA', '0011aabb'));
  });

  it('without a key, masks with a random per-process key and warns once', () => {
    vi.stubEnv('EXTRANONCE1_MASK_KEY', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = maskExtranonce1('PoolA', '0011aabb');
    const b = maskExtranonce1('PoolA', '0011aabb');
    expect(a).toBe(b);
    expect(a).not.toBe('0011aabb');
    expect(a).toHaveLength(8);
    expect(warn).toHaveBeenCalledTimes(1);
    resetConnectionMaskForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(maskExtranonce1('PoolA', '0011aabb')).not.toBe(a); // a new process, a new key
  });
});

describe('maskTemplate', () => {
  it('masks the API shape without touching other fields or the input', () => {
    const doc = { id: 'x', pool_name: 'PoolA', coinbase1: '01', coinbase2: '02', extranonce1: '0011aabb', extranonce2_length: 4 };
    const out = maskTemplate(doc, mask);
    expect(out).toEqual({ ...doc, extranonce1: mask('PoolA', '0011aabb') });
    expect(doc.extranonce1).toBe('0011aabb');
  });

  it('masks a raw Postgres row (source_name, bytea)', () => {
    const row = { source_name: 'PoolA', extranonce1: Buffer.from('0011aabb', 'hex') };
    expect(maskTemplate(row, mask).extranonce1).toBe(mask('PoolA', '0011aabb'));
  });

  it('leaves objects without extranonce1 and non-objects alone', () => {
    const block = { type: 'block', height: 1 };
    expect(maskTemplate(block, mask)).toBe(block);
    expect(maskTemplate(null, mask)).toBeNull();
    expect(maskTemplates([{ pool_name: 'PoolA', extranonce1: 'aa' }], mask)[0].extranonce1).toBe(mask('PoolA', 'aa'));
  });
});

describe('maskStreamMessage', () => {
  it('masks a template message and drops its job id', () => {
    const msg = JSON.stringify({ pool_name: 'PoolA', extranonce1: '0011aabb', job_id: '1' });
    const out = JSON.parse(maskStreamMessage(msg, mask)!);
    expect(out.extranonce1).toBe(mask('PoolA', '0011aabb'));
    expect(out).not.toHaveProperty('job_id');
  });

  it('drops job ids at any depth from messages without extranonce1 (a block event\'s analysis)', () => {
    const msg = JSON.stringify({ type: 'block', analysis: { coinbase_parse: { unparsed: [{ pool_name: 'PoolA', sample_job_id: 'JOBSENTINEL' }] } } });
    const out = maskStreamMessage(msg, mask)!;
    expect(out).not.toContain('JOBSENTINEL');
    expect(JSON.parse(out)).toEqual({ type: 'block', analysis: { coinbase_parse: { unparsed: [{ pool_name: 'PoolA' }] } } });
    expect(maskStreamMessage('{"job_id":"1"', mask)).toBeNull();   // unparseable and mentions it: dropped
  });

  it('keeps the same text when the words only appear inside values', () => {
    const msg = '{"type":"note","text":"job_id and extranonce1"}';
    expect(maskStreamMessage(msg, mask)).toBe(msg);
  });

  it('passes messages without the field unchanged', () => {
    const msg = '{"type":"block","height":1}';
    expect(maskStreamMessage(msg, mask)).toBe(msg);
    expect(maskStreamMessage('not json', mask)).toBe('not json');
  });

  it('drops an unparseable message that mentions extranonce1', () => {
    expect(maskStreamMessage('{"extranonce1":"0011aabb"', mask)).toBeNull();
  });
});
