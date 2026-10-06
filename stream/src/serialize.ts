import type { RawMessage } from './message.js';
import { LEGACY_SITE } from './message.js';

export const KNOWN_TEMPLATE_KEYS = [
  '_id', 'timestamp', 'pool_name', 'height', 'job_id', 'prev_hash', 'coinbase1', 'coinbase2', 'merkle_branches',
  'version', 'nbits', 'ntime', 'clean_jobs', 'extranonce1', 'extranonce2_length', 'lat_ms', 'lat_m', 'chain_family',
  'site', 'connection_id', 'mode', 'account', 'endpoint_ip',
] as const;

export interface TemplateRow {
  ts: Date; ts_ns: string; mid: Buffer; doc_id: string | null; pool: string; connection_id: string; site: string;
  mode: string; account: string | null; endpoint_ip: string | null; height: number; prev_hash: string; job_id: string;
  version: string; nbits: string | null; ntime: string | null; clean_jobs: boolean; coinbase1: string; coinbase2: string;
  extranonce1: string | null; extranonce2_length: number; merkle_branches: string[]; chain_family: string | null;
  lat_ms: number | null; lat_m: string | null; extra: Record<string, unknown> | null;
}

export function messageToTemplateRow(msg: RawMessage): TemplateRow {
  const j = msg.json;
  const tsNs = BigInt('0x' + String(j.timestamp));
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(j)) if (!(KNOWN_TEMPLATE_KEYS as readonly string[]).includes(k)) extra[k] = v;
  return {
    ts: new Date(Number(tsNs / 1_000_000n)), ts_ns: tsNs.toString(), mid: Buffer.from(msg.mid, 'hex'),
    doc_id: j._id ?? null, pool: j.pool_name, connection_id: j.connection_id ?? j.pool_name,
    site: j.site ?? LEGACY_SITE, mode: j.mode ?? 'observe', account: j.account ?? null, endpoint_ip: j.endpoint_ip ?? null,
    height: j.height, prev_hash: j.prev_hash, job_id: String(j.job_id), version: j.version, nbits: j.nbits ?? null,
    ntime: j.ntime ?? null, clean_jobs: j.clean_jobs === true || j.clean_jobs === 'true', coinbase1: j.coinbase1,
    coinbase2: j.coinbase2, extranonce1: j.extranonce1 ?? null, extranonce2_length: j.extranonce2_length,
    merkle_branches: j.merkle_branches ?? [], chain_family: j.chain_family ?? null, lat_ms: j.lat_ms ?? null,
    lat_m: j.lat_m ?? null, extra: Object.keys(extra).length ? extra : null,
  };
}

export function templateRowToJson(r: TemplateRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (r.doc_id !== null) out._id = r.doc_id;
  out.timestamp = BigInt(r.ts_ns).toString(16);
  Object.assign(out, {
    pool_name: r.pool, height: r.height, job_id: r.job_id, prev_hash: r.prev_hash, coinbase1: r.coinbase1,
    coinbase2: r.coinbase2, merkle_branches: r.merkle_branches, version: r.version,
  });
  if (r.nbits !== null) out.nbits = r.nbits;
  if (r.ntime !== null) out.ntime = r.ntime;
  out.clean_jobs = r.clean_jobs;
  out.extranonce1 = r.extranonce1;
  out.extranonce2_length = r.extranonce2_length;
  if (r.lat_ms !== null) out.lat_ms = r.lat_ms;
  if (r.lat_m !== null) out.lat_m = r.lat_m;
  if (r.chain_family !== null) out.chain_family = r.chain_family;
  const legacyConn = r.site === LEGACY_SITE && r.connection_id === r.pool && r.mode === 'observe';
  if (!legacyConn) { out.site = r.site; out.connection_id = r.connection_id; out.mode = r.mode; }
  if (r.account !== null) out.account = r.account;
  if (r.endpoint_ip !== null) out.endpoint_ip = r.endpoint_ip;
  if (r.extra) Object.assign(out, r.extra);
  return out;
}

export function blockRowToMessage(b: { block_hash: string; height: number; timestamp: string | number; mining_pool: unknown; analysis: unknown }) {
  const iso = new Date(Number(b.timestamp) * 1000).toISOString();
  return { type: 'block', id: b.block_hash, timestamp: iso, data: { hash: b.block_hash, height: b.height, timestamp: iso, mining_pool: b.mining_pool, analysis: b.analysis } };
}
