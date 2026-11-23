import { describe, expect, test } from 'vitest';
import { navItems } from '../navigationItems';

describe('navItems', () => {
  test('does not list the Infra page or the Pool clocks visual (both still served by URL)', () => {
    expect(navItems.some(item => item.href === '/infra')).toBe(false);
    expect(navItems.some(item => item.href === '/v/pool-clocks')).toBe(false);
    expect(navItems.some(item => item.href === '/servers' || item.label === 'Servers')).toBe(false);
    expect(navItems.some(item => item.href === '/latency' || item.label === 'Latency')).toBe(false);
  });

  test('lists the Forks page (formerly Unknown parents)', () => {
    expect(navItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: '/forks', label: 'Forks' }),
    ]));
    expect(navItems.some(item => item.href === '/unknown-parents')).toBe(false);
  });
});
