import { StratumV1Data } from '@/lib/types';
import { 
  computeCoinbaseOutputs, 
  computeCoinbaseScriptSigInfo, 
  getFormattedCoinbaseAsciiTag,
  computeCoinbaseOutputValue,
  getCoinbaseTxDetails,
  CoinbaseOutputDetail,
  AuxPowData,
  CoinbaseTxDetails,
  CoinbaseScriptSigInfo
} from './bitcoinUtils';
import { formatCoinbaseRaw } from './formatters';

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
  opReturnProtocols: Map<string, any>; // Map of protocol name -> protocol data
}

// Cache for processed template data to avoid re-processing
const processedDataCache = new Map<string, ProcessedTemplateData>();
const MAX_PROCESSED_DATA_CACHE_SIZE = 150;


function extractOpReturnProtocols(coinbaseOutputs?: CoinbaseOutputDetail[]): Map<string, any> {
  const protocols = new Map<string, any>();
  
  if (!coinbaseOutputs) return protocols;
  
  for (const output of coinbaseOutputs) {
    if (output.type === 'nulldata' && output.decodedData) {
      const protocol = output.decodedData.protocol;
      if (protocol && protocol !== 'Unknown') {
        // Store the entire decoded data for this protocol
        protocols.set(protocol, {
          details: output.decodedData.details,
          dataHex: output.decodedData.dataHex,
          value: output.value
        });
      }
    }
  }
  
  return protocols;
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

export function processTemplateData(data: StratumV1Data): ProcessedTemplateData {
  // Create cache key based on critical fields that would affect processing
  const cacheKey = `${data.pool_name}-${data.job_id}-${data.height}-${data.timestamp}-${data.coinbase1}-${data.coinbase2}`;
  
  if (processedDataCache.has(cacheKey)) {
    return processedDataCache.get(cacheKey)!;
  }

  // Build coinbase raw
  const coinbaseRaw = formatCoinbaseRaw(
    data.coinbase1,
    data.extranonce1,
    data.extranonce2_length,
    data.coinbase2
  );

  // Parse all coinbase data
  const coinbaseOutputs = computeCoinbaseOutputs(coinbaseRaw);
  const scriptSigInfo = computeCoinbaseScriptSigInfo(coinbaseRaw);
  const coinbaseOutputValue = computeCoinbaseOutputValue(coinbaseRaw);
  const txDetails = getCoinbaseTxDetails(coinbaseRaw);
  const asciiTag = getFormattedCoinbaseAsciiTag(
    data.coinbase1,
    data.extranonce1,
    data.extranonce2_length,
    data.coinbase2
  );

  // Extract auxpow data
  const auxPowInfo = extractAuxPowData(scriptSigInfo?.auxPowData);
  const opReturnProtocols = extractOpReturnProtocols(coinbaseOutputs);

  const processed: ProcessedTemplateData = {
    // Core stratum fields
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

    // Derived coinbase fields
    coinbaseRaw,
    coinbaseScriptASCII: asciiTag,
    coinbaseOutputValue,
    coinbaseOutputs,

    // Transaction details
    txVersion: txDetails?.txVersion,
    inputSequence: txDetails?.inputSequence,
    txLocktime: txDetails?.txLocktime,
    witnessCommitmentNonce: txDetails?.witnessCommitmentNonce,

    // AuxPOW data
    auxPowHash: auxPowInfo.hash,
    auxPowMerkleSize: auxPowInfo.merkleSize,
    auxPowNonce: auxPowInfo.nonce,

    // Individual OP_RETURN protocols
    opReturnProtocols
  };

  // Manage cache size
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