import { NextRequest } from 'next/server';
import { PoolStreamThrottle, poolThrottleFromEnv } from '../../../lib/streamThrottle';
import { streamHub, type HubMessage } from '../../../lib/streamHub';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The live stream. Every viewer in this process shares one RabbitMQ consumer (lib/streamHub.ts), which masks, parses
// and drops excluded pools once, and decides one stream per pool (shared, so a new viewer starts on the active
// connection); each viewer keeps its own throttle here.
export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let closed = false;
  // Ends this viewer's stream: set in start(), also run by cancel().
  let end = () => { closed = true; };

  const stream = new ReadableStream({
    async start(controller) {
      // Per-pool rate limit for templates (#105): a pool flooding templates can't freeze the browser. Normal traffic
      // passes untouched; held templates are flushed by this timer, newest first, with a burst marker.
      const throttle = new PoolStreamThrottle(poolThrottleFromEnv());
      let throttleTimer: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;

      const send = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch (err) {
          console.error('Error enqueueing data:', err);
          close();
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (throttleTimer) clearInterval(throttleTimer);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const onMessage = (m: HubMessage) => {
        const parsed = m.parsed;
        // Only templates (both collectors publish them without a `type`); blocks and other events pass as before.
        if (parsed && typeof parsed.pool_name === 'string' && parsed.type === undefined) {
          // Another collector's stream or a copy (decided once in the hub), before the throttle so it doesn't use up
          // the pool's rate.
          if (m.skip) return;
          for (const out of throttle.offer(parsed.pool_name, m.data, Date.now())) send(out);
        } else {
          send(m.data);
        }
      };

      end = close;
      request.signal.addEventListener('abort', close);

      try {
        unsubscribe = await streamHub().subscribe({ onMessage, onEnd: close });
      } catch (err) {
        console.error('Error setting up stream:', err);
        close();
        return;
      }
      if (closed || request.signal.aborted) {
        close();
        unsubscribe();
        return;
      }
      if (throttle.enabled) {
        throttleTimer = setInterval(() => {
          for (const out of throttle.tick(Date.now())) send(out);
        }, 200);
      }
      // Confirms the connection; the viewer is subscribed by now.
      send('{"type":"connection","status":"connected"}');
    },
    cancel() {
      // The client went away (also signalled by request.signal's abort).
      end();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
