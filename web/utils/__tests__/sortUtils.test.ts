import { describe, expect, it } from 'vitest';
import { sortRowsByKey } from '../sortUtils';

const row = (pool_name: string, value: number, timestamp = '00') => ({ pool_name, value, timestamp });

describe('sortRowsByKey tiebreak', () => {
  it('orders rows with equal keys by pool name, whatever the arrival order', () => {
    const a = [row('Pool C', 5), row('Pool A', 5), row('Pool B', 5), row('Pool D', 9)];
    const b = [row('Pool B', 5), row('Pool D', 9), row('Pool C', 5), row('Pool A', 5)];
    const names = (rows: ReturnType<typeof row>[]) => rows.map(r => r.pool_name);
    expect(names(sortRowsByKey(a, 'value', 'desc'))).toEqual(['Pool D', 'Pool A', 'Pool B', 'Pool C']);
    expect(names(sortRowsByKey(b, 'value', 'desc'))).toEqual(['Pool D', 'Pool A', 'Pool B', 'Pool C']);
    // ties stay ascending by name when the key is sorted ascending too
    expect(names(sortRowsByKey(a, 'value', 'asc'))).toEqual(['Pool A', 'Pool B', 'Pool C', 'Pool D']);
  });

  it('only breaks ties: a different key still decides', () => {
    const rows = [row('Pool A', 1), row('Pool Z', 2)];
    expect(sortRowsByKey(rows, 'value', 'desc').map(r => r.pool_name)).toEqual(['Pool Z', 'Pool A']);
  });

  it('leaves rows without a pool name in their comparator order', () => {
    const rows = [{ value: 1 }, { value: 1 }];
    expect(sortRowsByKey(rows, 'value', 'desc')).toEqual(rows);
  });
});
