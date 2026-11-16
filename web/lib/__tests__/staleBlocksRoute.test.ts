/**
 * /api/stale-blocks against mocked database functions (#180), plus the row mapping. MongoDB mode and disabled
 * history don't touch a database; responses are shared for the cache period; POOL_BLACKLIST applies only to template
 * summaries above the tip.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { staleRowToBlock, templateRowToSummary, type StaleBlock } from '../db/stale-blocks';

const block = (height: number, pools: string[]): StaleBlock => ({
  block_hash: 'aa'.repeat(32), height, prev_hash: 'bb'.repeat(32), timestamp: 1, first_seen: 2, chaintip_status: 'valid-fork',
  last_status: 'valid-fork', full_block: true, was_active: false, reorged_in_at: null, tx_count: 1, size: 2, weight: 3,
  coinbase_script_sig: '03', mining_pool: { name: 'Synthetic' }, reorg: null,
  templates: pools.map(pool => ({ pool, height: height + 1, templates: 2, first_template_at: 10, last_template_at: 20,
    node_switch_at: 15, mined_after_switch_ms: 5 })),
});

async function loadRoute({ historical = true, backend = 'postgres', blacklist = '', tip = 100 } = {}) {
  vi.resetModules();
  vi.stubEnv('POOL_BLACKLIST', blacklist);
  vi.stubEnv('DB_BACKEND', backend);
  const getRecentStaleBlocks = vi.fn(async () => [block(100, ['Public', 'Private']), block(98, ['Public', 'Private'])]);
  const getHighestBlock = vi.fn(async () => ({ height: tip }));
  vi.doMock('../db/blocks', () => ({ enableHistoricalData: historical, getHighestBlock }));
  vi.doMock('../db/stale-blocks', async importOriginal => ({ ...(await importOriginal<object>()), getRecentStaleBlocks }));
  const route = await import('../../app/api/stale-blocks/route');
  return { route, getRecentStaleBlocks, getHighestBlock };
}

const get = (route: { GET: (r: Request) => Promise<Response> }, qs = '') =>
  route.GET(new Request(`http://localhost/api/stale-blocks${qs}`));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../db/blocks');
  vi.doUnmock('../db/stale-blocks');
});

describe('GET /api/stale-blocks', () => {
  it('returns stale blocks with template summaries; blacklist only above the tip', async () => {
    const { route, getRecentStaleBlocks } = await loadRoute({ blacklist: 'Private', tip: 100 });
    const body = await (await get(route, '?n=5')).json();
    expect(getRecentStaleBlocks).toHaveBeenCalledWith(5);
    expect(body.supported).toBe(true);
    expect(body.tip).toBe(100);
    expect(body.stale_blocks.map((b: StaleBlock) => b.templates.map(t => t.pool)))
      .toEqual([['Public'], ['Public', 'Private']]);   // templates at 101 are above the tip; at 99 history
  });

  it('shares one read per n within the cache period and caps n', async () => {
    const { route, getRecentStaleBlocks } = await loadRoute();
    await get(route);
    await get(route);
    await get(route, '?n=1000');
    expect(getRecentStaleBlocks.mock.calls).toEqual([[20], [100]]);
  });

  it('rejects a bad n', async () => {
    const { route } = await loadRoute();
    expect((await get(route, '?n=0')).status).toBe(400);
    expect((await get(route, '?n=x')).status).toBe(400);
  });

  it('touches no database in MongoDB mode or with history disabled', async () => {
    for (const opts of [{ backend: 'mongodb' }, { historical: false }]) {
      const { route, getRecentStaleBlocks, getHighestBlock } = await loadRoute(opts);
      const body = await (await get(route)).json();
      expect(body.supported).toBe(false);
      expect(body.stale_blocks).toEqual([]);
      expect(getRecentStaleBlocks).not.toHaveBeenCalled();
      expect(getHighestBlock).not.toHaveBeenCalled();
    }
  });
});

describe('stale block row mapping', () => {
  it('maps bigint strings and the reorg', () => {
    const t = templateRowToSummary({ stale_block_hash: 'aa', height: 5, pool: 'P', templates: '3', first_ms: '1000',
      last_ms: '4000', switch_ms: '5000' });
    expect(t).toEqual({ pool: 'P', height: 5, templates: 3, first_template_at: 1000, last_template_at: 4000,
      node_switch_at: 5000, mined_after_switch_ms: -1000 });
    expect(templateRowToSummary({ ...{ stale_block_hash: 'aa', height: 5, pool: 'P', templates: 1, first_ms: 1, last_ms: 2 },
      switch_ms: null }).mined_after_switch_ms).toBeNull();
    const b = staleRowToBlock({ block_hash: 'aa', height: 4, prev_hash: 'bb', block_time_s: '7', first_seen_ms: '8',
      chaintip_status: 'valid-fork', last_status: 'valid-fork', full_block: false, was_active: true, reorged_in_ms: null,
      tx_count: null, size: null, weight: null, coinbase_script_sig: null, mining_pool: null, reorg_id: '3',
      reorg_detected_ms: '9', reorg_depth: 1, reorg_fork_height: 3, reorg_new_tip_hash: 'cc' }, [t]);
    expect(b.timestamp).toBe(7);
    expect(b.reorg).toEqual({ id: 3, detected_at: 9, depth: 1, fork_height: 3, new_tip_hash: 'cc' });
    expect(b.templates).toEqual([t]);
  });
});
