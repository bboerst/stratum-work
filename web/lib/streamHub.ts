/**
 * One RabbitMQ consumer per web process, shared by every live-stream viewer (/api/stream).
 *
 * Before, each viewer opened its own AMQP connection, channel and queue, so RabbitMQ's memory and connection count
 * grew with the number of people watching. Now a process holds one connection and one exclusive, server-named queue
 * bound to every exchange, and fans each message out to its viewers in memory. RabbitMQ's cost follows the number of
 * web pods, not viewers.
 *
 * Work that is the same for every viewer happens once here: masking extranonce1 (#105), parsing, dropping excluded
 * pools, and the one-stream-per-pool decision (lib/streamDedup.ts). The dedup is shared so a viewer who connects later
 * already knows which of a pool's connections is the active one, instead of showing another connection's templates
 * first and switching (which the timing chart can't compare across). Per-viewer state (the throttle) stays in the
 * route.
 *
 * Lifecycle:
 *   - The connection opens with the first viewer; concurrent first viewers share the one attempt.
 *   - When the last viewer leaves, it stays open for LINGER_MS (a page reload doesn't reconnect), then closes.
 *   - If the connection, channel or consumer goes away, every viewer's stream is ended, so browsers reconnect
 *     (EventSource / useDataStream) and the next viewer opens a new connection.
 */
import type { Channel, ConsumeMessage } from 'amqplib';
import { maskStreamMessage } from './connectionMask';
import { isPoolBlacklisted } from './poolBlacklist';
import { StreamTemplateDedup } from './streamDedup';
import { createRabbitmqChannel, RABBITMQ_EXCHANGES, type RabbitMQConnection } from './rabbitmq';

export const LINGER_MS = 30_000;

/** A message as every viewer gets it: masked; `parsed` is its JSON (undefined if it isn't JSON: forwarded as is). */
export interface HubMessage {
  data: string;
  parsed?: Record<string, unknown>;
  /** A template another of the pool's connections is already streaming, or an exact copy: viewers skip it. */
  skip?: boolean;
}

export interface Viewer {
  onMessage(m: HubMessage): void;
  /** The shared connection is gone; the viewer's stream should end. */
  onEnd(): void;
}

interface Live {
  conn: RabbitMQConnection;
  channel: Channel;
  consumerTag?: string;
  closing: boolean;
}

/** Masks, parses and filters one raw message. Null: drop it for everyone. */
export function prepare(raw: string): HubMessage | null {
  // Mask per-connection identifiers before anything else. An unparseable message that mentions extranonce1 is dropped.
  const data = maskStreamMessage(raw);
  if (data === null) return null;
  let parsed: Record<string, unknown> | undefined;
  try {
    const p = JSON.parse(data);
    if (p !== null && typeof p === 'object' && !Array.isArray(p)) parsed = p;
  } catch {
    // Not JSON: forwarded unfiltered (fail-open), as before.
  }
  if (typeof parsed?.pool_name === 'string' && isPoolBlacklisted(parsed.pool_name)) return null;
  return { data, parsed };
}

export class StreamHub {
  private readonly viewers = new Set<Viewer>();
  private live: Live | null = null;
  private starting: Promise<Live> | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  /** One stream per pool, for every viewer (kept across reconnects: its state ages out by itself). */
  private readonly dedup = new StreamTemplateDedup();
  /** Connections opened so far (tests, logs). */
  connects = 0;

  constructor(private readonly lingerMs = LINGER_MS) {}

  get viewerCount(): number {
    return this.viewers.size;
  }

  /**
   * Adds a viewer once the shared consumer is running (rejects if it can't be started). Returns its unsubscribe.
   */
  async subscribe(viewer: Viewer): Promise<() => void> {
    this.cancelLinger();
    await this.ensureLive();
    this.viewers.add(viewer);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.viewers.delete(viewer);
      if (this.viewers.size === 0) this.scheduleLinger();
    };
  }

  private async ensureLive(): Promise<Live> {
    if (this.live && !this.live.closing) return this.live;
    if (!this.starting) {
      this.starting = this.start().finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  private async start(): Promise<Live> {
    // The close callback can't see `live` before createRabbitmqChannel returns; it is set right after.
    const ref: { live?: Live } = {};
    const conn = await createRabbitmqChannel(() => { if (ref.live) this.lost(ref.live, 'connection closed'); });
    this.connects += 1;
    const live: Live = { conn, channel: conn.channel, closing: false };
    ref.live = live;
    try {
      const { channel } = live;
      // Exclusive and auto-delete: the queue lives exactly as long as this connection.
      const qok = await channel.assertQueue('', { exclusive: true, autoDelete: true, arguments: { 'x-expires': 60000 } });
      for (const exchange of RABBITMQ_EXCHANGES) await channel.bindQueue(qok.queue, exchange, '');
      // noAck: a live view of a transient queue, nothing to redeliver; and one consumer must not wait on an ack
      // round trip per message.
      const consumer = await channel.consume(qok.queue, (msg: ConsumeMessage | null) => this.onRaw(live, msg), { noAck: true });
      live.consumerTag = consumer.consumerTag;
    } catch (err) {
      live.closing = true;
      await live.conn.connection.close().catch(() => {});
      throw err;
    }
    this.live = live;
    console.log('Live stream: shared RabbitMQ consumer started');
    return live;
  }

  private onRaw(live: Live, msg: ConsumeMessage | null): void {
    if (live.closing) return;
    if (msg === null) {
      // The broker cancelled the consumer (queue deleted, node down).
      this.lost(live, 'consumer cancelled');
      return;
    }
    let m: HubMessage | null;
    try {
      m = prepare(msg.content.toString());
    } catch (err) {
      console.error('Live stream: error preparing message:', err);
      return;
    }
    if (m === null) return;
    // Only templates (published without a `type`); blocks and other events pass as before.
    if (m.parsed && typeof m.parsed.pool_name === 'string' && m.parsed.type === undefined && !this.dedup.accept(m.parsed)) {
      m.skip = true;
    }
    for (const v of this.viewers) {
      try {
        v.onMessage(m);
      } catch (err) {
        console.error('Live stream: viewer error:', err);
      }
    }
  }

  /** The connection is gone unexpectedly: end every viewer so their browsers reconnect. */
  private lost(live: Live, why: string): void {
    if (live.closing) return;
    live.closing = true;
    if (this.live === live) this.live = null;
    console.error(`Live stream: shared RabbitMQ consumer lost (${why}); ending ${this.viewers.size} viewer stream(s)`);
    const ended = [...this.viewers];
    this.viewers.clear();
    this.cancelLinger();
    for (const v of ended) {
      try {
        v.onEnd();
      } catch {
        // ignore
      }
    }
    void live.conn.connection.close().catch(() => {});
  }

  private scheduleLinger(): void {
    this.cancelLinger();
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.viewers.size === 0) void this.stop();
    }, this.lingerMs);
    this.lingerTimer.unref?.();
  }

  private cancelLinger(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  /** Closes the shared connection (no viewers left). */
  async stop(): Promise<void> {
    const live = this.live;
    if (!live) return;
    live.closing = true;
    this.live = null;
    if (live.consumerTag) await live.channel.cancel(live.consumerTag).catch(() => {});
    await live.channel.close().catch(() => {});
    await live.conn.connection.close().catch(() => {});
    console.log('Live stream: shared RabbitMQ consumer stopped (no viewers)');
  }
}

// One hub per process (module state; a fresh module, e.g. in tests, gets a fresh hub).
let hub: StreamHub | null = null;
export function streamHub(): StreamHub {
  if (!hub) hub = new StreamHub();
  return hub;
}
