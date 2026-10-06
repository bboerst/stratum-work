import { describe, expect, it } from 'vitest';
import { VISUALS } from '../registry';
describe('registry', () => {
  it('ids are unique, kebab-case, and every schema key has a default', () => {
    const ids = VISUALS.map(v => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of VISUALS) {
      expect(v.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      for (const f of v.paramsSchema) expect(v.defaultParams).toHaveProperty(f.key);
    }
  });
});
