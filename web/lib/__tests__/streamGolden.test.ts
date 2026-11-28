/**
 * The live stream's default output (/api/stream without parameters) is pinned byte for byte: third-party consumers of
 * the public stream depend on it. A recorded multi-source sequence (fixtures/stream-multi-source.json: synthetic pools
 * with several connections, exact copies, other jobs per connection, a primary outage and its return, a new block, an
 * older collector without site/replica, an excluded pool, a flood that trips the throttle, a non-JSON message, another
 * chain's height, and a second viewer who joins and leaves) is played through the route on fake timers, and every
 * byte each viewer gets is compared with fixtures/stream-multi-source.golden.txt.
 *
 * Regenerate only for an intended change of the default stream: UPDATE_GOLDEN=1 npx vitest run lib/__tests__/streamGolden.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

type OnMessage = (msg: { content: Buffer } | null) => void;

interface Fixture {
  t0: number;
  blacklist: string;
  end: number;
  events: { at: number; kind: 'message' | 'raw' | 'join' | 'leave'; body?: unknown }[];
}

const FIXTURES = join(__dirname, 'fixtures');
const GOLDEN = join(FIXTURES, 'stream-multi-source.golden.txt');

/** Reads a stream into `out.text` until it ends. */
function pump(body: ReadableStream<Uint8Array>, out: { text: string }): void {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      out.text += decoder.decode(value);
    }
  })();
}

/** Plays the fixture through /api/stream (query `qs`) and returns what each viewer received. */
export async function playFixture(qs = '', extraEnv: Record<string, string> = {}): Promise<{ first: string; second: string }> {
  const fx = JSON.parse(readFileSync(join(FIXTURES, 'stream-multi-source.json'), 'utf8')) as Fixture;
  vi.setSystemTime(fx.t0);
  vi.stubEnv('POOL_BLACKLIST', fx.blacklist);
  vi.stubEnv('EXTRANONCE1_MASK_KEY', 'golden-test-key');
  for (const [k, v] of Object.entries(extraEnv)) vi.stubEnv(k, v);
  let onMessage: OnMessage | undefined;
  const channel = {
    assertQueue: vi.fn(async () => ({ queue: 'q' })), bindQueue: vi.fn(async () => {}),
    consume: vi.fn(async (_q: string, cb: OnMessage) => { onMessage = cb; return { consumerTag: 't' }; }),
    ack: vi.fn(), cancel: vi.fn(async () => {}), deleteQueue: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  vi.doMock('../rabbitmq', () => ({
    RABBITMQ_EXCHANGES: ['x'],
    createRabbitmqChannel: vi.fn(async () => ({ channel, connection: { close: vi.fn(async () => {}) } })),
  }));
  const { GET } = await import('../../app/api/stream/route');
  const open = async (out: { text: string }) => {
    const abort = new AbortController();
    const res = await GET(new NextRequest(`http://test/api/stream${qs}`, { signal: abort.signal }));
    pump(res.body!, out);
    await vi.advanceTimersByTimeAsync(0);
    return abort;
  };
  const first = { text: '' };
  const second = { text: '' };
  const a = await open(first);
  let b: AbortController | undefined;
  let now = 0;
  for (const e of fx.events) {
    if (e.at > now) await vi.advanceTimersByTimeAsync(e.at - now);
    now = e.at;
    if (e.kind === 'join') b = await open(second);
    else if (e.kind === 'leave') b?.abort();
    else onMessage!({ content: Buffer.from(e.kind === 'raw' ? String(e.body) : JSON.stringify(e.body)) });
  }
  await vi.advanceTimersByTimeAsync(fx.end - now);
  a.abort();
  await vi.advanceTimersByTimeAsync(0);
  return { first: first.text, second: second.text };
}

export function goldenText(r: { first: string; second: string }): string {
  return `=== first viewer ===\n${r.first}=== second viewer ===\n${r.second}`;
}

describe('/api/stream default output (golden)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.doUnmock('../rabbitmq');
  });

  it('is byte-identical to the recorded output', async () => {
    const text = goldenText(await playFixture());
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(GOLDEN, text);
    // Sanity: the sequence exercises what it claims to.
    expect(text).toContain('"type":"burst"');
    expect(text).toContain('"type":"replay"');
    expect(text).toContain(': keepalive');
    expect(text).not.toContain('Pool Hidden');
    expect(text).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});
