import { describe, expect, it } from 'vitest';
import { buildPoolView } from '../poolView';
import { decodeTemplate } from '../decode';
import { makeRaw, tsHex } from './fixtures';

const none = () => ({ id: null, name: 'Unknown', method: 'none' as const });
const t = (ms: number, conn: string, branches: string[]) =>
  decodeTemplate(makeRaw({ timestamp: tsHex(ms), connection_id: conn, merkle_branches: branches }), `${conn}@${ms}`, none);

describe('buildPoolView', () => {
  it('merges identical content across connections to the earliest arrival', () => {
    const v = buildPoolView([t(1000, 'a', ['x']), t(1040, 'b', ['x']), t(2000, 'b', ['y']), t(2010, 'a', ['y'])]);
    expect(v).toHaveLength(2);
    expect(v[0].template.connectionId).toBe('a');
    expect(v[0].arrivals.map(a => [a.connectionId, a.offsetMs])).toEqual([['a', 0], ['b', 40]]);
    expect(v[1].template.connectionId).toBe('b');
    expect(v[1].arrivals.map(a => [a.connectionId, a.offsetMs])).toEqual([['b', 0], ['a', 10]]);
  });
  it('treats content that returns after a change as a new entry', () => {
    const v = buildPoolView([t(1000, 'a', ['x']), t(2000, 'a', ['y']), t(3000, 'a', ['x'])]);
    expect(v.map(e => e.template.merkleBranches[0])).toEqual(['x', 'y', 'x']);
  });
  it('repeats of the same content on one connection add no entries', () => {
    expect(buildPoolView([t(1000, 'a', ['x']), t(1500, 'a', ['x'])])).toHaveLength(1);
  });
});
