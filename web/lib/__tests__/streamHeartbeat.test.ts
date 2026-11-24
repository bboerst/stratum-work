/**
 * /api/stream keeps a quiet stream alive with an SSE comment every HEARTBEAT_MS (lib/streamHeartbeat.ts), and stops
 * when the viewer leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('/api/stream heartbeat', () => {
  beforeEach(() => {
    vi.resetModules();
    const channel = {
      assertQueue: vi.fn(async () => ({ queue: 'q' })),
      bindQueue: vi.fn(async () => {}),
      consume: vi.fn(async () => ({ consumerTag: 't' })),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    vi.doMock('../rabbitmq', () => ({
      RABBITMQ_EXCHANGES: ['x'],
      createRabbitmqChannel: vi.fn(async () => ({ channel, connection: { close: vi.fn(async () => {}) } })),
    }));
    // Only the intervals: promises and the stream's reads keep running on real microtasks.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock('../rabbitmq');
  });

  it('sends a comment line every HEARTBEAT_MS while the viewer is connected, and stops when it leaves', async () => {
    const { GET } = await import('../../app/api/stream/route');
    const { HEARTBEAT, HEARTBEAT_MS } = await import('../streamHeartbeat');
    expect(HEARTBEAT.startsWith(':')).toBe(true); // an SSE comment: EventSource ignores it
    expect(HEARTBEAT_MS).toBeLessThan(125_000); // under Cloudflare's origin read timeout

    const abort = new AbortController();
    const reader = (await GET(new NextRequest('http://test/api/stream', { signal: abort.signal }))).body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain('"connected"');

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(decoder.decode((await reader.read()).value)).toBe(HEARTBEAT);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(decoder.decode((await reader.read()).value)).toBe(HEARTBEAT);

    abort.abort();
    expect(vi.getTimerCount()).toBe(0); // heartbeat and throttle timers cleared
    expect((await reader.read()).done).toBe(true);
  });
});
