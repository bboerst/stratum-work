import pg from 'pg';
import { messageToTemplateRow, type TemplateRow } from './serialize.js';
import { toRawMessage, type RawMessage } from './message.js';
import { computeMid } from './mid.js';

export class Batcher<T> {
  private items: T[] = [];
  private waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  constructor(private opts: { maxItems: number; maxMs: number; flush: (items: T[]) => Promise<void> }) {}

  add(item: T): Promise<void> {
    return new Promise((resolve, reject) => {
      this.items.push(item);
      this.waiters.push({ resolve, reject });
      if (this.items.length >= this.opts.maxItems) this.flushNow();
      else if (!this.timer) this.timer = setTimeout(() => this.flushNow(), this.opts.maxMs);
    });
  }

  private flushNow() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const items = this.items, waiters = this.waiters;
    this.items = []; this.waiters = [];
    if (!items.length) return;
    this.chain = this.chain.then(async () => {
      try { await this.opts.flush(items); waiters.forEach(w => w.resolve()); }
      catch (e) { waiters.forEach(w => w.reject(e)); }
    });
  }
}

export type IngestItem =
  | { kind: 'template'; row: TemplateRow }
  | { kind: 'share'; msg: RawMessage }
  | { kind: 'routing'; msg: RawMessage };
export type DropReason = 'unparseable' | 'unsupported_kind' | 'invalid_template' | 'invalid_share' | 'invalid_routing';
export type Delivery = { item: IngestItem; mid: string } | { drop: DropReason; mid: string; detail: string };

const INT32_MAX = 2 ** 31 - 1;
const INT64_MAX = 2n ** 63n - 1n;
const HEX = /^[0-9a-f]+$/i;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt32 = (v: unknown) => Number.isInteger(v) && (v as number) >= -INT32_MAX - 1 && (v as number) <= INT32_MAX;
const isOptNum = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v));

const REQUIRED_TEMPLATE_TEXT = ['pool', 'connection_id', 'site', 'mode', 'prev_hash', 'job_id', 'version', 'coinbase1', 'coinbase2'] as const;

/** Returns the first NOT NULL / type violation that would make Postgres reject the row, or null. */
export function templateRowProblem(row: TemplateRow): string | null {
  if (!(row.ts instanceof Date) || Number.isNaN(row.ts.getTime())) return 'ts';
  if (!isStr(row.ts_ns) || !/^\d+$/.test(row.ts_ns) || BigInt(row.ts_ns) > INT64_MAX) return 'ts_ns';
  if (!Buffer.isBuffer(row.mid) || row.mid.length !== 16) return 'mid';
  for (const c of REQUIRED_TEMPLATE_TEXT) if (!isStr(row[c])) return c;
  if (!isInt32(row.height)) return 'height';
  if (typeof row.clean_jobs !== 'boolean') return 'clean_jobs';
  if (!isInt32(row.extranonce2_length)) return 'extranonce2_length';
  if (!Array.isArray(row.merkle_branches) || !row.merkle_branches.every(isStr)) return 'merkle_branches';
  if (!isOptNum(row.lat_ms)) return 'lat_ms';
  return null;
}

export const isValidTemplateRow = (row: TemplateRow) => templateRowProblem(row) === null;

function hexTimestampProblem(v: unknown): string | null {
  return isStr(v) && HEX.test(v) && BigInt('0x' + v) <= INT64_MAX ? null : 'timestamp';
}

function shareProblem(j: Record<string, any>): string | null {
  const t = hexTimestampProblem(j.timestamp);
  if (t) return t;
  for (const c of ['pool_name', 'site', 'connection_id']) if (!isStr(j[c])) return c;
  for (const c of ['share_difficulty', 'pool_difficulty', 'response_ms']) if (!isOptNum(j[c])) return c;
  return null;
}

function routingProblem(j: Record<string, any>): string | null {
  return hexTimestampProblem(j.timestamp) ?? (isStr(j.site) ? null : 'site');
}

/**
 * Parses and validates one broker delivery. Anything that would make a batch INSERT fail is
 * returned as a drop so it can be acked instead of poisoning the batch forever.
 * `detail` names the offending field only; it never contains message content.
 */
export function prepareDelivery(body: Buffer, rx: number): Delivery {
  const raw = toRawMessage(body, rx);
  if (!raw) return { drop: 'unparseable', mid: computeMid(body), detail: `${body.length} bytes` };
  const mid = raw.mid;
  if (raw.kind !== 'template' && raw.kind !== 'share' && raw.kind !== 'routing') return { drop: 'unsupported_kind', mid, detail: raw.kind };
  const invalid = `invalid_${raw.kind}` as const;
  // Postgres text and jsonb both reject U+0000.
  if (raw.body.includes('\\u0000')) return { drop: invalid, mid, detail: 'NUL character' };
  if (raw.kind === 'template') {
    if (raw.json.job_id === undefined || raw.json.job_id === null) return { drop: invalid, mid, detail: 'job_id' };
    const tsProblem = hexTimestampProblem(raw.json.timestamp);
    if (tsProblem) return { drop: invalid, mid, detail: tsProblem };
    const row = messageToTemplateRow(raw);
    const problem = templateRowProblem(row);
    return problem ? { drop: invalid, mid, detail: problem } : { item: { kind: 'template', row }, mid };
  }
  const problem = raw.kind === 'share' ? shareProblem(raw.json) : routingProblem(raw.json);
  return problem ? { drop: invalid, mid, detail: problem } : { item: { kind: raw.kind, msg: raw }, mid };
}

const TEMPLATE_COLS = ['ts', 'ts_ns', 'mid', 'doc_id', 'pool', 'connection_id', 'site', 'mode', 'account', 'endpoint_ip', 'height', 'prev_hash', 'job_id', 'version', 'nbits', 'ntime', 'clean_jobs', 'coinbase1', 'coinbase2', 'extranonce1', 'extranonce2_length', 'merkle_branches', 'chain_family', 'lat_ms', 'lat_m', 'extra'] as const;
const MAX_PARAMS = 65535;

function multiInsert(table: string, cols: readonly string[], rows: unknown[][], conflict: string) {
  const values: unknown[] = [];
  const tuples = rows.map((r, i) => '(' + r.map((v, j) => { values.push(v); return `$${i * cols.length + j + 1}`; }).join(',') + ')');
  return { text: `INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT ${conflict} DO NOTHING`, values };
}

async function insertChunked(pool: pg.Pool, table: string, cols: readonly string[], rows: unknown[][]): Promise<number> {
  const perQuery = Math.floor(MAX_PARAMS / cols.length);
  let inserted = 0;
  for (let i = 0; i < rows.length; i += perQuery) {
    inserted += (await pool.query(multiInsert(table, cols, rows.slice(i, i + perQuery), '(mid, ts)'))).rowCount ?? 0;
  }
  return inserted;
}

export async function insertTemplates(pool: pg.Pool, rows: TemplateRow[]): Promise<number> {
  if (!rows.length) return 0;
  return insertChunked(pool, 'templates', TEMPLATE_COLS, rows.map(r => TEMPLATE_COLS.map(c => c === 'extra' && r.extra ? JSON.stringify(r.extra) : r[c])));
}

const hexNsToDate = (hex: string) => new Date(Number(BigInt('0x' + hex) / 1_000_000n));

const SHARE_COLS = ['ts', 'mid', 'connection_id', 'pool', 'site', 'job_id', 'share_difficulty', 'pool_difficulty', 'accepted', 'reject_reason', 'response_ms'] as const;

export async function insertShares(pool: pg.Pool, msgs: RawMessage[]): Promise<number> {
  if (!msgs.length) return 0;
  const rows = msgs.map(m => { const j = m.json; return [hexNsToDate(j.timestamp), Buffer.from(m.mid, 'hex'), j.connection_id, j.pool_name, j.site, j.job_id ?? null, j.share_difficulty ?? null, j.pool_difficulty ?? null, !!j.accepted, j.reject_reason ?? null, j.response_ms ?? null]; });
  return insertChunked(pool, 'shares', SHARE_COLS, rows);
}

export async function insertRouting(pool: pg.Pool, msgs: RawMessage[]): Promise<number> {
  if (!msgs.length) return 0;
  const rows = msgs.map(m => [hexNsToDate(m.json.timestamp), Buffer.from(m.mid, 'hex'), m.json.site, JSON.stringify(m.json)]);
  return insertChunked(pool, 'routing', ['ts', 'mid', 'site', 'status'], rows);
}

export async function loadRecentTemplates(pool: pg.Pool, sinceMs: number): Promise<Array<{ row: TemplateRow; mid: string }>> {
  const res = await pool.query(`SELECT * FROM templates WHERE ts >= to_timestamp($1 / 1000.0) ORDER BY ts`, [sinceMs]);
  return res.rows.map((row: TemplateRow) => ({ row, mid: row.mid.toString('hex') }));
}

export async function loadRecentBlocks(pool: pg.Pool, limit = 10) {
  const res = await pool.query(`SELECT block_hash, height, timestamp, mining_pool, analysis FROM blocks ORDER BY height DESC LIMIT $1`, [limit]);
  return res.rows.reverse();
}

export async function loadRecentRouting(pool: pg.Pool, sinceMs: number) {
  const res = await pool.query(`SELECT ts, mid, status FROM routing WHERE ts >= to_timestamp($1 / 1000.0) ORDER BY ts`, [sinceMs]);
  return res.rows as Array<{ ts: Date; mid: Buffer; status: Record<string, unknown> }>;
}
