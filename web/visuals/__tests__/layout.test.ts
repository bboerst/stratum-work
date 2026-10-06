import { describe, expect, it } from 'vitest';
import { decodeLayoutWith, encodeLayout } from '../layout';

const reg = (id: string) => (id === 'x' ? { defaultParams: { a: 1, b: 2 }, scopes: ['live', 'range'] } : undefined);
const all = (id: string) => (id === 'y'
  ? { defaultParams: { n: 16, m: 3 }, scopes: ['live', 'height', 'range'], paramsSchema: [{ key: 'n', label: 'n', kind: 'number' as const, min: 4, max: 64 }, { key: 'm', label: 'm', kind: 'number' as const, min: 0 }] }
  : undefined);

describe('layout codec', () => {
  it('round-trips through base64url with defaults merged', () => {
    const s = encodeLayout([{ v: 'x', s: { kind: 'live' }, p: { b: 5 } }]);
    expect(s).not.toMatch(/[+/=]/);
    expect(decodeLayoutWith(s, reg)).toEqual([{ v: 'x', s: { kind: 'live' }, p: { a: 1, b: 5 } }]);
  });
  it('drops unknown visuals, unsupported scopes and garbage', () => {
    const s = encodeLayout([{ v: 'nope', s: { kind: 'live' }, p: {} }, { v: 'x', s: { kind: 'height', height: 1 }, p: {} }]);
    expect(decodeLayoutWith(s, reg)).toEqual([]);
    expect(decodeLayoutWith('%%%', reg)).toEqual([]);
    expect(decodeLayoutWith(null, reg)).toEqual([]);
  });
  it('validates per-kind scope fields', () => {
    const bad = encodeLayout([
      { v: 'y', s: { kind: 'height', height: 'x' }, p: {} },
      { v: 'y', s: { kind: 'range', fromMs: 10, toMs: 5 }, p: {} },
      { v: 'y', s: { kind: 'range', fromMs: 1 }, p: {} },
      { v: 'y', s: { kind: 'bogus' }, p: {} },
    ] as never);
    expect(decodeLayoutWith(bad, all)).toEqual([]);
    const ok = encodeLayout([{ v: 'y', s: { kind: 'height', height: 5 }, p: {} }, { v: 'y', s: { kind: 'range', fromMs: 1, toMs: 1 }, p: {} }]);
    expect(decodeLayoutWith(ok, all).map(i => i.s)).toEqual([{ kind: 'height', height: 5 }, { kind: 'range', fromMs: 1, toMs: 1 }]);
  });
  it('clamps numeric params to the schema and resets non-finite values to defaults', () => {
    const s = encodeLayout([
      { v: 'y', s: { kind: 'live' }, p: { n: 1000, m: -3 } },
      { v: 'y', s: { kind: 'live' }, p: { n: 1, m: 'z' } },
    ]);
    expect(decodeLayoutWith(s, all).map(i => i.p)).toEqual([{ n: 64, m: 0 }, { n: 4, m: 3 }]);
  });
});
