import { StratumV1Data } from '@/lib/types';
import { 
  computeCoinbaseOutputs, 
  computeCoinbaseScriptSigInfo, 
  getFormattedCoinbaseAsciiTag,
  computeCoinbaseOutputValue,
  getCoinbaseTxDetails,
  reportParseFailure,
  CoinbaseOutputDetail,
  AuxPowData,
  CoinbaseTxDetails,
  CoinbaseScriptSigInfo
} from './bitcoinUtils';
import { formatCoinbaseRaw } from './formatters';
import { parseCoinbase, ParsedCoinbase, ByteRange } from './coinbaseParser';

export interface ProcessedTemplateData {
  // Core stratum fields
  poolName: string;
  jobId: string;
  height: number;
  prevHash: string;
  version: string;
  nbits?: string;
  ntime?: string;
  cleanJobs: boolean | string;
  merkleBranches: string[];
  extranonce2Length: number;

  // Derived coinbase fields
  coinbaseRaw: string;
  coinbaseScriptASCII: string;
  coinbaseOutputValue: number;
  coinbaseOutputs: CoinbaseOutputDetail[];

  // Transaction details
  txVersion?: number;
  inputSequence?: number;
  txLocktime?: number;
  witnessCommitmentNonce?: string | null;

  // AuxPOW data
  auxPowHash?: string;
  auxPowMerkleSize?: number | null;
  auxPowNonce?: number | null;

  // Individual OP_RETURN protocol data
  opReturnProtocols: Map<string, any>; // Map of protocol name (with " #2", " #3"... for repeats) -> protocol data

  // The coinbase as the pool wrote it, from coinbaseParser's byte map, with the extranonce bytes left out (they are
  // per connection and per share, not part of the template's content). Change detection compares these.
  coinbase: CoinbaseContent;
}

export interface CoinbaseContent {
  parsed: boolean; // false: the coinbase didn't parse, only coinbase1/coinbase2 as a whole can be compared
  /** scriptSig text tags, in full (the display tag is cut to 80 characters). */
  scriptSigTags: string;
  /** A pushed 4-byte Unix time in the scriptSig (the pool's clock), or null. */
  scriptSigTime: number | null;
  /** The scriptSig's other pushed bytes (counters, nonces, binary ids), one hex string per run, joined with "|". */
  scriptSigData: string;
  /** Everything else in the scriptSig: push headers, the height push, the AuxPoW commitment (hex, runs joined by "|"). */
  scriptSigStructure: string;
  /** Each output's value (satoshis), in order. */
  outputValues: number[];
  /** Each output's script (hex, extranonce bytes as ".."), in order. */
  outputScripts: string[];
  /** extranonce1 as served (masked on the public site, #105: equal within a pool for the same session). */
  extranonce1: string;
  /** coinbase1 and coinbase2 as sent (lower-case hex), for the backstop comparison. */
  coinbase1: string;
  coinbase2: string;
}

// Cache for processed template data to avoid re-processing
const processedDataCache = new Map<string, ProcessedTemplateData>();
const MAX_PROCESSED_DATA_CACHE_SIZE = 150;


/**
 * Every OP_RETURN output, keyed by protocol name. Unknown protocols are included (a change to them is a change), and
 * a protocol that appears more than once gets " #2", " #3"... in output order, so repeats don't overwrite each other.
 * The extranonce carrier is left out: its bytes are the per-connection extranonce, not template content.
 */
export function extractOpReturnProtocols(coinbaseOutputs?: CoinbaseOutputDetail[]): Map<string, any> {
  const protocols = new Map<string, any>();
  if (!coinbaseOutputs) return protocols;
  const seen = new Map<string, number>();
  for (const output of coinbaseOutputs) {
    if (output.type !== 'nulldata' || !output.decodedData) continue;
    if (output.decodedData.id === 'extranonce') continue;
    const protocol = output.decodedData.protocol || 'Unknown';
    const n = (seen.get(protocol) ?? 0) + 1;
    seen.set(protocol, n);
    protocols.set(n === 1 ? protocol : `${protocol} #${n}`, {
      details: output.decodedData.details,
      dataHex: output.decodedData.dataHex,
      value: output.value,
      script: output.hex, // the whole script: pushes after the first aren't in dataHex
    });
  }
  return protocols;
}

const EMPTY_COINBASE: Omit<CoinbaseContent, 'extranonce1' | 'coinbase1' | 'coinbase2'> = {
  parsed: false, scriptSigTags: '', scriptSigTime: null, scriptSigData: '', scriptSigStructure: '', outputValues: [], outputScripts: [],
};

function hexOf(tx: string, r: ByteRange): string {
  return tx.slice(r.start * 2, r.end * 2);
}

/** The template's coinbase content, from coinbaseParser's byte map, without the extranonce bytes. */
export function coinbaseContent(data: Pick<StratumV1Data, 'coinbase1' | 'extranonce1' | 'extranonce2_length' | 'coinbase2' | 'ntime'>): CoinbaseContent {
  const extranonce1 = data.extranonce1 || '';
  const coinbase1 = (data.coinbase1 || '').toLowerCase();
  const coinbase2 = (data.coinbase2 || '').toLowerCase();
  const ntime = data.ntime && /^[0-9a-fA-F]{1,8}$/.test(data.ntime) ? parseInt(data.ntime, 16) : undefined;
  const parsed: ParsedCoinbase = parseCoinbase(data.coinbase1, extranonce1, Number(data.extranonce2_length), data.coinbase2, { ntime });
  if (!parsed.ok || !parsed.scriptSig) return { ...EMPTY_COINBASE, extranonce1, coinbase1, coinbase2 };
  const tx = (data.coinbase1 + extranonce1 + '00'.repeat(Number(data.extranonce2_length)) + data.coinbase2).toLowerCase();

  const tags: string[] = [];
  const dataRuns: string[] = [];
  const structure: string[] = [];
  for (const seg of parsed.scriptSig.segments) {
    switch (seg.kind) {
      case 'extranonce1':
      case 'extranonce2':
        break; // per connection / per share
      case 'tag':
        tags.push(seg.text ?? '');
        break;
      case 'time':
        break; // compared as scriptSigTime
      case 'data':
        dataRuns.push(hexOf(tx, seg));
        break;
      default: // height, auxpow, push
        structure.push(`${seg.kind}:${hexOf(tx, seg)}`);
    }
  }

  const en: ByteRange = { start: parsed.extranonce1.start, end: parsed.extranonce2.end };
  const outputScripts = parsed.outputs.map(o => {
    let hex = '';
    for (let i = o.script.start; i < o.script.end; i++) hex += i >= en.start && i < en.end ? '..' : tx.slice(i * 2, i * 2 + 2);
    return hex;
  });

  return {
    parsed: true,
    scriptSigTags: tags.join('|'),
    scriptSigTime: parsed.scriptSig.time,
    scriptSigData: dataRuns.join('|'),
    scriptSigStructure: structure.join('|'),
    outputValues: parsed.outputs.map(o => o.value),
    outputScripts,
    extranonce1,
    coinbase1,
    coinbase2,
  };
}

function extractAuxPowData(auxPowData?: AuxPowData | null): {
  hash?: string;
  merkleSize?: number | null;
  nonce?: number | null;
} {
  if (!auxPowData) return {};
  
  return {
    hash: auxPowData.auxHashOrRoot,
    merkleSize: auxPowData.merkleSize,
    nonce: auxPowData.nonce
  };
}

/** Every mining.notify field plus the pool and receive time: two messages with the same key are the same message. */
export function templateContentKey(data: StratumV1Data): string {
  return JSON.stringify([
    data.pool_name, data.timestamp, data.job_id, data.height, data.prev_hash, data.version, data.nbits, data.ntime,
    data.clean_jobs, data.merkle_branches, data.coinbase1, data.extranonce1, data.extranonce2_length, data.coinbase2,
  ]);
}

export function processTemplateData(data: StratumV1Data): ProcessedTemplateData {
  // The cache key covers every field, so two different messages never share processed data.
  const cacheKey = templateContentKey(data);
  
  if (processedDataCache.has(cacheKey)) {
    return processedDataCache.get(cacheKey)!;
  }

  let coinbaseRaw = '';
  let coinbaseOutputs: CoinbaseOutputDetail[] = [];
  let scriptSigInfo: CoinbaseScriptSigInfo | null = null;
  let coinbaseOutputValue = 0;
  let txDetails: CoinbaseTxDetails | null = null;
  let asciiTag = '';

  try {
    coinbaseRaw = formatCoinbaseRaw(
      data.coinbase1,
      data.extranonce1,
      data.extranonce2_length,
      data.coinbase2
    );
    reportParseFailure(coinbaseRaw, data.pool_name, data.height);

    coinbaseOutputs = computeCoinbaseOutputs(coinbaseRaw);
    scriptSigInfo = computeCoinbaseScriptSigInfo(coinbaseRaw);
    coinbaseOutputValue = computeCoinbaseOutputValue(coinbaseRaw);
    txDetails = getCoinbaseTxDetails(coinbaseRaw);
    asciiTag = getFormattedCoinbaseAsciiTag(
      data.coinbase1,
      data.extranonce1,
      data.extranonce2_length,
      data.coinbase2
    );
  } catch (err) {
    console.error(
      `[processTemplateData] Error processing template for pool="${data.pool_name}" ` +
      `job=${data.job_id} height=${data.height} ` +
      `coinbaseRaw(first 40 chars)="${coinbaseRaw.slice(0, 40)}...":`,
      err
    );
  }

  const auxPowInfo = extractAuxPowData(scriptSigInfo?.auxPowData);
  const opReturnProtocols = extractOpReturnProtocols(coinbaseOutputs);

  const processed: ProcessedTemplateData = {
    poolName: data.pool_name,
    jobId: data.job_id,
    height: data.height,
    prevHash: data.prev_hash,
    version: data.version,
    nbits: data.nbits,
    ntime: data.ntime,
    cleanJobs: data.clean_jobs,
    merkleBranches: [...data.merkle_branches],
    extranonce2Length: data.extranonce2_length,

    coinbaseRaw,
    coinbaseScriptASCII: asciiTag,
    coinbaseOutputValue,
    coinbaseOutputs,

    txVersion: txDetails?.txVersion,
    inputSequence: txDetails?.inputSequence,
    txLocktime: txDetails?.txLocktime,
    witnessCommitmentNonce: txDetails?.witnessCommitmentNonce,

    auxPowHash: auxPowInfo.hash,
    auxPowMerkleSize: auxPowInfo.merkleSize,
    auxPowNonce: auxPowInfo.nonce,

    opReturnProtocols,
    coinbase: coinbaseContent(data),
  };

  if (processedDataCache.size >= MAX_PROCESSED_DATA_CACHE_SIZE) {
    const firstKey = processedDataCache.keys().next().value;
    if (firstKey !== undefined) {
      processedDataCache.delete(firstKey);
    }
  }

  processedDataCache.set(cacheKey, processed);
  return processed;
}

// Utility to clear cache (useful for testing or memory management)
export function clearProcessedDataCache(): void {
  processedDataCache.clear();
}