import type pg from 'pg';
import { toRawMessage } from './message.js';
import type { StreamState } from './server.js';
import { loadRecentBlocks, loadRecentRouting, loadRecentTemplates } from './db.js';
import { blockRowToMessage, templateRowToJson } from './serialize.js';
import { computeMid } from './mid.js';
import { m } from './metrics.js';

/**
 * Replays recent history from Postgres into the state, adding each ingested mid to `mids`.
 * Stops ingesting as soon as `signal` is aborted so a timed-out warm-up cannot interleave with live traffic.
 */
export async function warmUp(db: pg.Pool, state: StreamState, sinceMs: number, mids = new Set<string>(), signal?: AbortSignal): Promise<Set<string>> {
  const ingest = (body: Buffer, rx: number, mid: string) => {
    if (signal?.aborted) return;
    const msg = toRawMessage(body, rx);
    if (!msg) return;
    msg.mid = mid; mids.add(mid); state.ingest(msg, 'warmup');
  };
  for (const { row, mid } of await loadRecentTemplates(db, sinceMs)) {
    ingest(Buffer.from(JSON.stringify(templateRowToJson(row))), row.ts.getTime(), mid);
  }
  for (const r of await loadRecentRouting(db, sinceMs)) {
    ingest(Buffer.from(JSON.stringify(r.status)), r.ts.getTime(), r.mid.toString('hex'));
  }
  for (const b of await loadRecentBlocks(db)) {
    const body = Buffer.from(JSON.stringify(blockRowToMessage(b)));
    ingest(body, Number(b.timestamp) * 1000, computeMid(body));
  }
  return mids;
}

/**
 * Warm-up that never throws and never hangs past `timeoutMs`: on failure it logs, counts
 * `stream_warmup_failures_total` and returns whatever was loaded so the pod starts (partially) cold.
 */
export async function safeWarmUp(db: pg.Pool, state: StreamState, sinceMs: number, timeoutMs: number): Promise<Set<string>> {
  const mids = new Set<string>();
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`warm-up timed out after ${timeoutMs} ms`)), timeoutMs); });
  try {
    await Promise.race([warmUp(db, state, sinceMs, mids, ctrl.signal), timeout]);
  } catch (e) {
    ctrl.abort();
    m.warmupFailures.inc();
    console.error(`stream: warm-up failed, starting cold (${mids.size} messages loaded): ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  return mids;
}

/**
 * Holds live deliveries until warm-up finishes, then flushes them with their arrival rx.
 * Deliveries whose mid was loaded by warm-up are skipped for `skipWindowMs` after opening, which covers
 * the broker backlog that was still waiting beyond the prefetch window.
 */
export class LiveGate {
  private buffered: Array<{ body: Buffer; rx: number; ack: () => void }> = [];
  private skip = new Set<string>();
  private skipUntil = 0;
  open = false;
  constructor(private state: StreamState, private opts: { skipWindowMs: number; now?: () => number }) {}
  private now() { return this.opts.now?.() ?? Date.now(); }
  private ingest(body: Buffer, rx: number) {
    const raw = toRawMessage(body, rx);
    if (!raw) return;
    if (this.skip.size) {
      if (this.now() > this.skipUntil) this.skip = new Set();
      else if (this.skip.has(raw.mid)) return;
    }
    this.state.ingest(raw);
  }
  deliver(body: Buffer, ack: () => void) {
    const rx = this.now();
    if (!this.open) { this.buffered.push({ body, rx, ack }); return; }
    this.ingest(body, rx); ack();
  }
  release(warmMids: Set<string>) {
    this.skip = warmMids; this.skipUntil = this.now() + this.opts.skipWindowMs;
    for (const { body, rx, ack } of this.buffered.splice(0)) { this.ingest(body, rx); ack(); }
    this.open = true;
  }
}
