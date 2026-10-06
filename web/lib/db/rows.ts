export const LEGACY_SITE = 'us-ash-legacy';

export interface TemplateRow {
  ts: Date; ts_ns: string; mid: Buffer; doc_id: string | null; pool: string; connection_id: string; site: string;
  mode: string; account: string | null; endpoint_ip: string | null; height: number; prev_hash: string; job_id: string;
  version: string; nbits: string | null; ntime: string | null; clean_jobs: boolean; coinbase1: string; coinbase2: string;
  extranonce1: string | null; extranonce2_length: number; merkle_branches: string[]; chain_family: string | null;
  lat_ms: number | null; lat_m: string | null; extra: Record<string, unknown> | null;
}

/** A template in the collector's `mining_notify` document shape, plus `id`. */
export interface MiningNotifyDoc {
  id: string;
  _id?: string;
  timestamp: string;
  pool_name: string;
  height: number;
  job_id: string;
  prev_hash: string;
  coinbase1: string;
  coinbase2: string;
  merkle_branches: string[];
  version: string;
  nbits?: string;
  ntime?: string;
  clean_jobs: boolean;
  extranonce1: string | null;
  extranonce2_length: number;
  lat_ms?: number;
  lat_m?: string;
  chain_family?: string;
  site?: string;
  connection_id?: string;
  mode?: string;
  account?: string;
  endpoint_ip?: string;
  [key: string]: unknown;
}

export function templateRowToDoc(r: TemplateRow): MiningNotifyDoc {
  const out: Record<string, unknown> = { id: r.doc_id ?? r.mid.toString('hex') };
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
  return out as MiningNotifyDoc;
}

export interface BlockRow {
  height: number;
  block_hash: string;
  timestamp: string | number;
  coinbase_script_sig?: string | null;
  mining_pool: Record<string, unknown> | null;
  analysis: Record<string, unknown> | null;
  transactions?: number | null;
  size?: number | null;
  weight?: number | null;
  version?: string | number | null;
  merkle_root?: string | null;
  bits?: string | null;
  nonce?: string | number | null;
  difficulty?: number | null;
}

export interface BlockDoc {
  id: string;
  height: number;
  block_hash: string;
  timestamp: number;
  coinbase_script_sig: string | null;
  pool: Record<string, unknown> | null;
  transactions: number | null;
  size: number | null;
  weight: number | null;
  version: number | null;
  merkle_root: string | null;
  bits: string | null;
  nonce: number | null;
  difficulty: number | null;
  mining_pool: Record<string, unknown> | null;
  analysis: Record<string, unknown> | null;
}

const toNum = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

export function blockRowToDoc(b: BlockRow): BlockDoc {
  return {
    id: b.block_hash,
    height: b.height,
    block_hash: b.block_hash,
    timestamp: Number(b.timestamp),
    coinbase_script_sig: b.coinbase_script_sig ?? null,
    pool: b.mining_pool,
    transactions: b.transactions ?? null,
    size: b.size ?? null,
    weight: b.weight ?? null,
    version: toNum(b.version),
    merkle_root: b.merkle_root ?? null,
    bits: b.bits ?? null,
    nonce: toNum(b.nonce),
    difficulty: b.difficulty ?? null,
    mining_pool: b.mining_pool,
    analysis: b.analysis,
  };
}
