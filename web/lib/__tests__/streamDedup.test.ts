/**
 * Live stream de-duplication across collector replicas (#178): only exact copies from another source are dropped.
 * Synthetic templates only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { StreamTemplateDedup } from '../streamDedup';

const branches = ['aa'.repeat(32), 'bb'.repeat(32)];

function tpl(over: Record<string, unknown> = {}) {
  return {
    pool_name: 'PoolA', height: 100001, prev_hash: '11'.repeat(32), merkle_branches: branches, version: '20000000',
    nbits: '17034219', ntime: '66000000', job_id: 'j1', extranonce1: '00', site: 's1', replica: 'a', ...over,
  };
}

describe('StreamTemplateDedup', () => {
  it('drops an exact copy from another replica, whatever its per-connection fields', () => {
    const d = new StreamTemplateDedup();
    expect(d.accept(tpl())).toBe(true);
    expect(d.accept(tpl({ replica: 'b', job_id: 'other', extranonce1: 'ff', coinbase1: 'cc', timestamp: '1' }))).toBe(false);
    expect(d.accept(tpl({ site: 's2', replica: 'a' }))).toBe(false); // another site, same template
    expect(d.dropped).toBe(2);
  });

  it('keeps the copy that arrives first, from either replica', () => {
    const d = new StreamTemplateDedup();
    expect(d.accept(tpl({ replica: 'b' }))).toBe(true);
    expect(d.accept(tpl({ replica: 'a' }))).toBe(false);
  });

  it('keeps near misses: any one key field differs', () => {
    const d = new StreamTemplateDedup();
    expect(d.accept(tpl())).toBe(true);
    const b = { replica: 'b' };
    expect(d.accept(tpl({ ...b, ntime: '66000001' }))).toBe(true);
    expect(d.accept(tpl({ ...b, merkle_branches: [branches[0], 'cc'.repeat(32)] }))).toBe(true);
    expect(d.accept(tpl({ ...b, merkle_branches: [branches[1], branches[0]] }))).toBe(true); // order matters
    expect(d.accept(tpl({ ...b, merkle_branches: [branches[0]] }))).toBe(true);
    expect(d.accept(tpl({ ...b, version: '20000004' }))).toBe(true);
    expect(d.accept(tpl({ ...b, nbits: '17034220' }))).toBe(true);
    expect(d.accept(tpl({ ...b, prev_hash: '22'.repeat(32) }))).toBe(true);
    expect(d.accept(tpl({ ...b, height: 100002 }))).toBe(true);
    expect(d.accept(tpl({ ...b, pool_name: 'PoolB' }))).toBe(true);
    expect(d.dropped).toBe(0);
  });

  it('keeps gap fills: a template only one replica received', () => {
    const d = new StreamTemplateDedup();
    expect(d.accept(tpl({ ntime: '66000000' }))).toBe(true);
    expect(d.accept(tpl({ replica: 'b', ntime: '66000000' }))).toBe(false);
    expect(d.accept(tpl({ replica: 'b', ntime: '66000010' }))).toBe(true); // replica a was disconnected
    expect(d.accept(tpl({ replica: 'a', ntime: '66000020' }))).toBe(true);
  });

  it("forwards a source's own identical re-sends, and pairs copies one-to-one", () => {
    const d = new StreamTemplateDedup();
    expect(d.accept(tpl())).toBe(true);
    expect(d.accept(tpl())).toBe(true); // replica a re-sends the identical template: shown, as with one collector
    expect(d.accept(tpl({ replica: 'b' }))).toBe(false); // b's 1st copy pairs with a's 1st
    expect(d.accept(tpl({ replica: 'b' }))).toBe(false); // b's 2nd with a's 2nd
    expect(d.accept(tpl({ replica: 'b' }))).toBe(true); // b's 3rd has no partner: extra, shown
    expect(d.accept(tpl())).toBe(false); // a's 3rd pairs with b's 3rd
  });

  it('never filters templates without site and replica (one collector per pool, MongoDB mode)', () => {
    const d = new StreamTemplateDedup();
    const legacy = tpl({ site: undefined, replica: undefined });
    for (let i = 0; i < 5; i++) expect(d.accept(legacy)).toBe(true);
    expect(d.accept(tpl({ site: 's1', replica: undefined }))).toBe(true);
    expect(d.size()).toBe(0);
  });

  it('never filters a single source', () => {
    const d = new StreamTemplateDedup();
    for (let i = 0; i < 1000; i++) expect(d.accept(tpl({ ntime: String(i % 7), height: 100000 + (i % 5) }))).toBe(true);
  });

  it('forgets the least recently seen height when a new one appears', () => {
    const d = new StreamTemplateDedup({ maxHeights: 2 });
    expect(d.accept(tpl({ height: 1 }))).toBe(true);
    expect(d.accept(tpl({ height: 2 }))).toBe(true);
    expect(d.accept(tpl({ height: 3 }))).toBe(true); // height 1 forgotten
    expect(d.size()).toBe(2);
    expect(d.accept(tpl({ height: 2, replica: 'b' }))).toBe(false); // still remembered
    expect(d.accept(tpl({ height: 1, replica: 'b' }))).toBe(true); // forgotten: a late copy is shown, never hidden
  });

  it('keeps heights a pool alternates between (other chains on the same port)', () => {
    const d = new StreamTemplateDedup({ maxHeights: 2 });
    for (let i = 0; i < 10; i++) {
      expect(d.accept(tpl({ height: 100001, ntime: String(i) }))).toBe(true);
      expect(d.accept(tpl({ height: 6976415, ntime: String(i) }))).toBe(true);
      expect(d.accept(tpl({ height: 100001, ntime: String(i), replica: 'b' }))).toBe(false);
      expect(d.accept(tpl({ height: 6976415, ntime: String(i), replica: 'b' }))).toBe(false);
    }
  });

  it('bounds memory: keys per pool and pools', () => {
    const d = new StreamTemplateDedup({ maxKeysPerPool: 50, maxPools: 10, maxHeights: 3 });
    for (let p = 0; p < 40; p++) {
      for (let i = 0; i < 500; i++) d.accept(tpl({ pool_name: `P${p}`, ntime: String(i), height: 100000 + (i % 4) }));
    }
    expect(d.poolCount()).toBe(10);
    expect(d.size()).toBeLessThanOrEqual(10 * 50);
    // The oldest keys went first; recent ones are still matched.
    expect(d.accept(tpl({ pool_name: 'P39', ntime: '499', height: 100003, replica: 'b' }))).toBe(false);
    expect(d.accept(tpl({ pool_name: 'P39', ntime: '0', height: 100000, replica: 'b' }))).toBe(true);
  });
});

describe('/api/stream de-duplicates replicas', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('EXTRANONCE1_MASK_KEY', 'route-test-key');
    vi.stubEnv('POOL_BLACKLIST', '');
    vi.stubEnv('STREAM_POOL_RATE', '0');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../rabbitmq');
  });

  it('forwards each exact template once; near misses, gap fills, legacy messages and blocks pass', async () => {
    let onMessage: ((msg: { content: Buffer } | null) => void) | undefined;
    const channel = {
      assertQueue: vi.fn(async () => ({ queue: 'q' })),
      bindQueue: vi.fn(async () => {}),
      consume: vi.fn(async (_q: string, cb: typeof onMessage) => { onMessage = cb; return { consumerTag: 't' }; }),
      ack: vi.fn(), cancel: vi.fn(async () => {}), deleteQueue: vi.fn(async () => {}), close: vi.fn(async () => {}),
    };
    vi.doMock('../rabbitmq', () => ({
      RABBITMQ_EXCHANGES: ['x'],
      createRabbitmqChannel: vi.fn(async () => ({ channel, connection: { close: vi.fn(async () => {}) } })),
    }));
    const { GET } = await import('../../app/api/stream/route');
    const abort = new AbortController();
    const response = await GET(new NextRequest('http://test/api/stream', { signal: abort.signal }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(onMessage).toBeDefined();

    const msgs = [
      tpl({ job_id: 'a1' }),
      tpl({ job_id: 'b1', replica: 'b' }), // exact copy: dropped
      tpl({ job_id: 'b2', replica: 'b', ntime: '66000001' }), // near miss: kept
      tpl({ job_id: 'b3', replica: 'b', prev_hash: '33'.repeat(32) }), // gap fill: kept
      tpl({ job_id: 'L1', site: undefined, replica: undefined }), // no site/replica: kept
      tpl({ job_id: 'L2', site: undefined, replica: undefined }),
      { type: 'block', height: 100001 },
    ];
    for (const m of msgs) onMessage!({ content: Buffer.from(JSON.stringify(m)) });
    while (!text.includes('"block"')) text += decoder.decode((await reader.read()).value);
    abort.abort();

    const served = text.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    expect(served.filter(m => m.job_id).map(m => m.job_id)).toEqual(['a1', 'b2', 'b3', 'L1', 'L2']);
    expect(channel.ack).toHaveBeenCalledTimes(msgs.length);
  });
});
