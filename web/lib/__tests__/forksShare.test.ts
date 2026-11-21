/**
 * The Forks pages' server side with synthetic data: a short link resolved (found, 404, nothing to read), its metadata
 * (title, description, canonical, OpenGraph, Twitter card), the origin from the request, and old /forks?parent= links
 * redirected (308) to the short link by the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Episode } from '../unknownParents';
import type { ShareRange } from '../forksPath';

const hdrs = new Map<string, string>();
vi.mock('next/headers', () => ({ headers: async () => ({ get: (k: string) => hdrs.get(k) ?? null }) }));

const ep = (o: Partial<Episode> & Pick<Episode, 'parent' | 'height' | 'kind'>): Episode => ({
  heights: [o.height], pools: [{ pool: 'Pool A', connections: ['a'], templates: 5 }, { pool: 'Pool B', connections: ['a'], templates: 5 }],
  first_ms: 1000, last_ms: 73_000, duration_ms: 72_000, templates: 10, auxpow_templates: 0, auxpow_share: 0,
  facts: {
    tip_at_first: o.height - 1, tip_at_last: o.height - 1, tip_offset: 0, nbits: [], bitcoin_bits: null, bitcoin_bits_at: null,
    bitcoin_difficulty: true, pow_ok: true, pow_bits: '', in_stale_blocks: o.kind === 'stale', stale_block: null,
  },
  invalid_coinbase: null, ...o,
});
const RACE = ep({ parent: '00'.repeat(28) + 'aa'.repeat(4), height: 976175, kind: 'stale' });
const OTHER = ep({ parent: '00'.repeat(28) + 'bb'.repeat(4), height: 976175, kind: 'other_chain' });
const OLD = ep({ parent: '00'.repeat(28) + 'cc'.repeat(4), height: 900000, kind: 'bitcoin_block' });
const data: Record<ShareRange, Episode[]> = { '6e': [OTHER, RACE], '26e': [OTHER, RACE], all: [OTHER, RACE, OLD] };
const load = async (r: ShareRange) => data[r];

afterEach(() => { hdrs.clear(); vi.unstubAllEnvs(); vi.resetModules(); vi.doUnmock('../forksSummary'); vi.doUnmock('next/navigation'); });

describe('resolveSegments', () => {
  it('finds the episode, its range and its canonical short path', async () => {
    const { resolveSegments } = await import('../forksShare');
    expect(await resolveSegments(['976175'], load)).toMatchObject({ status: 'found', range: '6e', episode: RACE, canonical: '/forks/976175', exact: true });
    expect(await resolveSegments(['976175', 'other-chain'], load)).toMatchObject({ status: 'found', episode: OTHER, canonical: '/forks/976175/other-chain' });
    expect(await resolveSegments(['900000'], load)).toMatchObject({ status: 'found', range: 'all', episode: OLD });
    // a kind that isn't there: the height's most notable episode, canonical to its own path
    expect(await resolveSegments(['900000', 'race'], load)).toMatchObject({ status: 'found', episode: OLD, canonical: '/forks/900000', exact: false });
  });
  it('tells a 404 from nothing to read', async () => {
    const { resolveSegments } = await import('../forksShare');
    expect(await resolveSegments(['12345'], load)).toEqual({ status: 'none' });
    expect(await resolveSegments(['abc'], load)).toEqual({ status: 'invalid' });
    expect(await resolveSegments(['976175'], async () => null)).toEqual({ status: 'no-data' });
  });
});

describe('metadata', () => {
  it("names the episode, with a canonical URL and a large-image card on the request's origin", async () => {
    const { episodeMetadata, resolveSegments, siteOrigin } = await import('../forksShare');
    hdrs.set('host', 'internal:3000').set('x-forwarded-host', 'example.org').set('x-forwarded-proto', 'https');
    const origin = await siteOrigin();
    expect(origin?.href).toBe('https://example.org/');
    const m = episodeMetadata(await resolveSegments(['976175', 'other-chain'], load), origin);
    expect(m.title).toEqual({ absolute: 'Other chain at 976,175 · 2 pools · stratum.work' });
    expect(m.description).toBe("Height 976,175: 2 pools built on another chain's block for 72s (10 templates).");
    expect(m.alternates?.canonical).toBe('/forks/976175/other-chain');
    expect(String(m.metadataBase)).toBe('https://example.org/');
    expect(m.openGraph).toMatchObject({ title: 'Other chain at 976,175 · 2 pools · stratum.work', url: '/forks/976175/other-chain' });
    expect(m.twitter).toMatchObject({ card: 'summary_large_image', title: 'Other chain at 976,175 · 2 pools · stratum.work' });
  });
  it('falls back to the Forks page itself without an episode', async () => {
    const { episodeMetadata } = await import('../forksShare');
    const m = episodeMetadata({ status: 'no-data' }, undefined);
    expect(m.title).toEqual({ absolute: 'Forks · stratum.work' });
    expect(m.alternates?.canonical).toBe('/forks');
  });
  it('takes the origin from SITE_URL, else Host', async () => {
    const { siteOrigin } = await import('../forksShare');
    hdrs.set('host', 'localhost:3000');
    expect((await siteOrigin())?.href).toBe('http://localhost:3000/');
    vi.stubEnv('SITE_URL', 'https://example.net');
    expect((await siteOrigin())?.href).toBe('https://example.net/');
  });
});

describe('old /forks?parent= links', () => {
  it('map to the short link (the link range tried first), else nothing', async () => {
    const { legacyParentPath } = await import('../forksLegacy');
    expect(await legacyParentPath({ parent: RACE.parent }, load)).toBe('/forks/976175');
    expect(await legacyParentPath({ parent: OTHER.parent.toUpperCase(), range: '90d' }, load)).toBe('/forks/976175/other-chain');
    expect(await legacyParentPath({ parent: OLD.parent, range: 'all' }, load)).toBe('/forks/900000');
    expect(await legacyParentPath({ parent: 'ff'.repeat(32) }, load)).toBeNull();
    expect(await legacyParentPath({ parent: 'xyz' }, load)).toBeNull();
    expect(await legacyParentPath({ range: '6e' }, load)).toBeNull();
    expect(await legacyParentPath({ parent: RACE.parent }, async () => null)).toBeNull();
  });
  it('redirect permanently from the /forks page', async () => {
    vi.doMock('../forksSummary', () => ({ loadEpisodes: load }));
    const permanentRedirect = vi.fn((url: string) => { throw new Error(`redirect ${url}`); });
    vi.doMock('next/navigation', async orig => ({ ...(await orig<object>()), permanentRedirect }));
    const { default: ForksPage } = await import('../../app/forks/page');
    await expect(ForksPage({ searchParams: Promise.resolve({ parent: OTHER.parent, range: '26e' }) })).rejects.toThrow('redirect /forks/976175/other-chain');
    expect(permanentRedirect).toHaveBeenCalledWith('/forks/976175/other-chain');
    permanentRedirect.mockClear();
    await ForksPage({ searchParams: Promise.resolve({ parent: 'ff'.repeat(32) }) });   // unknown: the page, as before
    await ForksPage({ searchParams: Promise.resolve({}) });
    expect(permanentRedirect).not.toHaveBeenCalled();
  });
});
