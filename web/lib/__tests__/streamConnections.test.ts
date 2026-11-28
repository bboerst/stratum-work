/**
 * `?connections=all` (#321): which hidden templates are a connection's distinct work (lib/streamConnections.ts), the
 * connection letters (lib/connectionRanks.ts), the per-connection throttle, the hub's delivery, and that the views'
 * stream hook ignores the new messages.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamConnections, STREAM_LEAD_MS, type ConnectionEvent } from '../streamConnections';
import { ConnectionRanks } from '../connectionRanks';
import { PoolStreamThrottle } from '../streamThrottle';
import { CONNECTION_MESSAGE_TYPES, isConnectionMessage } from '../useDataStream';

const T = 1_000_000;
const H = STREAM_LEAD_MS;

const tpl = (replica: string, o: { ntime?: string; branches?: string[]; height?: number; pool?: string; site?: string } = {}) => ({
  pool_name: o.pool ?? 'P', height: o.height ?? 10, site: o.site ?? 's1', replica, prev_hash: 'aa',
  merkle_branches: o.branches ?? ['11'], version: '20000000', nbits: '1d00ffff', ntime: o.ntime ?? '01',
});

/** One template per [at, replica, overrides, shown]; returns every event judged by `until`. */
function run(seq: [number, string, Parameters<typeof tpl>[1]?, boolean?][], until: number, c = new StreamConnections()) {
  c.reset(T - 60_000);
  const out: ConnectionEvent[] = [];
  for (const [at, replica, o, shown] of [...seq].sort((a, b) => a[0] - b[0])) {
    out.push(...c.tick(T + at));
    c.observe(tpl(replica, o), `${replica}@${at}`, shown ?? replica === 'a', T + at);
  }
  out.push(...c.tick(T + until));
  return out.map(e => `${e.kind}:${e.replica}${e.data ? `:${e.data}` : ''}`);
}

describe('StreamConnections', () => {
  it('an exact copy on another connection within ±10 s is not distinct, whichever arrives first', () => {
    expect(run([[0, 'a'], [3_000, 'b']], 60_000)).toEqual([]);
    expect(run([[5_000, 'a'], [0, 'b']], 60_000)).toEqual([]);
    expect(run([[0, 'a'], [H, 'b']], 60_000)).toEqual([]); // the window is inclusive
  });

  it('a template no other connection received within the window is distinct, sent once the window has passed', () => {
    const c = new StreamConnections();
    c.reset(T - 60_000);
    c.observe(tpl('b', { branches: ['22'] }), 'b-other-job', false, T);
    expect(c.tick(T + H - 1)).toEqual([]);
    expect(c.tick(T + H).map(e => [e.kind, e.replica, e.data])).toEqual([['template', 'b', 'b-other-job']]);
    expect(run([[0, 'a'], [H + 1, 'b']], 60_000)).toEqual([`template:b:b@${H + 1}`]); // just outside
  });

  it('matches exactly: another ntime, branch list or height is another template (no tolerance)', () => {
    expect(run([[0, 'a', { ntime: '01' }], [100, 'b', { ntime: '02' }]], 60_000)).toEqual(['template:b:b@100']);
    expect(run([[0, 'a', { branches: ['11', '22'] }], [100, 'b', { branches: ['22', '11'] }]], 60_000)).toEqual(['template:b:b@100']);
    expect(run([[0, 'a', { height: 10 }], [100, 'b', { height: 11 }]], 60_000)).toEqual(['template:b:b@100']);
    // Another pool's identical template doesn't count.
    expect(run([[0, 'a', { pool: 'Q' }, true], [100, 'b']], 60_000)).toEqual(['template:b:b@100']);
  });

  it('a copy on any other connection counts, not only the shown one', () => {
    expect(run([[0, 'b'], [100, 'c']], 60_000)).toEqual([]);
  });

  it('a connection\'s own re-send is not a copy', () => {
    expect(run([[0, 'b'], [100, 'b']], 60_000)).toEqual(['template:b:b@0', 'template:b:b@100']);
  });

  it('sends a notice when a distinct connection gets a copy again, and only then', () => {
    expect(run([
      [0, 'a', { ntime: '01' }], [50, 'b', { ntime: '02' }],     // b distinct
      [20_000, 'a', { ntime: '03' }], [20_050, 'b', { ntime: '03' }], // b a copy again: notice
      [40_000, 'a', { ntime: '04' }], [40_050, 'b', { ntime: '04' }], // still a copy: nothing
    ], 90_000)).toEqual(['template:b:b@50', 'copy:b']);
  });

  it('sends the notice when the distinct connection becomes the shown stream', () => {
    expect(run([[0, 'b', { ntime: '02' }], [100_000, 'b', { ntime: '03' }, true]], 200_000)).toEqual(['template:b:b@0', 'copy:b']);
  });

  it('never calls a shown template distinct', () => {
    expect(run([[0, 'a', { ntime: '09' }]], 60_000)).toEqual([]);
  });

  it('does not judge templates in the first window after a reset (their copies may have come before)', () => {
    const c = new StreamConnections();
    c.reset(T);
    c.observe(tpl('b', { ntime: '02' }), 'early', false, T + H - 1);
    c.observe(tpl('b', { ntime: '03' }), 'late', false, T + H);
    expect(c.tick(T + 3 * H).map(e => e.data)).toEqual(['late']);
  });

  it('stays bounded: received templates, pending ones and pools', () => {
    const c = new StreamConnections({ maxEntriesPerPool: 50, maxPendingPerPool: 20, maxPools: 3 });
    c.reset(T - 60_000);
    for (let i = 0; i < 500; i++) c.observe(tpl('b', { ntime: String(i) }), String(i), false, T + i);
    expect(c.size()).toBe(50);
    expect(c.pendingCount()).toBe(20);
    expect(c.droppedPending).toBe(480);
    expect(c.tick(T + 500 + H).map(e => e.data)).toEqual(Array.from({ length: 20 }, (_, i) => String(480 + i)));
    for (const p of ['Q1', 'Q2', 'Q3', 'Q4']) c.observe(tpl('b', { pool: p }), p, false, T + 1_000);
    expect(c.poolCount()).toBe(3);
    // Received templates age out after 2 × the window once nothing pending needs them; idle pools are forgotten.
    c.tick(T + 1_000 + 3 * H);
    expect(c.size()).toBe(0);
    expect(c.pendingCount()).toBe(0);
  });
});

describe('ConnectionRanks', () => {
  it('gives the ranked letter, null while unknown, and refreshes on a miss at most every retry interval', async () => {
    let rows = [{ name: 'P', site: 's1', replica: 'a', conn: 1 }, { name: 'P', site: 's2', replica: 'a', conn: 3 }];
    const loader = vi.fn(async () => rows);
    const r = new ConnectionRanks(loader, 300_000, 30_000);
    expect(r.letter('P', 's1', 'a', 0)).toBeNull(); // not loaded yet: starts a load, never waits
    await r.refresh(0);
    expect(r.letter('P', 's1', 'a', 1)).toBe('a');
    expect(r.letter('P', 's2', 'a', 1)).toBe('c');
    expect(loader).toHaveBeenCalledTimes(1);
    rows = [...rows, { name: 'P', site: 's1', replica: 'b', conn: 2 }];
    expect(r.letter('P', 's1', 'b', 10_000)).toBeNull(); // a new collector: within the retry interval, no reload
    expect(loader).toHaveBeenCalledTimes(1);
    r.letter('P', 's1', 'b', 30_000);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    await r.refresh(60_000);
    expect(r.letter('P', 's1', 'b', 60_001)).toBe('b');
  });

  it('keeps the previous ranking when a load fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = false;
    const r = new ConnectionRanks(async () => { if (fail) throw new Error('db down'); return [{ name: 'P', site: 's', replica: 'a', conn: 1 }]; });
    await r.refresh(0);
    fail = true;
    await r.refresh(1);
    expect(r.letter('P', 's', 'a', 2)).toBe('a');
    err.mockRestore();
  });
});

describe('PoolStreamThrottle per connection', () => {
  it('gives a pool\'s other connection its own rate and its own marker type', () => {
    const t = new PoolStreamThrottle({ ratePerSecond: 1, burst: 2 });
    expect(t.offer('P', 'p1', 0)).toEqual(['p1']);
    expect(t.offer('P', 'p2', 0)).toEqual(['p2']);
    expect(t.offer('P', 'b1', 0, 'b')).toEqual(['b1']); // not limited by the pool's used-up rate
    expect(t.offer('P', 'b2', 0, 'b')).toEqual(['b2']);
    expect(t.offer('P', 'b3', 0, 'b')).toEqual([]);
    expect(t.offer('P', 'b4', 0, 'b')).toEqual([]);
    const out = t.tick(1_000);
    expect(out.map(o => o.startsWith('{') ? JSON.parse(o) : o)).toEqual([
      { type: 'connection_burst', pool_name: 'P', connection: 'b', suppressed: 1, first_ms: 0, last_ms: 0 }, 'b4']);
  });
});

describe('the views ignore ?connections=all messages', () => {
  it('recognises every added type, and nothing else', () => {
    for (const type of CONNECTION_MESSAGE_TYPES) expect(isConnectionMessage({ type })).toBe(true);
    for (const m of [{ type: 'burst' }, { type: 'replay' }, { type: 'block' }, { pool_name: 'P' }, null, 'x']) {
      expect(isConnectionMessage(m)).toBe(false);
    }
  });
});

describe('StreamHub connection messages', () => {
  type OnMessage = (msg: { content: Buffer } | null) => void;
  let onMessage: OnMessage | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const channel = {
      assertQueue: vi.fn(async () => ({ queue: 'q' })), bindQueue: vi.fn(async () => {}),
      consume: vi.fn(async (_q: string, cb: OnMessage) => { onMessage = cb; return { consumerTag: 't' }; }),
      cancel: vi.fn(async () => {}), close: vi.fn(async () => {}),
    };
    vi.doMock('../rabbitmq', () => ({
      RABBITMQ_EXCHANGES: ['x'],
      createRabbitmqChannel: vi.fn(async () => ({ channel, connection: { close: vi.fn(async () => {}) } })),
    }));
    vi.stubEnv('POOL_BLACKLIST', 'Hidden');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.doUnmock('../rabbitmq');
  });

  it('delivers them only to viewers that ask, with the ranked letter; unknown connections get nothing', async () => {
    const { StreamHub } = await import('../streamHub');
    const ranks = new ConnectionRanks(async () => [
      { name: 'P', site: 's1', replica: 'a', conn: 1 }, { name: 'P', site: 's1', replica: 'b', conn: 2 }]);
    const hub = new StreamHub(1_000, ranks);
    const plain: string[] = [];
    const all: string[] = [];
    await hub.subscribe({ onMessage: m => plain.push(m.data), onEnd: () => {} });
    await hub.subscribe({ onMessage: () => {}, onConnection: m => all.push(m.data), onEnd: () => {} });
    await vi.advanceTimersByTimeAsync(H); // past the first window after the consumer started
    const send = (o: object) => onMessage!({ content: Buffer.from(JSON.stringify(o)) });
    send(tpl('a', { ntime: '01' }));
    send(tpl('b', { ntime: '02' }));                     // b's own work
    send(tpl('c', { ntime: '03' }));                     // a connection the ranking doesn't know
    send(tpl('b', { ntime: '04', pool: 'Hidden' }));     // excluded: never judged
    await vi.advanceTimersByTimeAsync(H + 500);
    expect(all.map(d => JSON.parse(d))).toEqual([{ type: 'connection_template', connection: 'b', data: tpl('b', { ntime: '02' }) }]);
    expect(hub.unlabelled).toBe(1);
    expect(plain.every(d => !d.includes('connection_'))).toBe(true);
    send(tpl('a', { ntime: '05' }));
    send(tpl('b', { ntime: '05' }));
    await vi.advanceTimersByTimeAsync(H + 500);
    expect(JSON.parse(all[1])).toEqual({ type: 'connection_copy', pool_name: 'P', connection: 'b', height: 10 });
  });

  it('runs its timer only while a viewer wants connection messages', async () => {
    const { StreamHub } = await import('../streamHub');
    const hub = new StreamHub(60_000, new ConnectionRanks(async () => []));
    const before = vi.getTimerCount();
    const unsub = await hub.subscribe({ onMessage: () => {}, onConnection: () => {}, onEnd: () => {} });
    expect(vi.getTimerCount()).toBeGreaterThan(before);
    unsub();
    // Only the linger timer is left.
    expect(vi.getTimerCount()).toBe(before + 1);
  });
});
