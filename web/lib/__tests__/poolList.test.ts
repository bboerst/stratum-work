import { describe, expect, it } from 'vitest';
import { poolListFromKey, poolListKey, sortPoolNames } from '../poolList';

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
});
