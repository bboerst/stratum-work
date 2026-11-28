/**
 * One RabbitMQ consumer per web process, shared by every live-stream viewer (/api/stream).
 *
 * Before, each viewer opened its own AMQP connection, channel and queue, so RabbitMQ's memory and connection count
 * grew with the number of people watching. Now a process holds one connection and one exclusive, server-named queue
 * bound to every exchange, and fans each message out to its viewers in memory. RabbitMQ's cost follows the number of
 * web pods, not viewers.
 *
 * Work that is the same for every viewer happens once here: masking extranonce1 (#105), parsing, dropping excluded
 * pools, the one-stream-per-pool decision (lib/streamDedup.ts), and which hidden templates are a connection's distinct
 * work, for viewers of `?connections=all` (lib/streamConnections.ts, delivered through `onConnection` only). The dedup is shared so a viewer who connects later
 * already knows which of a pool's connections is the active one, instead of showing another connection's templates
 * first and switching (which the timing chart can't compare across). Per-viewer state (the throttle) stays in the
 * route.
 *
 * Lifecycle:
 *   - The connection opens with the first viewer; concurrent first viewers share the one attempt.
 *   - When the last viewer leaves, it stays open for LINGER_MS (a page reload doesn't reconnect, and the next viewer
 *     gets a replay), then closes.
 *   - If the connection, channel or consumer goes away, every viewer's stream is ended, so browsers reconnect
 *     (EventSource / useDataStream) and the next viewer opens a new connection.
 */
import type { Channel, ConsumeMessage } from 'amqplib';
import { maskStreamMessage } from './connectionMask';
import { isPoolBlacklisted } from './poolBlacklist';
import { StreamTemplateDedup } from './streamDedup';
import { StreamConnections } from './streamConnections';
import { ConnectionRanks } from './connectionRanks';
import { createRabbitmqChannel, RABBITMQ_EXCHANGES, type RabbitMQConnection } from './rabbitmq';

export const LINGER_MS = 10 * 60_000;

/**
 * Replay (the timing chart's seam, lib/templateBuffer.ts): a new viewer first gets the templates this consumer accepted
 * in the last REPLAY_MS, plus each pool's newest one before that, then the live stream from the same consumer. That
 * stretch and the live templates after it are one continuous observation, and it reaches back past what the history
 * read already has (a template is in it at most about 7 s after it arrived, measured), so the history and the stream
 * overlap at page load and the first live templates are compared instead of shown as gaps. At most
 * REPLAY_MAX_PER_POOL per pool, dropped from the oldest end (the stretch stays contiguous, it only reaches back less).
 * The consumer only knows what it saw: the tail is cleared whenever it (re)starts or stops.
 */
export const REPLAY_MS = 20_000;
/** The newest template before REPLAY_MS is replayed only if it is at most this old. */
export const REPLAY_ANCHOR_MS = 120_000;
export const REPLAY_MAX_PER_POOL = 20;

/** A message as every viewer gets it: masked; `parsed` is its JSON (undefined if it isn't JSON: forwarded as is). */
export interface HubMessage {
  data: string;
  parsed?: Record<string, unknown>;
  /** A template another of the pool's connections is already streaming, or an exact copy: viewers skip it. */
  skip?: boolean;
}

/** A `?connections=all` message (lib/streamConnections.ts), as one JSON text with the connection's letter. */
export interface ConnectionMessage {
  pool: string;
  connection: string;
  data: string;
}

/** How often the hub judges held templates (lib/streamConnections.ts). */
export const CONNECTIONS_TICK_MS = 250;

export interface Viewer {
  onMessage(m: HubMessage): void;
  /** `?connections=all` messages; viewers without it never see them. */
  onConnection?(m: ConnectionMessage): void;
  /** The recent templates (Replay above), oldest first: called once, before any onMessage. */
  onReplay?(ms: HubMessage[]): void;
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
  /** Other connections' distinct work (?connections=all); cleared with the tail, its judging needs a full window. */
  private readonly connections = new StreamConnections();
  private readonly ranks: ConnectionRanks;
  /** Judges on a timer only while a viewer wants connection messages; otherwise as messages arrive (onRaw). */
  private connectionsTimer: ReturnType<typeof setInterval> | null = null;
  private connectionViewers = 0;
  private judgedAt = -Infinity;
  /** Connection events dropped because the connection's letter wasn't known (tests, logs). */
  unlabelled = 0;
  /** Per pool, the templates the current consumer accepted recently, oldest first (Replay above). */
  private readonly tail = new Map<string, { at: number; seq: number; m: HubMessage }[]>();
  private seq = 0;
  /** Connections opened so far (tests, logs). */
  connects = 0;

  constructor(private readonly lingerMs = LINGER_MS, ranks?: ConnectionRanks) {
    this.ranks = ranks ?? new ConnectionRanks();
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  /**
   * Adds a viewer once the shared consumer is running (rejects if it can't be started). Returns its unsubscribe.
   */
  async subscribe(viewer: Viewer): Promise<() => void> {
    this.cancelLinger();
    await this.ensureLive();
    // The snapshot and the add happen together, so the viewer gets every message exactly once: replayed or live.
    const replay = this.replay(Date.now());
    this.viewers.add(viewer);
    if (viewer.onConnection && ++this.connectionViewers === 1) this.armConnectionsTimer();
    if (viewer.onReplay) {
      try {
        viewer.onReplay(replay);
      } catch (err) {
        console.error('Live stream: viewer replay error:', err);
      }
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.viewers.delete(viewer) && viewer.onConnection && --this.connectionViewers === 0) this.disarmConnectionsTimer();
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

  /** The recent templates of every pool, in the order the consumer received them. */
  private replay(now: number): HubMessage[] {
    const out: { at: number; seq: number; m: HubMessage }[] = [];
    for (const [pool, list] of this.tail) {
      this.prune(list, now);
      if (list.length === 0) this.tail.delete(pool);
      else out.push(...list);
    }
    return out.sort((a, b) => a.seq - b.seq).map(e => e.m);
  }

  /** Keeps the last REPLAY_MS, plus the newest entry before it if not older than REPLAY_ANCHOR_MS, capped. */
  private prune(list: { at: number }[], now: number): void {
    while (list.length > 1 && list[1].at < now - REPLAY_MS) list.shift();
    if (list.length > 0 && list[0].at < now - REPLAY_ANCHOR_MS) list.shift();
    while (list.length > REPLAY_MAX_PER_POOL) list.shift();
  }

  private remember(pool: string, m: HubMessage): void {
    const now = Date.now();
    let list = this.tail.get(pool);
    if (!list) this.tail.set(pool, (list = []));
    list.push({ at: now, seq: this.seq++, m });
    this.prune(list, now);
  }

  private async start(): Promise<Live> {
    this.tail.clear();
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
      // The judging's first window starts when the consumer does (the connect above can take a while, with retries).
      this.connections.reset(Date.now());
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
    this.startConnections();
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
    // A template the dedup drops as an exact copy of one already forwarded is shown work: never another connection's.
    const copiesBefore = this.dedup.dropped;
    if (m.parsed && typeof m.parsed.pool_name === 'string' && m.parsed.type === undefined && !this.dedup.accept(m.parsed)) {
      m.skip = true;
    }
    const copyOfShown = this.dedup.dropped > copiesBefore;
    if (m.parsed && typeof m.parsed.pool_name === 'string' && m.parsed.type === undefined) {
      if (!m.skip) this.remember(m.parsed.pool_name, m);
      const now = Date.now();
      this.connections.observe(m.parsed, m.data, !m.skip, now, copyOfShown);
      if (now - this.judgedAt >= CONNECTIONS_TICK_MS) this.judgeConnections(now);
    }
    for (const v of this.viewers) {
      try {
        v.onMessage(m);
      } catch (err) {
        console.error('Live stream: viewer error:', err);
      }
    }
  }

  /** The consumer is running (its templates' judging started with the reset in start()): load the letters. */
  private startConnections(): void {
    void this.ranks.refresh();
  }

  private stopConnections(): void {
    this.connections.reset(Date.now());
  }

  private armConnectionsTimer(): void {
    this.disarmConnectionsTimer();
    this.connectionsTimer = setInterval(() => this.judgeConnections(Date.now()), CONNECTIONS_TICK_MS);
    this.connectionsTimer.unref?.();
  }

  private disarmConnectionsTimer(): void {
    if (this.connectionsTimer) clearInterval(this.connectionsTimer);
    this.connectionsTimer = null;
  }

  /** Sends the judged connection events to the viewers that asked for them. */
  private judgeConnections(now: number): void {
    this.judgedAt = now;
    const events = this.connections.tick(now);
    if (events.length === 0) return;
    for (const e of events) {
      if (this.connectionViewers === 0) continue; // judged for the state only
      const connection = this.ranks.letter(e.pool, e.site, e.replica, now);
      if (connection === null) {
        this.unlabelled += 1;
        continue;
      }
      const data = e.kind === 'template'
        ? `{"type":"connection_template","connection":${JSON.stringify(connection)},"data":${e.data}}`
        : JSON.stringify({ type: 'connection_copy', pool_name: e.pool, connection, height: e.height });
      const m: ConnectionMessage = { pool: e.pool, connection, data };
      for (const v of this.viewers) {
        if (!v.onConnection) continue;
        try {
          v.onConnection(m);
        } catch (err) {
          console.error('Live stream: viewer error:', err);
        }
      }
    }
  }

  /** The connection is gone unexpectedly: end every viewer so their browsers reconnect. */
  private lost(live: Live, why: string): void {
    if (live.closing) return;
    live.closing = true;
    if (this.live === live) this.live = null;
    this.tail.clear();
    this.stopConnections();
    console.error(`Live stream: shared RabbitMQ consumer lost (${why}); ending ${this.viewers.size} viewer stream(s)`);
    const ended = [...this.viewers];
    this.viewers.clear();
    this.connectionViewers = 0;
    this.disarmConnectionsTimer();
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
    this.tail.clear();
    this.stopConnections();
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
