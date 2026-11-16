/**
 * Shared handler for /api/tx and /api/tx/<txid> (#198). Every visitor's table asks about the same few first
 * transactions, so answers are kept per txid in-process for as long as their Cache-Control allows (txMaxAgeS), and
 * concurrent requests for a txid share one database read.
 */
import { LRUCache } from 'lru-cache';
import { enableHistoricalData } from './db/blocks';
import { isPostgres } from './db/backend';
import { getTxs, TX_BATCH_MAX, TXID_RE, txMaxAgeS, type TxInfo } from './db/tx';

const cache = new LRUCache<string, TxInfo>({ max: 20_000 });

export class TxInputError extends Error {}

/** Parse a comma-separated txid list: trimmed, lower-cased, deduplicated, at most TX_BATCH_MAX. */
export function parseTxids(raw: string | null): string[] {
  if (raw === null || raw.trim() === '') throw new TxInputError('txids is required (comma-separated, display-order hex)');
  const txids = [...new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
  if (txids.length > TX_BATCH_MAX) throw new TxInputError(`at most ${TX_BATCH_MAX} txids per request`);
  for (const t of txids) if (!TXID_RE.test(t)) throw new TxInputError(`not a txid: ${t.slice(0, 80)}`);
  return txids;
}

const HOUR_MS = 3_600_000;
const EARLIEST_MS = Date.UTC(2009, 0, 3);

/**
 * Parse `at` (ms since the epoch: when the transactions were pending, e.g. a template's receive time). Rounded up to
 * the hour, so nearby times share cache entries (the search window has a day of slack). Absent: now.
 */
export function parseAt(raw: string | null, now = Date.now()): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < EARLIEST_MS) throw new TxInputError('at must be a time in ms since the epoch');
  if (ms > now) return undefined;   // the future: same as now
  return Math.ceil(ms / HOUR_MS) * HOUR_MS;
}

/** Cached lookup: database reads only for txids not cached (or expired) for this time. */
export async function lookupTxs(txids: string[], at?: number): Promise<TxInfo[]> {
  const key = (t: string) => `${t}@${at ?? 'now'}`;
  const missing = txids.filter(t => !cache.has(key(t)));
  if (missing.length) {
    for (const t of await getTxs(missing, at)) cache.set(key(t.txid), t, { ttl: txMaxAgeS(t) * 1000 });
  }
  return txids.map(t => cache.get(key(t)) ?? { txid: t, found: false, status: 'not_seen' });
}

const json = (body: unknown, status: number, cacheControl: string) =>
  Response.json(body, { status, headers: { 'Cache-Control': cacheControl } });

/** Answer a parsed request; `single` shapes the body as { tx } instead of { txs }. */
export async function txResponse(txids: string[], single: boolean, at?: number): Promise<Response> {
  if (!enableHistoricalData || !isPostgres()) {
    // No mempool data in this deployment: answer without touching a database.
    return json({ enabled: enableHistoricalData, supported: false, ...(single ? { tx: null } : { txs: [] }) },
      200, 'public, max-age=300');
  }
  try {
    const txs = await lookupTxs(txids, at);
    const maxAge = Math.min(...txs.map(txMaxAgeS));
    return json({ enabled: true, supported: true, ...(single ? { tx: txs[0] } : { txs }) },
      200, `public, max-age=${maxAge}`);
  } catch (error: unknown) {
    console.error('Error reading transactions:', error);
    return json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500, 'no-store');
  }
}

export function badRequest(error: unknown): Response {
  return json({ error: error instanceof Error ? error.message : 'bad request' }, 400, 'no-store');
}

/** For tests. */
export function clearTxCache() {
  cache.clear();
}
