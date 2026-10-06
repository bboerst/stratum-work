import type { BlockData } from '@/lib/types';
import { TemplateChangeTracker, parseMessageTimestampMs } from '@/utils/templateChangeDetection';
import { decodeTemplate, templateMid } from './decode';
import { makeIdentifier } from './identify';
import { buildPoolView } from './poolView';
import type { Identity, PoolDef, PoolTimelineEntry, RawTemplate, RoutingStatus, Template } from './types';

export interface StoreSnapshot {
  version: number;
  byConnection: ReadonlyMap<string, readonly Template[]>; // each ordered by receivedAtMs
  blocks: ReadonlyMap<string, BlockData>; // by hash
  streamBlocks: readonly StreamBlock[]; // blocks delivered by the live stream, arrival order (last 50)
  routing: ReadonlyMap<string, RoutingStatus>; // latest per site
  pools: readonly PoolDef[] | null; // null until loaded; [] if /api/pools failed
  status: { historyUnavailable: boolean; poolsUnavailable: boolean; blocksUnavailable: boolean; connected: boolean };
}
/** A stream-delivered block with its browser arrival time (header `timestamp` routinely trails arrival). */
export interface StreamBlock { block: BlockData; rxMs: number }
export interface StoreOptions { retentionMs: number | null; notifyMs?: number; now?: () => number; schedule?: (fn: () => void, ms: number) => unknown }

const STREAM_BLOCKS_MAX = 50;
const NO_ID = (): Identity => ({ id: null, name: 'Unknown', method: 'none' });

export class TemplateStore {
  private conns = new Map<string, Template[]>();
  private trackers = new Map<string, TemplateChangeTracker>();
  private mids = new Set<string>();
  private blocks = new Map<string, BlockData>();
  private streamBlocks: StreamBlock[] = [];
  private routing = new Map<string, RoutingStatus>();
  private pools: PoolDef[] | null = null;
  private identify: (s: string, a: string[]) => Identity = NO_ID;
  private status: StoreSnapshot['status'] = { historyUnavailable: false, poolsUnavailable: false, blocksUnavailable: false, connected: false };
  private subs = new Set<() => void>();
  private version = 0;
  private snap: StoreSnapshot | null = null;
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | null = null; // only set for the default setTimeout scheduler
  private gen = 0; // invalidates stale scheduled callbacks (custom schedulers can't be cancelled)
  private viewCache = new Map<string, { v: number; view: PoolTimelineEntry[] }>();

  constructor(private opts: StoreOptions) {}

  ingest(raws: RawTemplate[]): number {
    let added = 0;
    const outOfOrder = new Set<string>();
    const cutoff = this.cutoff();
    for (const raw of raws) {
      const mid = templateMid(raw);
      if (this.mids.has(mid)) continue;
      if (cutoff !== null && parseMessageTimestampMs(raw.timestamp) < cutoff) continue; // would be evicted immediately
      const t = decodeTemplate(raw, mid, this.identify);
      if (!Number.isFinite(t.receivedAtMs)) continue;
      this.mids.add(mid);
      let arr = this.conns.get(t.connectionId);
      if (!arr) { arr = []; this.conns.set(t.connectionId, arr); }
      if (arr.length && arr[arr.length - 1].receivedAtMs > t.receivedAtMs) {
        let i = arr.length;
        while (i > 0 && arr[i - 1].receivedAtMs > t.receivedAtMs) i--;
        arr.splice(i, 0, t);
        outOfOrder.add(t.connectionId);
      } else {
        arr.push(t);
        if (!outOfOrder.has(t.connectionId)) t.change = this.tracker(t.connectionId).process({ ...raw, pool_name: t.connectionId });
      }
      added++;
    }
    for (const c of outOfOrder) this.replay(c);
    this.evict();
    if (added) this.changed();
    return added;
  }

  private tracker(c: string) {
    let tr = this.trackers.get(c);
    if (!tr) { tr = new TemplateChangeTracker(); this.trackers.set(c, tr); }
    return tr;
  }
  private replay(c: string) {
    const tr = new TemplateChangeTracker();
    this.trackers.set(c, tr);
    for (const t of this.conns.get(c)!) t.change = tr.process({ ...t.raw, pool_name: c });
  }
  private cutoff(): number | null {
    return this.opts.retentionMs === null ? null : (this.opts.now ?? Date.now)() - this.opts.retentionMs;
  }
  private evict() {
    const cutoff = this.cutoff();
    if (cutoff === null) return;
    for (const [c, arr] of this.conns) {
      let n = 0;
      while (n < arr.length && arr[n].receivedAtMs < cutoff) { this.mids.delete(arr[n].mid); n++; }
      if (n) arr.splice(0, n);
      if (!arr.length) { this.conns.delete(c); this.trackers.delete(c); }
    }
  }

  /** `source: 'stream'` also records the block in `streamBlocks` (live arrivals with rxMs, last 50, arrival order). */
  ingestBlocks(blocks: BlockData[], source: 'api' | 'stream' = 'api') {
    let n = 0;
    for (const b of blocks) {
      if (!b?.hash) continue;
      if (!this.blocks.has(b.hash)) { this.blocks.set(b.hash, b); n++; }
      if (source === 'stream' && !this.streamBlocks.some(s => s.block.hash === b.hash)) {
        this.streamBlocks.push({ block: b, rxMs: (this.opts.now ?? Date.now)() });
        if (this.streamBlocks.length > STREAM_BLOCKS_MAX) this.streamBlocks.shift();
        n++;
      }
    }
    if (n) this.changed();
  }
  ingestRouting(r: RoutingStatus) { this.routing.set(r.site, r); this.changed(); }
  setPools(pools: PoolDef[] | null) {
    this.pools = pools;
    this.identify = pools && pools.length ? makeIdentifier(pools) : NO_ID;
    for (const arr of this.conns.values()) for (const t of arr) t.identity = this.identify(t.coinbaseScriptHex, t.payoutAddresses);
    this.changed();
  }
  setStatus(p: Partial<StoreSnapshot['status']>) { this.status = { ...this.status, ...p }; this.changed(); }

  templates(): Template[] {
    return Array.from(this.conns.values()).flat().sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  }
  poolNames(): string[] {
    const names = new Set<string>();
    for (const arr of this.conns.values()) for (const t of arr) if (t.pool) names.add(t.pool);
    return Array.from(names).sort();
  }
  poolView(pool: string): PoolTimelineEntry[] {
    const hit = this.viewCache.get(pool);
    if (hit && hit.v === this.version) return hit.view;
    const view = buildPoolView(Array.from(this.conns.values()).flat().filter(t => t.pool === pool));
    this.viewCache.set(pool, { v: this.version, view });
    return view;
  }

  subscribe(fn: () => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  getSnapshot(): StoreSnapshot {
    if (!this.snap) {
      this.snap = { version: this.version, byConnection: new Map(this.conns), blocks: this.blocks, streamBlocks: this.streamBlocks.slice(), routing: this.routing, pools: this.pools, status: this.status };
    }
    return this.snap;
  }
  flush() {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.gen++;
    if (this.pending) { this.pending = false; this.subs.forEach(f => f()); }
  }

  private changed() {
    this.version++;
    this.snap = null;
    this.viewCache.clear();
    if (this.pending) return;
    this.pending = true;
    const g = this.gen;
    const run = () => { if (g === this.gen) { this.timer = null; this.flush(); } };
    const ms = this.opts.notifyMs ?? 250;
    if (this.opts.schedule) this.opts.schedule(run, ms);
    else this.timer = setTimeout(run, ms);
  }
}
