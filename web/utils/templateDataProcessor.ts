import { StratumV1Data } from '@/lib/types';
import { toOpReturnData } from './bitcoinUtils';
import { parseCoinbase, ParsedCoinbase, ByteRange } from './coinbaseParser';
import { decodeOpReturnScript } from './mergeMining';

/**
 * A template as change detection compares it: the mining.notify fields normalised the way the collector stores them,
 * and the coinbase from coinbaseParser's byte map (the parser behind the template details), the only parser used here.
 */
export interface ProcessedTemplateData {
  poolName: string;
  height: number;
  prevHash: string;
  version: string;
  nbits?: string;
  ntime?: string;
  cleanJobs: boolean; // normalised (cleanJobsFlag)
  merkleBranches: string[];
  extranonce2Length: number;

  /** Which of our connections received it (`site/replica` on the stream, `source_id` on history), or null. */
  connection: string | null;

  /** OP_RETURN outputs, keyed by protocol name (" #2", " #3"... for repeats). Empty when the coinbase doesn't parse. */
  opReturnProtocols: Map<string, OpReturnEntry>;

  /** The coinbase as the pool wrote it, with the extranonce bytes left out (they are per connection and per share). */
  coinbase: CoinbaseContent;
}

export interface CoinbaseContent {
  /** coinbaseParser parsed the whole transaction. When false, only coinbase1/coinbase2 as a whole can be compared. */
  parsed: boolean;
  version: number | null;
  sequence: number | null;
  /** nSequence as hex with extranonce bytes as "..": some pools let the extranonce run into it. */
  sequenceMasked: string;
  locktime: number | null;
  /** The input's prevout (always null in a valid coinbase; compared because nothing else covers it). */
  prevout: string;
  /** The coinbase witness (hex), when the coinbase is sent in segwit serialization; '' otherwise. */
  witness: string;
  /** Every scriptSig byte the pool wrote, extranonce bytes as "..". Equal means the scriptSig didn't change. */
  scriptSigPool: string;
  /** scriptSig text tags, in full (the display tag is cut to 80 characters). */
  scriptSigTags: string;
  /** A pushed 4-byte Unix time in the scriptSig (the pool's clock), or null. */
  scriptSigTime: number | null;
  /** The scriptSig's other pushed bytes (counters, nonces, binary ids), one hex string per run, joined with "|". */
  scriptSigData: string;
  /** The merge-mining commitment in the scriptSig, or null. */
  auxpow: { root: string; merkleSize: number | null; nonce: number | null } | null;
  /** Each output's value (satoshis), in order. */
  outputValues: number[];
  /** Each output's script (hex, extranonce bytes as ".."), in order. */
  outputScripts: string[];
  /** Each output's OP_RETURN protocol name, or null for other scripts, in order. */
  outputProtocols: (string | null)[];
  /** extranonce1 as served (masked on the public site, #105: equal within a pool for the same session). */
  extranonce1: string;
  /** coinbase1 and coinbase2 as sent (lower-case hex), for templates that don't parse. */
  coinbase1: string;
  coinbase2: string;
}

/** One OP_RETURN output in `opReturnProtocols`. `cmp` is what change detection compares. */
export interface OpReturnEntry {
  protocol: string;
  index: number; // output position
  value: number;
  script: string; // hex, extranonce bytes as ".."
  dataHex: string;
  details?: Record<string, unknown>;
  cmp: string;
}

// Cache for processed template data to avoid re-processing
const processedDataCache = new Map<string, ProcessedTemplateData>();
const MAX_PROCESSED_DATA_CACHE_SIZE = 150;

/** Key repeats of a protocol " #2", " #3"... in output order, so they don't overwrite each other. */
function keyed<T>(items: { protocol: string; entry: T }[]): Map<string, T> {
  const out = new Map<string, T>();
  const seen = new Map<string, number>();
  for (const { protocol, entry } of items) {
    const n = (seen.get(protocol) ?? 0) + 1;
    seen.set(protocol, n);
    out.set(n === 1 ? protocol : `${protocol} #${n}`, entry);
  }
  return out;
}

const EMPTY_COINBASE: Omit<CoinbaseContent, 'extranonce1' | 'coinbase1' | 'coinbase2'> = {
  parsed: false, version: null, sequence: null, sequenceMasked: '', locktime: null, prevout: '', witness: '', scriptSigPool: '', scriptSigTags: '',
  scriptSigTime: null, scriptSigData: '', auxpow: null, outputValues: [], outputScripts: [], outputProtocols: [],
};

function hexToBytesSafe(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/**
 * The template's coinbase content, from coinbaseParser's byte map (the parser behind the template details), without
 * the extranonce bytes, which belong to our connection (extranonce1) and the miner (extranonce2, zeros here). Also
 * returns the OP_RETURN outputs, decoded from the same parse.
 */
export function coinbaseContent(
  data: Pick<StratumV1Data, 'coinbase1' | 'extranonce1' | 'extranonce2_length' | 'coinbase2' | 'ntime'>,
): { content: CoinbaseContent; opReturns: Map<string, OpReturnEntry> } {
  const extranonce1 = (data.extranonce1 || '').toLowerCase();
  const coinbase1 = (data.coinbase1 || '').toLowerCase();
  const coinbase2 = (data.coinbase2 || '').toLowerCase();
  const ntime = data.ntime && /^[0-9a-fA-F]{1,8}$/.test(data.ntime) ? parseInt(data.ntime, 16) : undefined;
  const en2 = Number(data.extranonce2_length);
  const parsed: ParsedCoinbase = parseCoinbase(coinbase1, extranonce1, en2, coinbase2, { ntime });
  if (!parsed.ok || !parsed.scriptSig) return { content: { ...EMPTY_COINBASE, extranonce1, coinbase1, coinbase2 }, opReturns: new Map() };
  const tx = coinbase1 + extranonce1 + '00'.repeat(en2) + coinbase2;
  const en: ByteRange = { start: parsed.extranonce1.start, end: parsed.extranonce2.end };
  const masked = (r: ByteRange) => {
    if (r.end <= en.start || en.end <= r.start) return tx.slice(r.start * 2, r.end * 2);
    const from = Math.max(r.start, en.start), to = Math.min(r.end, en.end);
    return tx.slice(r.start * 2, from * 2) + '..'.repeat(to - from) + tx.slice(to * 2, r.end * 2);
  };
  const hexOf = (r: ByteRange) => tx.slice(r.start * 2, r.end * 2);

  const tags: string[] = [];
  const dataRuns: string[] = [];
  for (const seg of parsed.scriptSig.segments) {
    if (seg.kind === 'tag') tags.push(seg.text ?? '');
    else if (seg.kind === 'data') dataRuns.push(hexOf(seg));
  }

  const prevoutField = parsed.fields.find(f => f.kind === 'prevout');
  const witnessField = parsed.fields.find(f => f.kind === 'witness');
  const sequenceField = parsed.fields.find(f => f.kind === 'sequence');
  const aux = parsed.scriptSig.auxpow;

  const outputProtocols: (string | null)[] = [];
  const items: { protocol: string; entry: OpReturnEntry }[] = [];
  parsed.outputs.forEach((o, index) => {
    const decoded = tx.startsWith('6a', o.script.start * 2) && o.script.end > o.script.start
      ? decodeOpReturnScript(hexToBytesSafe(hexOf(o.script))) : null;
    if (!decoded) {
      outputProtocols.push(null);
      return;
    }
    // An OP_RETURN holding the extranonce carries per-connection bytes, not a commitment (mergeMining's carrier).
    const carrier = o.script.start < en.end && en.start < o.script.end;
    const legacy = toOpReturnData(decoded);
    const protocol = carrier ? 'Extranonce carrier' : legacy.protocol || 'Unknown';
    const script = masked(o.script);
    outputProtocols.push(protocol);
    items.push({ protocol, entry: {
      protocol, index, value: o.value, script, dataHex: carrier ? '' : legacy.dataHex,
      details: legacy.details as Record<string, unknown> | undefined, cmp: `${o.value}|${script}`,
    } });
  });

  return {
    content: {
      parsed: true,
      version: parsed.version ?? null,
      sequence: parsed.sequence ?? null,
      sequenceMasked: sequenceField ? masked(sequenceField) : '',
      locktime: parsed.locktime ?? null,
      prevout: prevoutField ? hexOf(prevoutField) : '',
      witness: witnessField ? hexOf(witnessField) : '',
      scriptSigPool: masked(parsed.scriptSig),
      scriptSigTags: tags.join('|'),
      scriptSigTime: parsed.scriptSig.time,
      scriptSigData: dataRuns.join('|'),
      auxpow: aux ? { root: aux.root, merkleSize: aux.merkleSize ?? null, nonce: aux.nonce ?? null } : null,
      outputValues: parsed.outputs.map(o => o.value),
      outputScripts: parsed.outputs.map(o => masked(o.script)),
      outputProtocols,
      extranonce1,
      coinbase1,
      coinbase2,
    },
    opReturns: keyed(items),
  };
}

const lowerHex = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : String(v ?? ''));

/** A u32 field (version, nbits, ntime) as the collector stores it: 8 lower-case hex digits. Other values as given. */
function u32Hex(v: unknown): string {
  if (typeof v === 'string' && /^(0x)?[0-9a-fA-F]{1,8}$/.test(v)) return v.replace(/^0x/, '').toLowerCase().padStart(8, '0');
  return lowerHex(v);
}

/** clean_jobs as the collector stores it: Python truthiness of the value the pool sent (collector-go pyValue.truthy). */
export function cleanJobsFlag(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

/** Every mining.notify field plus the pool and receive time: two messages with the same key are the same message. */
export function templateContentKey(data: StratumV1Data): string {
  return JSON.stringify([
    data.pool_name, data.timestamp, data.received_timestamp, data.source_id, data.site, data.replica, data.job_id, data.height, data.prev_hash, data.version, data.nbits, data.ntime,
    data.clean_jobs, data.merkle_branches, data.coinbase1, data.extranonce1, data.extranonce2_length, data.coinbase2,
  ]);
}

export function processTemplateData(data: StratumV1Data): ProcessedTemplateData {
  // The cache key covers every field, so two different messages never share processed data.
  const cacheKey = templateContentKey(data);
  const hit = processedDataCache.get(cacheKey);
  if (hit) return hit;

  const { content: coinbase, opReturns } = coinbaseContent(data);

  // Normalised the way the collector stores them, so a live message (the pool's own casing and types) compares equal
  // to the same template read back from history.
  const processed: ProcessedTemplateData = {
    poolName: data.pool_name,
    height: data.height,
    prevHash: lowerHex(data.prev_hash),
    version: u32Hex(data.version),
    nbits: data.nbits === undefined ? undefined : u32Hex(data.nbits),
    ntime: data.ntime === undefined ? undefined : u32Hex(data.ntime),
    cleanJobs: cleanJobsFlag(data.clean_jobs),
    merkleBranches: (data.merkle_branches ?? []).map(lowerHex),
    extranonce2Length: Number(data.extranonce2_length),
    connection: typeof data.site === 'string' && typeof data.replica === 'string' ? `stream ${data.site}/${data.replica}`
      : typeof data.source_id === 'number' ? `source ${data.source_id}` : null,
    opReturnProtocols: opReturns,
    coinbase,
  };

  if (processedDataCache.size >= MAX_PROCESSED_DATA_CACHE_SIZE) {
    const firstKey = processedDataCache.keys().next().value;
    if (firstKey !== undefined) processedDataCache.delete(firstKey);
  }
  processedDataCache.set(cacheKey, processed);
  return processed;
}

// Utility to clear cache (useful for testing or memory management)
export function clearProcessedDataCache(): void {
  processedDataCache.clear();
}