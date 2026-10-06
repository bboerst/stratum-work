import { describe, expect, it } from 'vitest';
import { classify, toRawMessage } from '../message.js';

describe('classify', () => {
  it.each([
    [{ type: 'block', data: {} }, 'block'],
    [{ type: 'share' }, 'share'],
    [{ type: 'routing' }, 'routing'],
    [{ pool_name: 'A', prev_hash: 'ab' }, 'template'],
    [{ type: 'connection' }, 'other'],
  ])('%j -> %s', (json, kind) => expect(classify(json)).toBe(kind));
});

describe('toRawMessage', () => {
  it('fills legacy connection defaults', () => {
    const m = toRawMessage(Buffer.from('{"pool_name":"A","prev_hash":"ab"}'), 5)!;
    expect(m).toMatchObject({ kind: 'template', pool: 'A', connectionId: 'A', site: 'us-ash-legacy', mode: 'observe', rx: 5 });
  });
  it('keeps explicit connection fields', () => {
    const m = toRawMessage(Buffer.from('{"pool_name":"A","prev_hash":"ab","connection_id":"s/A/work","site":"s","mode":"work"}'), 1)!;
    expect(m).toMatchObject({ connectionId: 's/A/work', site: 's', mode: 'work' });
  });
  it('returns null for invalid JSON', () => expect(toRawMessage(Buffer.from('{'), 1)).toBeNull());
});
