import { expect, it } from 'vitest';
import { contentColor } from '../colorUtils';

it('contentColor is stable and hsl', () => {
  expect(contentColor('abc')).toBe(contentColor('abc'));
  expect(contentColor('abc')).toMatch(/^hsl\(\d+, 70%, 50%\)$/);
});
