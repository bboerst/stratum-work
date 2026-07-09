import { describe, expect, test } from 'vitest';
import { navItems } from '../navigationItems';

describe('navItems', () => {
  test('uses the generic Infra page name for infrastructure metrics', () => {
    expect(navItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        href: '/infra',
        label: 'Infra',
        description: 'Realtime Stratum infrastructure metrics',
      }),
    ]));
    expect(navItems.some(item => item.href === '/servers' || item.label === 'Servers')).toBe(false);
    expect(navItems.some(item => item.href === '/latency' || item.label === 'Latency')).toBe(false);
  });
});
