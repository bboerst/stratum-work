/**
 * /api/template-providers against a mocked read: 404 with historical data disabled (no database touched) and while
 * nothing is counted, range validation and narrowing (the epoch columns only; "now", pies and legend unchanged),
 * POOL_BLACKLIST and POOL_OWN_TEMPLATE_CREATORS passed through, and the summary cache (one read per period, served
 * stale while a refresh runs, a failure not kept).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInputs } from '../templateProviders';

const E = 450;
const inputs = (epochs: number): Omit<ProviderInputs, 'ownCreatorPrefixes'> => ({
  counted: Array.from({ length: epochs }, (_, i) => ({ epoch: E + i, heights: 2016 })),
  nodes: Array.from({ length: epochs }, (_, i) => ({ epoch: E + i, feed: 'feed-1', pool_id: 1, sets: 10, templates: 10 })),
  pairs: [],
  blocks: Array.from({ length: epochs }, (_, i) => ({ height: (E + i) * 2016 + 1, pool_id: 1, pool: 'Pool A', creator: i === 0 ? 'OWN-1' : null, time_ms: 1e12 + i })),
  poolNames: new Map([[1, 'Pool A']]),
});

async function load(o: { historical?: string; read?: ReturnType<typeof vi.fn> } = {}) {
  vi.resetModules();
  process.env.ENABLE_HISTORICAL_DATA = o.historical ?? 'true';
  process.env.POOL_BLACKLIST = 'feed-x';
  process.env.POOL_OWN_TEMPLATE_CREATORS = 'OWN, OTHER';
  const read = o.read ?? vi.fn().mockResolvedValue(inputs(30));
  vi.doMock('../db/template-providers', () => ({ getTemplateProviderInputs: read }));
  const route = await import('../../app/api/template-providers/route');
  const get = async (q = '') => {
    const res = await route.GET(new Request(`http://localhost/api/template-providers${q}`));
    return { status: res.status, body: await res.json() };
  };
  return { get, read };
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('../db/template-providers');
  delete process.env.POOL_BLACKLIST;
  delete process.env.POOL_OWN_TEMPLATE_CREATORS;
  process.env.ENABLE_HISTORICAL_DATA = 'true';
});

describe('/api/template-providers', () => {
  it('404 with historical data disabled, without a read', async () => {
    const { get, read } = await load({ historical: 'false' });
    expect((await get()).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it('404 while nothing is counted', async () => {
    const { get } = await load({ read: vi.fn().mockResolvedValue({ ...inputs(0), counted: [] }) });
    expect((await get()).status).toBe(404);
  });

  it('404 before the migration has created the tables', async () => {
    const missing = Object.assign(new Error('relation "template_set_heights" does not exist'), { code: '42P01' });
    const { get } = await load({ read: vi.fn().mockRejectedValue(missing) });
    expect((await get()).status).toBe(404);
    const other = await load({ read: vi.fn().mockRejectedValue(new Error('timeout')) });
    expect((await other.get()).status).toBe(500);
  });

  it('passes the excluded feeds and the own-creator prefixes', async () => {
    const { get, read } = await load();
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(read).toHaveBeenCalledWith(['feed-x']);
    // the first epoch's block names an own creator: the pool's, not miner-built
    expect(body.columns[0].groups.map((g: { kind: string }) => g.kind)).toEqual(['producer']);
  });

  it('range narrows the epoch columns only', async () => {
    const { get } = await load();
    const all = (await get()).body;
    expect(all.columns).toHaveLength(31);
    expect(all.range).toBe('all');
    const six = (await get('?range=6e')).body;
    expect(six.columns.map((c: { label: string }) => c.label)).toEqual([...all.columns.slice(24, 30).map((c: { label: string }) => c.label), 'now']);
    expect(six.pies).toEqual(all.pies);
    expect(six.legend).toEqual(all.legend);
    expect((await get('?range=26e')).body.columns).toHaveLength(27);
    expect((await get('?range=90d')).status).toBe(400);
  });

  it('reads once per period, serves stale while refreshing, and does not keep a failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const read = vi.fn().mockResolvedValue(inputs(2));
    const { get } = await load({ read });
    await get(); await get('?range=6e');
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    let release!: (v: unknown) => void;
    read.mockReturnValueOnce(new Promise(r => { release = r; }));
    const stale = await get();                     // the refresh is running: the previous result
    expect(stale.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(2);
    release(inputs(3));
    await new Promise(r => setTimeout(r, 0));
    expect((await get()).body.columns).toHaveLength(4);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    read.mockRejectedValueOnce(new Error('db down'));
    expect((await get()).body.columns).toHaveLength(4);   // stale while the failing refresh runs
    await new Promise(r => setTimeout(r, 0));
    read.mockResolvedValueOnce(inputs(5));
    expect((await get()).body.columns).toHaveLength(4);   // the failure wasn't kept: a new refresh started
    await new Promise(r => setTimeout(r, 0));
    expect(read).toHaveBeenCalledTimes(4);
    expect((await get()).body.columns).toHaveLength(6);
  });
});
