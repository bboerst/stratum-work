import { describe, expect, it } from 'vitest';
import { collectPoolNames, poolListFromKey, poolListKey, sortPoolNames } from '../poolList';

describe('pool list', () => {
  it('sorts case-insensitively, as the pool filter always has', () => {
    const names = ['b pool', 'Alpha', 'alpha2', 'Zeta', 'beta'];
    expect(sortPoolNames(new Set(names))).toEqual(
      [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    );
  });

  it('round-trips through its key, including the empty list', () => {
    for (const list of [[], ['A'], ['A', 'B c', 'd|e'], ['']]) {
      expect(poolListFromKey(poolListKey(list))).toEqual(list);
    }
  });

  it('gives equal keys only for equal lists', () => {
    expect(poolListKey(['A', 'B'])).toBe(poolListKey(['A', 'B']));
    expect(poolListKey(['A', 'B'])).not.toBe(poolListKey(['B', 'A']));
    expect(poolListKey(['AB'])).not.toBe(poolListKey(['A', 'B']));
    expect(poolListKey([])).not.toBe(poolListKey(['']));
  });

  it('includes pools only in the template buffer (the initial load), before any live template', () => {
    const buffer = [{ data: { pool_name: 'Zeta' } }, { data: { pool_name: 'alpha' } }, { data: { pool_name: null } }];
    expect(collectPoolNames([], [], buffer)).toEqual(['alpha', 'Zeta']);
  });

  it('merges the stream, the latest-per-pool map and the buffer without duplicates', () => {
    expect(collectPoolNames(['B', null, 'A'], ['A', 'C'], [{ data: { pool_name: 'B' } }, { data: { pool_name: 'D' } }]))
      .toEqual(['A', 'B', 'C', 'D']);
  });
});
