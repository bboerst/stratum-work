import { describe, expect, it } from 'vitest';
import { createBlacklist } from '../blacklist.js';

describe('createBlacklist', () => {
  it('matches trimmed comma-separated names exactly', () => {
    const bl = createBlacklist(' Foundry USA , X ');
    expect(bl('Foundry USA')).toBe(true);
    expect(bl('foundry usa')).toBe(false);
    expect(bl(undefined)).toBe(false);
  });
  it('empty env blocks nothing', () => expect(createBlacklist(undefined)('A')).toBe(false));
});
