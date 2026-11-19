/**
 * Live stream: one stream per pool across collector replicas (the primary's, gap-filled by the next source while
 * it is silent) and exact copies once. Synthetic templates only.
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

const T = 1_700_000_000_000; // ms; arrival times are passed explicitly
const S = 1000;

describe('StreamTemplateDedup: one stream per pool', () => {
  it('forwards only the primary while it is active: per-connection jobs from another replica are dropped', () => {
    const d = new StreamTemplateDedup();
    for (let i = 0; i < 10; i++) {
      // each connection has its own jobs (other branches, other ntime): no exact copies
      expect(d.accept(tpl({ ntime: String(i), job_id: `a${i}` }), T + i * 30 * S)).toBe(true);
      expect(d.accept(tpl({ replica: 'b', ntime: String(i), merkle_branches: [branches[0], `${i}`.padStart(64, 'c')] }),
        T + i * 30 * S + 5 * S)).toBe(false);
    }
    expect(d.droppedSecondary).toBe(10);
    expect(d.dropped).toBe(0);
  });

  it('drops exact copies and near misses from another replica, whatever its per-connection fields', () => {
    const d = new StreamTemplateDedup();
    expect(d.accept(tpl(), T)).toBe(true);
    expect(d.accept(tpl({ replica: 'b', job_id: 'other', extranonce1: 'ff', coinbase1: 'cc', timestamp: '1' }), T + 10)).toBe(false);
    expect(d.accept(tpl({ site: 's2', replica: 'a' }), T + 20)).toBe(false); // another site, same template
    expect(d.accept(tpl({ replica: 'b', ntime: '66000001' }), T + 30)).toBe(false); // same job, other ntime
  });

  it('a secondary that arrives first is forwarded until the primary is seen (new connection, first message)', () => {
    const d = new StreamTemplateDedup();
    expect(d.accept(tpl({ replica: 'b' }), T)).toBe(true); // nothing known about a yet
    expect(d.accept(tpl({ replica: 'a' }), T + 5)).toBe(false); // a's exact copy of what b forwarded
    expect(d.accept(tpl({ replica: 'b', ntime: '1' }), T + 10)).toBe(false); // a is active now
    expect(d.accept(tpl({ replica: 'a', ntime: '2' }), T + 20)).toBe(true);
  });

  it('fills a primary outage with the secondary after 90 s of silence, and switches back when it returns', () => {
    const d = new StreamTemplateDedup();
    const a = (s: number) => d.accept(tpl({ ntime: `a${s}` }), T + s * S);
    const b = (s: number) => d.accept(tpl({ replica: 'b', ntime: `b${s}` }), T + s * S);
    expect(a(0)).toBe(true);
    expect(a(90)).toBe(true); // a's last before the outage
    expect(b(95)).toBe(false);
    expect(b(180)).toBe(false); // exactly 90 s: still active
    expect(b(181)).toBe(true); // silent for longer than 90 s: gap fill
    expect(b(300)).toBe(true);
    expect(a(400)).toBe(true); // back
    expect(b(401)).toBe(false);
    expect(d.droppedSecondary).toBe(3);
  });

  it('with three sources, the third is shown only while both lower ones are silent', () => {
    const d = new StreamTemplateDedup();
    const at = (site: string, replica: string, s: number) => d.accept(tpl({ site, replica, ntime: `${site}${replica}${s}` }), T + s * S);
    expect(at('s1', 'a', 0)).toBe(true);
    expect(at('s1', 'b', 10)).toBe(false);
    expect(at('s2', 'a', 20)).toBe(false);
    expect(at('s1', 'b', 100)).toBe(true); // a silent 100 s
    expect(at('s2', 'a', 120)).toBe(false); // b active
    expect(at('s2', 'a', 300)).toBe(true); // a and b silent
    expect(at('s1', 'a', 301)).toBe(true);
  });

  it('ranks by (site, replica), not by arrival order or registration', () => {
    const d = new StreamTemplateDedup();
    expect(d.accept(tpl({ site: 's2', replica: 'a', ntime: '1' }), T)).toBe(true);
    expect(d.accept(tpl({ site: 's1', replica: 'z', ntime: '2' }), T + 1)).toBe(true); // s1 < s2
    expect(d.accept(tpl({ site: 's2', replica: 'a', ntime: '3' }), T + 2)).toBe(false);
  });

  it('a switch-over does not show an exact template twice', () => {
    const d = new StreamTemplateDedup();
    expect(d.accept(tpl({ ntime: '1' }), T)).toBe(true);
    expect(d.accept(tpl({ replica: 'b', ntime: '2' }), T + 100 * S)).toBe(true); // a silent: b fills
    expect(d.accept(tpl({ ntime: '2' }), T + 101 * S)).toBe(false); // a returns with the template b just forwarded
    expect(d.accept(tpl({ ntime: '3' }), T + 102 * S)).toBe(true);
    expect(d.dropped).toBe(1);
  });

  it("forwards a source's own identical re-sends", () => {
    const d = new StreamTemplateDedup();
    for (let i = 0; i < 3; i++) expect(d.accept(tpl(), T + i)).toBe(true);
    expect(d.accept(tpl({ replica: 'b' }), T + 4)).toBe(false);
  });

  it('pools are independent', () => {
    const d = new StreamTemplateDedup();
    expect(d.accept(tpl(), T)).toBe(true);
    expect(d.accept(tpl({ pool_name: 'PoolB', replica: 'b' }), T + 1)).toBe(true);
  });

  it('never filters templates without site and replica (older collectors)', () => {
    const d = new StreamTemplateDedup();
    const legacy = tpl({ site: undefined, replica: undefined });
    for (let i = 0; i < 5; i++) expect(d.accept(legacy, T + i)).toBe(true);
    expect(d.accept(tpl({ site: 's1', replica: undefined }), T + 9)).toBe(true);
    expect(d.size()).toBe(0);
    expect(d.sourceCount()).toBe(0);
  });

  it('never filters a single source', () => {
    const d = new StreamTemplateDedup();
    for (let i = 0; i < 1000; i++) expect(d.accept(tpl({ ntime: String(i % 7), height: 100000 + (i % 5) }), T + i * 100)).toBe(true);
  });

  it('forgets the least recently seen height when a new one appears', () => {
    const d = new StreamTemplateDedup({ maxHeights: 2 });
    expect(d.accept(tpl({ height: 1, replica: 'b' }), T)).toBe(true);
    expect(d.accept(tpl({ height: 2, replica: 'b' }), T)).toBe(true);
    expect(d.accept(tpl({ height: 3, replica: 'b' }), T)).toBe(true); // height 1 forgotten
    expect(d.size()).toBe(2);
    expect(d.accept(tpl({ height: 2 }), T + 1)).toBe(false); // still remembered: a's copy of b's
    expect(d.accept(tpl({ height: 1 }), T + 2)).toBe(true); // forgotten: a late copy is shown, never hidden
  });

  it('keeps heights a pool alternates between (other chains on the same port)', () => {
    const d = new StreamTemplateDedup({ maxHeights: 2 });
    for (let i = 0; i < 10; i++) {
      expect(d.accept(tpl({ height: 100001, ntime: String(i) }), T + i)).toBe(true);
      expect(d.accept(tpl({ height: 6976415, ntime: String(i) }), T + i)).toBe(true);
      expect(d.accept(tpl({ height: 100001, ntime: String(i), replica: 'b' }), T + i)).toBe(false);
      expect(d.accept(tpl({ height: 6976415, ntime: String(i), replica: 'b' }), T + i)).toBe(false);
    }
  });

  it('bounds memory: keys and sources per pool, and pools', () => {
    const d = new StreamTemplateDedup({ maxKeysPerPool: 50, maxPools: 10, maxHeights: 3, maxSourcesPerPool: 4 });
    for (let p = 0; p < 40; p++) {
      for (let i = 0; i < 500; i++) {
        d.accept(tpl({ pool_name: `P${p}`, ntime: String(i), height: 100000 + (i % 4), replica: `r${i % 9}` }), T + i * 100 * S);
      }
    }
    expect(d.poolCount()).toBe(10);
    expect(d.size()).toBeLessThanOrEqual(10 * 50);
    expect(d.sourceCount()).toBeLessThanOrEqual(10 * 4);
    // The oldest keys went first; recent ones are still matched (all sources silent long enough to be forwarded).
    const late = T + 600 * 100 * S;
    expect(d.accept(tpl({ pool_name: 'P39', ntime: '499', height: 100003, replica: 'z' }), late)).toBe(false);
    expect(d.accept(tpl({ pool_name: 'P39', ntime: '0', height: 100000, replica: 'z' }), late)).toBe(true);
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

  it('forwards one stream per pool (gap-filled after 90 s of silence); legacy messages and blocks pass', async () => {
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

    let now = T;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const msgs: [number, Record<string, unknown>][] = [
      [0, tpl({ job_id: 'a1' })],
      [0, tpl({ job_id: 'b1', replica: 'b' })], // exact copy: dropped
      [0, tpl({ job_id: 'b2', replica: 'b', ntime: '66000001' })], // near miss, a active: dropped
      [0, tpl({ job_id: 'b3', replica: 'b', merkle_branches: [branches[1]] })], // b's own job, a active: dropped
      [0, tpl({ job_id: 'L1', site: undefined, replica: undefined })], // no site/replica: kept
      [0, tpl({ job_id: 'L2', site: undefined, replica: undefined })],
      [100 * 1000, tpl({ job_id: 'b4', replica: 'b', ntime: '66000100' })], // a silent for 100 s: gap fill
      [101 * 1000, tpl({ job_id: 'a5', ntime: '66000101' })], // a is back
      [102 * 1000, tpl({ job_id: 'b6', replica: 'b', ntime: '66000102' })], // dropped again
      [102 * 1000, { type: 'block', height: 100001 }],
    ];
    for (const [dt, m] of msgs) {
      now = T + dt;
      onMessage!({ content: Buffer.from(JSON.stringify(m)) });
    }
    while (!text.includes('"block"')) text += decoder.decode((await reader.read()).value);
    abort.abort();
    clock.mockRestore();

    const served = text.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
    expect(served.filter(m => m.job_id).map(m => m.job_id)).toEqual(['a1', 'L1', 'L2', 'b4', 'a5']);
    expect(channel.ack).toHaveBeenCalledTimes(msgs.length);
  });
});
