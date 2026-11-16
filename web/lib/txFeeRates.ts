/**
 * Fee rates for the realtime table's first transactions (#198), batched and cached per txid in the browser.
 *
 * Source (from /api/runtime-config `txApi`, see lib/txApiConfig.ts):
 *   local          this deployment's /api/tx: every txid asked for within FLUSH_MS goes into one request (up to
 *                  TX_BATCH_MAX per request), so a burst of new templates costs one request, not one per row.
 *                  Historical rows pass their template's time (`at`, rounded up to the hour: /api/tx searches the
 *                  15 days before it); one request per hour of templates.
 *   mempool.space  the previous behavior, one lookup per txid (MongoDB deployments, unless configured otherwise).
 *
 * Values are what the table shows: a number (sat/vB, formatted as before) or a label:
 *   "not seen"     our node never saw it (not in its mempool, not in a block): typically a transaction the pool
 *                  added itself or got out of band. A finding, not an error.
 *   "off-mempool"  mined without ever being in our mempool (no fee data).
 *   "not found"    mempool.space doesn't know it (mempool.space source).
 *   "N/A"          no fee data, or /api/tx isn't supported here.
 *   "Error"        the lookup failed.
 */
import type { TxApiConfig } from './txApiConfig';
import type { TxInfo } from './db/tx';

export type FeeRateValue = number | string;

export const FEE_LABEL = {
  notSeen: 'not seen',
  offMempool: 'off-mempool',
  notFound: 'not found',
  na: 'N/A',
  error: 'Error',
} as const;

const DEFAULT_CONFIG: TxApiConfig = { source: 'mempool.space', mempoolSpaceFallback: false };   // the previous behavior
const FLUSH_MS = 250;   // new first transactions arrive spread over the stream: gather them
const MAX_BATCH = 100;            // lib/db/tx.ts TX_BATCH_MAX
const NOT_SEEN_TTL_MS = 30_000;   // it may still arrive: ask again after this
const CACHE_MAX = 5_000;
const CONFIG_WAIT_MS = 10_000;    // without a runtime config by then, use the previous behavior
const HOUR_MS = 3_600_000;

/** A template timestamp (collector hex nanoseconds, or an ISO string) in ms since the epoch. */
export function templateTimeMs(ts: string | undefined | null): number | undefined {
  if (!ts) return undefined;
  const hex = ts.startsWith('0x') || ts.startsWith('0X') ? ts.slice(2) : ts;
  if (/^[0-9a-f]+$/i.test(hex)) {
    const ms = Number(BigInt('0x' + hex) / BigInt(1_000_000));
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  }
  const ms = Date.parse(ts.includes('T') && !/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(ts) ? ts + 'Z' : ts);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The /api/tx `at` for a time: rounded up to the hour (shared cache entries); undefined = now. */
function atBucket(atMs: number | undefined, nowMs: number): number | undefined {
  if (atMs === undefined || !Number.isFinite(atMs) || atMs > nowMs - HOUR_MS) return undefined;
  return Math.ceil(atMs / HOUR_MS) * HOUR_MS;
}

/** Variable precision, as the table has always shown it. */
export function formatFeeRate(fee: number): number {
  if (fee >= 100) return Math.round(fee);
  if (fee < 10) return Math.round(fee * 100) / 100;
  return Math.round(fee * 10) / 10;
}

/** The previous lookup: mempool.space's CPFP-aware effective rate, else fee / vsize. */
export async function fetchMempoolSpaceFeeRate(txid: string, fetchImpl: typeof fetch = fetch): Promise<FeeRateValue> {
  try {
    let resp = await fetchImpl(`https://mempool.space/api/v1/cpfp/${txid}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.effectiveFeePerVsize) return formatFeeRate(data.effectiveFeePerVsize);
    }
    resp = await fetchImpl(`https://mempool.space/api/tx/${txid}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.fee && data.weight) return formatFeeRate(data.fee / (data.weight / 4));
    }
    return FEE_LABEL.notFound;
  } catch (err) {
    console.error('Error fetching fee rate:', err);
    return FEE_LABEL.error;
  }
}

/** What the table shows for one /api/tx answer. */
export function txInfoToFeeRate(t: Pick<TxInfo, 'found' | 'status' | 'effective_fee_rate'>): FeeRateValue {
  if (!t.found) return FEE_LABEL.notSeen;
  if (typeof t.effective_fee_rate === 'number') return formatFeeRate(t.effective_fee_rate);
  if (t.status === 'off_mempool') return FEE_LABEL.offMempool;
  return FEE_LABEL.na;
}

export interface FeeRateClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  flushMs?: number;
  maxBatch?: number;
  configWaitMs?: number;
}

interface Pending {
  resolve: (v: FeeRateValue) => void;
}

export function createFeeRateClient(opts: FeeRateClientOptions = {}) {
  const doFetch: typeof fetch = opts.fetch ?? ((...a) => fetch(...a));
  const now = opts.now ?? Date.now;
  const flushMs = opts.flushMs ?? FLUSH_MS;
  const maxBatch = opts.maxBatch ?? MAX_BATCH;

  let config: TxApiConfig | null = null;
  let configWaiters: (() => void)[] = [];
  let configTimer: ReturnType<typeof setTimeout> | null = null;
  const cache = new Map<string, { value: FeeRateValue; expires: number }>();
  const inFlight = new Map<string, Promise<FeeRateValue>>();
  let queue = new Map<number | undefined, Map<string, Pending>>();   // at bucket -> txids
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let requests = 0;   // /api/tx requests sent (tests, perf checks)

  function configure(c?: Partial<TxApiConfig> | null) {
    config = {
      source: c?.source === 'local' || c?.source === 'mempool.space' ? c.source : DEFAULT_CONFIG.source,
      mempoolSpaceFallback: c?.mempoolSpaceFallback === true,
    };
    if (configTimer) clearTimeout(configTimer);
    configTimer = null;
    const waiters = configWaiters;
    configWaiters = [];
    for (const w of waiters) w();
  }

  function configReady(): Promise<TxApiConfig> {
    if (config) return Promise.resolve(config);
    if (!configTimer) {
      configTimer = setTimeout(() => {
        if (!config) configure(DEFAULT_CONFIG);
      }, opts.configWaitMs ?? CONFIG_WAIT_MS);
    }
    return new Promise(resolve => configWaiters.push(() => resolve(config!)));
  }

  function remember(txid: string, value: FeeRateValue, ttlMs: number) {
    if (ttlMs <= 0) return;
    cache.delete(txid);
    cache.set(txid, { value, expires: now() + ttlMs });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }

  const keyOf = (txid: string, at: number | undefined) => `${txid}@${at ?? 'now'}`;

  async function lookupLocal(txids: string[], at: number | undefined, cfg: TxApiConfig): Promise<Map<string, FeeRateValue>> {
    const out = new Map<string, FeeRateValue>();
    let failure: FeeRateValue | null = null;
    try {
      requests++;
      const resp = await doFetch(`/api/tx?txids=${txids.join(',')}${at === undefined ? '' : `&at=${at}`}`);
      if (!resp.ok) throw new Error(`/api/tx: ${resp.status}`);
      const body = await resp.json() as { supported?: boolean; txs?: TxInfo[] };
      if (!body.supported || !Array.isArray(body.txs)) {
        failure = FEE_LABEL.na;
      } else {
        for (const t of body.txs) {
          const value = txInfoToFeeRate(t);
          out.set(t.txid, value);
          remember(keyOf(t.txid, at), value, value === FEE_LABEL.notSeen ? NOT_SEEN_TTL_MS : Infinity);
        }
      }
    } catch (err) {
      console.error('Error fetching fee rates:', err);
      failure = FEE_LABEL.error;
    }
    if (failure !== null) {
      if (cfg.mempoolSpaceFallback) return lookupMempoolSpace(txids, at);
      for (const t of txids) out.set(t, failure);
    }
    for (const t of txids) if (!out.has(t)) out.set(t, FEE_LABEL.error);
    return out;
  }

  async function lookupMempoolSpace(txids: string[], at: number | undefined): Promise<Map<string, FeeRateValue>> {
    const values = await Promise.all(txids.map(t => fetchMempoolSpaceFeeRate(t, doFetch)));
    const out = new Map<string, FeeRateValue>();
    txids.forEach((t, i) => {
      out.set(t, values[i]);
      if (values[i] !== FEE_LABEL.error) remember(keyOf(t, at), values[i], Infinity);
    });
    return out;
  }

  async function flush() {
    flushTimer = null;
    const batches = queue;
    queue = new Map();
    const cfg = await configReady();
    const jobs: { at: number | undefined; txids: string[]; pending: Map<string, Pending> }[] = [];
    for (const [at, pending] of batches) {
      const txids = [...pending.keys()];
      const size = cfg.source === 'local' ? maxBatch : txids.length;
      for (let i = 0; i < txids.length; i += size) jobs.push({ at, txids: txids.slice(i, i + size), pending });
    }
    await Promise.all(jobs.map(async ({ at, txids, pending }) => {
      const values = cfg.source === 'local' ? await lookupLocal(txids, at, cfg) : await lookupMempoolSpace(txids, at);
      for (const t of txids) {
        inFlight.delete(keyOf(t, at));
        pending.get(t)!.resolve(values.get(t) ?? FEE_LABEL.error);
      }
    }));
  }

  /**
   * One txid's fee rate, optionally as of a time (ms; a historical template's receive time). Requests made in the
   * same FLUSH_MS window share one /api/tx request per hour of `at`.
   */
  function get(txid: string, atMs?: number): Promise<FeeRateValue> {
    const at = atBucket(atMs, now());
    const key = keyOf(txid, at);
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return Promise.resolve(hit.value);
    const pending = inFlight.get(key);
    if (pending) return pending;
    let bucket = queue.get(at);
    if (!bucket) queue.set(at, bucket = new Map());
    const b = bucket;
    const promise = new Promise<FeeRateValue>(resolve => b.set(txid, { resolve }));
    inFlight.set(key, promise);
    if (!flushTimer) flushTimer = setTimeout(() => void flush(), flushMs);
    return promise;
  }

  /** Several txids at once (one request for all new ones), as a txid -> value map; atOf: each one's time, if any. */
  async function getMany(txids: Iterable<string>, atOf?: (txid: string) => number | undefined): Promise<Map<string, FeeRateValue>> {
    const unique = [...new Set(txids)];
    const values = await Promise.all(unique.map(t => get(t, atOf?.(t))));
    return new Map(unique.map((t, i) => [t, values[i]]));
  }

  return { configure, get, getMany, stats: () => ({ requests, cached: cache.size }) };
}

/** The browser's client, configured by DataStreamProvider from /api/runtime-config. */
export const feeRateClient = createFeeRateClient();
export const configureTxApi = (c?: Partial<TxApiConfig> | null) => feeRateClient.configure(c);
export const fetchFeeRate = (txid: string, atMs?: number) => feeRateClient.get(txid, atMs);
export const fetchFeeRates = (txids: Iterable<string>, atOf?: (txid: string) => number | undefined) =>
  feeRateClient.getMany(txids, atOf);
