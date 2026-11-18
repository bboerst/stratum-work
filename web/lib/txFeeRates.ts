/**
 * Fee rates for the realtime table's first transactions (#198), batched and cached per txid in the browser.
 *
 * Source (from /api/runtime-config `txApi`, see lib/txApiConfig.ts):
 *   local          this deployment's /api/tx: every txid asked for within FLUSH_MS goes into one request (up to
 *                  TX_BATCH_MAX per request), so a burst of new templates costs one request, not one per row.
 *                  Historical rows pass their template's time (`at`, rounded up to the hour: /api/tx searches the
 *                  15 days before it); one request per hour of templates.
 *   mempool.space  one lookup per txid (historical data disabled, or configured).
 *
 * Values are what the table shows: the transaction's OWN fee rate, fee / vsize (sat/vB, formatted as before), or a
 * label. A child paying for it (CPFP) doesn't change the number: which transactions a pool includes, and why, isn't
 * in the template (it reveals only the first txid), so a package rate would be a model, not an observation. The
 * child is reported next to it instead (childOf: txid, when seen, the package rate, whether it was mined in the same
 * block), as our node saw it (local) or as mempool.space lists it (mempool.space source). For the first transaction
 * the own rate is also its ancestor-package rate: in a valid block it can't have unconfirmed parents (only the
 * coinbase comes before it). Labels:
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

/** A child spending the transaction (the one with the highest package rate), shown beside the own rate. */
export interface FeeRateChild {
  txid: string;
  packageFeeRate: number;        // sat/vB of the child with its ancestors (this transaction included)
  firstSeen: number | null;      // ms since the epoch, when our node first saw the child (null: mempool.space)
  sameBlock: boolean | null;     // once this transaction is mined: the child was in the same block (null: unknown)
  source: 'local' | 'mempool.space';
}

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

/**
 * mempool.space: the own rate from /api/tx (fee / (weight / 4)), and the child with the highest package rate from
 * /api/v1/cpfp (descendants with fee and weight; its effectiveFeePerVsize is the cluster rate, not used as the value).
 */
export async function fetchMempoolSpaceFeeRate(txid: string, fetchImpl: typeof fetch = fetch):
    Promise<{ value: FeeRateValue; child: FeeRateChild | null }> {
  try {
    const resp = await fetchImpl(`https://mempool.space/api/tx/${txid}`);
    if (!resp.ok) return { value: FEE_LABEL.notFound, child: null };
    const data = await resp.json();
    if (!data.fee || !data.weight) return { value: FEE_LABEL.notFound, child: null };
    const vsize = data.weight / 4;
    let child: FeeRateChild | null = null;
    try {
      const c = await fetchImpl(`https://mempool.space/api/v1/cpfp/${txid}`);
      if (c.ok) {
        const cp = await c.json();
        for (const d of Array.isArray(cp.descendants) ? cp.descendants : []) {
          if (typeof d?.txid !== 'string' || !d.fee || !d.weight) continue;
          const rate = (data.fee + d.fee) / (vsize + d.weight / 4);
          if (!child || rate > child.packageFeeRate) {
            child = { txid: d.txid, packageFeeRate: rate, firstSeen: null, sameBlock: null, source: 'mempool.space' };
          }
        }
      }
    } catch { /* the own rate stands without the child */ }
    return { value: formatFeeRate(data.fee / vsize), child };
  } catch (err) {
    console.error('Error fetching fee rate:', err);
    return { value: FEE_LABEL.error, child: null };
  }
}

/** What the table shows for one /api/tx answer: the own rate (fee / vsize). */
export function txInfoToFeeRate(t: Pick<TxInfo, 'found' | 'status' | 'fee_rate'>): FeeRateValue {
  if (!t.found) return FEE_LABEL.notSeen;
  if (typeof t.fee_rate === 'number') return formatFeeRate(t.fee_rate);
  if (t.status === 'off_mempool') return FEE_LABEL.offMempool;
  return FEE_LABEL.na;
}

/** The child /api/tx reported, in the table's terms. */
export function txInfoToChild(t: Pick<TxInfo, 'child'>): FeeRateChild | null {
  const c = t.child;
  if (!c) return null;
  return { txid: c.txid, packageFeeRate: c.package_fee_rate, firstSeen: c.first_seen, sameBlock: c.same_block, source: 'local' };
}

/** The marker's tooltip: what was observed, and by whom. */
export function childTitle(c: FeeRateChild): string {
  const pkg = `${formatFeeRate(c.packageFeeRate)} sat/vB`;
  const seen = c.source === 'local'
    ? `Our node saw a transaction spending it (${c.txid}${c.firstSeen ? `, first seen ${new Date(c.firstSeen).toISOString()}` : ''}).`
    : `mempool.space lists a transaction spending it (${c.txid}).`;
  const block = c.sameBlock === true ? ' Both were mined in the same block.'
    : c.sameBlock === false ? ' The child was not mined in the same block.' : '';
  return `The number is this transaction's own fee rate. ${seen} Together they pay ${pkg} (child pays for parent).${block}`;
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
  const children = new Map<string, FeeRateChild>();   // txid -> its child, from the latest answer
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

  function rememberChild(txid: string, child: FeeRateChild | null) {
    children.delete(txid);
    if (child) children.set(txid, child);
    if (children.size > CACHE_MAX) children.delete(children.keys().next().value!);
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
          rememberChild(t.txid, txInfoToChild(t));
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
    const answers = await Promise.all(txids.map(t => fetchMempoolSpaceFeeRate(t, doFetch)));
    const out = new Map<string, FeeRateValue>();
    txids.forEach((t, i) => {
      const { value, child } = answers[i];
      out.set(t, value);
      rememberChild(t, child);
      if (value !== FEE_LABEL.error) remember(keyOf(t, at), value, Infinity);
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

  /** The child spending txid that the latest answer reported, if any (set before that answer's value resolves). */
  function childOf(txid: string | undefined | null): FeeRateChild | null {
    return txid ? children.get(txid) ?? null : null;
  }

  return { configure, get, getMany, childOf, stats: () => ({ requests, cached: cache.size }) };
}

/** The browser's client, configured by DataStreamProvider from /api/runtime-config. */
export const feeRateClient = createFeeRateClient();
export const configureTxApi = (c?: Partial<TxApiConfig> | null) => feeRateClient.configure(c);
export const fetchFeeRate = (txid: string, atMs?: number) => feeRateClient.get(txid, atMs);
export const feeRateChildOf = (txid: string | undefined | null) => feeRateClient.childOf(txid);
export const fetchFeeRates = (txids: Iterable<string>, atOf?: (txid: string) => number | undefined) =>
  feeRateClient.getMany(txids, atOf);
