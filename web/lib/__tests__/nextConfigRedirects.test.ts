/** The former names of the Forks page redirect to it (next.config.mjs); Next.js keeps the query string (?range, ?parent). */
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config.mjs';

describe('next.config redirects', () => {
  it('sends /unknown-parents and /other-chains to /forks, permanently', async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects).toEqual(expect.arrayContaining([
      { source: '/unknown-parents', destination: '/forks', permanent: true },
      { source: '/other-chains', destination: '/forks', permanent: true },
    ]));
    // no redirect drops the query string or chains through the old page
    expect(redirects.every((r: { destination: string }) => r.destination === '/forks')).toBe(true);
  });
});
