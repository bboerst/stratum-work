import { NextRequest } from 'next/server';
import { PoolStreamThrottle, poolThrottleFromEnv } from '../../../lib/streamThrottle';
import { streamHub, type ConnectionMessage, type HubMessage } from '../../../lib/streamHub';
import { HEARTBEAT, HEARTBEAT_MS } from '../../../lib/streamHeartbeat';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The live stream. Every viewer in this process shares one RabbitMQ consumer (lib/streamHub.ts), which masks, parses
// and drops excluded pools once, and decides one stream per pool (shared, so a new viewer starts on the active
// connection); each viewer keeps its own throttle here.
//
// `?connections=all` (#321): the same messages, plus other connections' distinct work and the notices that it ended
// (decided in the hub, lib/streamConnections.ts), each with the connection's letter and their own type so views that
// don't know them ignore them. Any other value, or none, is the default stream.
export async function GET(request: NextRequest) {
  const allConnections = request.nextUrl.searchParams.get('connections') === 'all';
  const encoder = new TextEncoder();
  let closed = false;
  // Ends this viewer's stream: set in start(), also run by cancel().
  let end = () => { closed = true; };

  const stream = new ReadableStream({
    async start(controller) {
      // Per-pool rate limit for templates (#105): a pool flooding templates can't freeze the browser. Normal traffic
      // passes untouched; held templates are flushed by this timer, newest first, with a burst marker.
      const throttle = new PoolStreamThrottle(poolThrottleFromEnv());
      // Other connections' messages (?connections=all): their own instance, keyed per pool + connection, so they
      // neither use up the pool's rate nor trip its burst marker.
      const connectionThrottle = allConnections ? new PoolStreamThrottle(poolThrottleFromEnv()) : null;
      let throttleTimer: ReturnType<typeof setInterval> | undefined;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined = undefined;
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
        if (heartbeatTimer) clearInterval(heartbeatTimer);
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

      const onConnection = (m: ConnectionMessage) => {
        for (const out of connectionThrottle!.offer(m.pool, m.data, Date.now(), m.connection)) send(out);
      };

      end = close;
      request.signal.addEventListener('abort', close);

      try {
        // The recent templates first, as their own type: they feed the timing chart's buffer only (lib/useDataStream.ts),
        // and older pages ignore types they don't know. Not throttled: the hub caps them per pool.
        const onReplay = (ms: HubMessage[]) => {
          for (const m of ms) send(`{"type":"replay","data":${m.data}}`);
        };
        unsubscribe = await streamHub().subscribe(
          allConnections ? { onMessage, onReplay, onConnection, onEnd: close } : { onMessage, onReplay, onEnd: close });
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
          const now = Date.now();
          for (const out of throttle.tick(now)) send(out);
          if (connectionThrottle) for (const out of connectionThrottle.tick(now)) send(out);
        }, 200);
      }
      heartbeatTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(HEARTBEAT));
        } catch {
          close();
        }
      }, HEARTBEAT_MS);
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
