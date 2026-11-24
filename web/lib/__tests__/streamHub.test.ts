/**
 * The shared live-stream consumer (lib/streamHub.ts): one RabbitMQ connection per process however many viewers, kept
 * for a linger period after the last one leaves, and every viewer ended when it is lost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type OnMessage = (msg: { content: Buffer } | null) => void;

function fakeBroker() {
  const conns: { onClose?: () => void; channel: ReturnType<typeof makeChannel>; close: ReturnType<typeof vi.fn> }[] = [];
  function makeChannel() {
    const ch = {
      onMessage: undefined as OnMessage | undefined,
      assertQueue: vi.fn(async () => ({ queue: 'q' })),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      bindQueue: vi.fn(async (_q: string, _x: string, _k: string) => {}),
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      consume: vi.fn(async (_q: string, cb: OnMessage, _o?: object) => { ch.onMessage = cb; return { consumerTag: 't' }; }),
      ack: vi.fn(), cancel: vi.fn(async () => {}), deleteQueue: vi.fn(async () => {}), close: vi.fn(async () => {}),
    };
    return ch;
  }
  const create = vi.fn(async (onClose?: () => void) => {
    const c = { onClose, channel: makeChannel(), close: vi.fn(async () => {}) };
    conns.push(c);
    return { channel: c.channel, connection: { close: c.close } };
  });
  return { conns, create };
}

const msg = (o: unknown) => ({ content: Buffer.from(JSON.stringify(o)) });

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, text: string, pred: (t: string) => boolean) {
  const decoder = new TextDecoder();
  while (!pred(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

describe('StreamHub', () => {
  let broker: ReturnType<typeof fakeBroker>;

  beforeEach(() => {
    vi.resetModules();
    broker = fakeBroker();
    vi.doMock('../rabbitmq', () => ({ RABBITMQ_EXCHANGES: ['x', 'y'], createRabbitmqChannel: broker.create }));
    vi.stubEnv('POOL_BLACKLIST', 'Hidden Pool');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.doUnmock('../rabbitmq');
  });

  it('shares one connection and queue among viewers, and fans every message out to each', async () => {
    const { StreamHub } = await import('../streamHub');
    const hub = new StreamHub();
    const got: string[][] = [[], [], []];
    // Three viewers arrive together: one connection attempt.
    const subs = await Promise.all(got.map(g => hub.subscribe({ onMessage: m => g.push(m.data), onEnd: () => {} })));
    expect(broker.create).toHaveBeenCalledTimes(1);
    const ch = broker.conns[0].channel;
    expect(ch.bindQueue.mock.calls.map(c => c[1])).toEqual(['x', 'y']);
    expect(ch.consume.mock.calls[0][2]).toEqual({ noAck: true });

    ch.onMessage!(msg({ type: 'block', height: 1 }));
    expect(got.map(g => g.length)).toEqual([1, 1, 1]);
    subs[0]();
    ch.onMessage!(msg({ type: 'block', height: 2 }));
    expect(got.map(g => g.length)).toEqual([1, 2, 2]);
    expect(hub.viewerCount).toBe(2);
    // A later viewer reuses the open connection.
    await hub.subscribe({ onMessage: () => {}, onEnd: () => {} });
    expect(broker.create).toHaveBeenCalledTimes(1);
  });

  it('masks, parses and drops excluded pools once, for every viewer', async () => {
    const { StreamHub, prepare } = await import('../streamHub');
    expect(prepare(JSON.stringify({ pool_name: 'Hidden Pool', height: 5 }))).toBeNull();
    expect(prepare('{"broken": "aabb", "extranonce1":')).toBeNull(); // unparseable and mentions extranonce1
    expect(prepare('not json')).toEqual({ data: 'not json', parsed: undefined }); // fail-open, as before
    const ok = prepare(JSON.stringify({ pool_name: 'P', extranonce1: 'deadbeef' }))!;
    expect(ok.data).not.toContain('deadbeef');
    expect(ok.parsed!.extranonce1).not.toBe('deadbeef');

    const hub = new StreamHub();
    const a: string[] = [];
    await hub.subscribe({ onMessage: m => a.push(m.data), onEnd: () => {} });
    broker.conns[0].channel.onMessage!(msg({ pool_name: 'Hidden Pool', height: 5 }));
    broker.conns[0].channel.onMessage!(msg({ pool_name: 'P', height: 5 }));
    expect(a.map(d => JSON.parse(d).pool_name)).toEqual(['P']);
  });

  it('keeps the connection for the linger period after the last viewer, then closes it', async () => {
    vi.useFakeTimers();
    const { StreamHub } = await import('../streamHub');
    const hub = new StreamHub(30_000);
    const unsub = await hub.subscribe({ onMessage: () => {}, onEnd: () => {} });
    unsub();
    unsub(); // idempotent
    await vi.advanceTimersByTimeAsync(20_000);
    // A reload within the linger period reuses the connection.
    const unsub2 = await hub.subscribe({ onMessage: () => {}, onEnd: () => {} });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(broker.conns[0].close).not.toHaveBeenCalled();
    unsub2();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(broker.conns[0].channel.cancel).toHaveBeenCalledWith('t');
    expect(broker.conns[0].close).toHaveBeenCalledTimes(1);
    // The next viewer opens a new connection.
    await hub.subscribe({ onMessage: () => {}, onEnd: () => {} });
    expect(broker.create).toHaveBeenCalledTimes(2);
  });

  it('ends every viewer when the connection or consumer is lost, then reconnects for the next viewer', async () => {
    const { StreamHub } = await import('../streamHub');
    const hub = new StreamHub();
    const ended = [vi.fn(), vi.fn()];
    for (const onEnd of ended) await hub.subscribe({ onMessage: () => {}, onEnd });
    broker.conns[0].onClose!(); // connection closed by the broker
    expect(ended.map(e => e.mock.calls.length)).toEqual([1, 1]);
    expect(hub.viewerCount).toBe(0);

    const onEnd = vi.fn();
    await hub.subscribe({ onMessage: () => {}, onEnd });
    expect(broker.create).toHaveBeenCalledTimes(2);
    broker.conns[1].channel.onMessage!(null); // consumer cancelled by the broker
    expect(onEnd).toHaveBeenCalledTimes(1);
    broker.conns[1].onClose!(); // the close that follows doesn't end anything twice
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('rejects the subscription when the consumer cannot be set up, and retries for the next viewer', async () => {
    const { StreamHub } = await import('../streamHub');
    const hub = new StreamHub();
    broker.create.mockImplementationOnce(async () => { throw new Error('ECONNREFUSED'); });
    await expect(hub.subscribe({ onMessage: () => {}, onEnd: () => {} })).rejects.toThrow('ECONNREFUSED');
    await hub.subscribe({ onMessage: () => {}, onEnd: () => {} });
    expect(broker.create).toHaveBeenCalledTimes(2);
  });

  it('/api/stream: two viewers on one connection; a lost connection ends both streams', async () => {
    const { GET } = await import('../../app/api/stream/route');
    const aborts = [new AbortController(), new AbortController()];
    const readers = await Promise.all(aborts.map(async a =>
      (await GET(new NextRequest('http://test/api/stream', { signal: a.signal }))).body!.getReader()));
    const texts = await Promise.all(readers.map(r => readUntil(r, '', t => t.includes('"connected"'))));
    expect(broker.create).toHaveBeenCalledTimes(1);

    broker.conns[0].channel.onMessage!(msg({ type: 'block', height: 7 }));
    const after = await Promise.all(readers.map((r, i) => readUntil(r, texts[i], t => t.includes('"height":7'))));
    expect(after.every(t => t.includes('"height":7'))).toBe(true);

    broker.conns[0].onClose!();
    for (const r of readers) expect((await r.read()).done).toBe(true);
  });

  it('/api/stream: a viewer that leaves stops receiving; the connection stays for the others', async () => {
    const { GET } = await import('../../app/api/stream/route');
    const { streamHub } = await import('../streamHub');
    const a = new AbortController();
    const b = new AbortController();
    const ra = (await GET(new NextRequest('http://test/api/stream', { signal: a.signal }))).body!.getReader();
    const rb = (await GET(new NextRequest('http://test/api/stream', { signal: b.signal }))).body!.getReader();
    await readUntil(ra, '', t => t.includes('"connected"'));
    const tb = await readUntil(rb, '', t => t.includes('"connected"'));
    expect(streamHub().viewerCount).toBe(2);
    a.abort();
    expect(streamHub().viewerCount).toBe(1);
    broker.conns[0].channel.onMessage!(msg({ type: 'block', height: 8 }));
    expect(await readUntil(rb, tb, t => t.includes('"height":8'))).toContain('"height":8');
    expect(broker.conns[0].close).not.toHaveBeenCalled();
    b.abort();
  });
});
