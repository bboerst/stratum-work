import { describe, expect, it } from 'vitest';
import { templateFamilies } from '../families';
import { pairKey, type PairEvidence } from '../evidence/types';

const pe = (a: string, b: string, total: number) => [pairKey(a, b), { a, b, total, channels: {} as never }] as [string, PairEvidence];

describe('templateFamilies', () => {
  it('connected components over edges >= threshold, labelled by heaviest member', () => {
    const pairs = new Map([pe('A', 'B', 20), pe('B', 'C', 16), pe('C', 'D', 15.9), pe('D', 'E', 0)]);
    const w = new Map([['A', 0.1], ['B', 0.3], ['C', 0.05], ['D', 0.2], ['E', 0.01]]);
    const f = templateFamilies(pairs, ['A', 'B', 'C', 'D', 'E'], w);
    expect(f.map(x => [x.label, x.members])).toEqual([['B +2', ['A', 'B', 'C']], ['D', ['D']], ['E', ['E']]]);
    expect(f[0].weight).toBeCloseTo(0.45);
    expect(f[0].id).toBe('A,B,C');
  });
  it('unknown weights count as 0; ties break alphabetically', () => {
    const f = templateFamilies(new Map([pe('Y', 'X', 30)]), ['Y', 'X', 'Z'], new Map());
    expect(f.map(x => x.label)).toEqual(['X +1', 'Z']);
  });
});
