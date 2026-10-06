import { expect, it } from 'vitest';
import { stack } from '../geometry';
it('stack normalises to 0..100', () => {
  expect(stack([{ key: 'a', w: 1 }, { key: 'b', w: 3 }])).toEqual([{ key: 'a', x0: 0, x1: 25 }, { key: 'b', x0: 25, x1: 100 }]);
});
