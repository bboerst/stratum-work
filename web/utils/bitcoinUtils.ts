import { Transaction, address, networks } from "bitcoinjs-lib";
import { coinbaseTagText, parseCoinbase } from './coinbaseParser';
import { decodeOpReturnPayload, decodeOpReturnScript, OpReturnDecoded, DecodedField, Confidence, OpReturnProtocolId } from './mergeMining';

/**
 * Performance Optimization Strategy:
 * 1. Shared Transaction Cache: We use a shared transaction cache to avoid parsing the same 
 *    transaction multiple times across different utility functions.
 * 2. Function-Specific Caches: Each function has its own cache for its specific output.
 * 3. Cache Size Limits: All caches have size limits to prevent memory leaks.
 * 4. Optimal Function Call Order: For best performance, call computeCoinbaseOutputs first, 
 *    then other functions that use the same transaction.
 */

// Maximum size for all caches to prevent memory leaks
const MAX_CACHE_SIZE = 1000;

// Shared transaction cache — stores parsed transactions and known-bad hex strings
const transactionCache = new Map<string, Transaction>();
const failedParseCache = new Set<string>();

// Sentinel class so downstream catch blocks can identify cached failures and skip re-logging
export class CachedParseError extends Error {
  constructor() {
    super("Previously failed to parse coinbase hex (cached)");
    this.name = "CachedParseError";
  }
}

function isCachedParseError(err: unknown): boolean {
  return err instanceof CachedParseError;
}

// Set of coinbaseRaw values already reported with pool context by callers
const reportedFailures = new Set<string>();

// Call from code that knows the pool name to get a one-time log per bad coinbase hex.
// Returns true if the coinbase hex is known to be unparseable.
export function reportParseFailure(coinbaseRaw: string, poolName: string, height?: number): boolean {
  if (!failedParseCache.has(coinbaseRaw)) return false;
  if (reportedFailures.has(coinbaseRaw)) return true;
  reportedFailures.add(coinbaseRaw);
  if (reportedFailures.size > MAX_CACHE_SIZE) {
    const first = reportedFailures.values().next().value;
    if (first !== undefined) reportedFailures.delete(first);
  }
  console.warn(
    `[coinbase parse failure] pool="${poolName}" height=${height ?? "?"} ` +
    `hex(first 60)="${coinbaseRaw.slice(0, 60)}…" len=${coinbaseRaw.length}`
  );
  return true;
}

// Cache for coinbase script ASCII
const coinbaseScriptAsciiCache = new Map<string, string>();
const coinbaseOutputValueCache = new Map<string, number>();

// Type definition for the output structure - Exported
export interface CoinbaseOutputDetail {
  type: 'address' | 'nulldata' | 'unknown';
  value: number; // Value in satoshis
  address?: string;
  hex?: string; // Full script hex for OP_RETURN/Unknown
  decodedData?: OpReturnData | null; // Decoded OP_RETURN data
}

// Type definition for decoded OP_RETURN data (decoders in ./mergeMining)
export interface OpReturnData {
  protocol: string; // display name, stable (template change detection keys on it)
  id?: OpReturnProtocolId;
  chain?: string; // other chain this commits to, if any
  confidence?: Confidence;
  fields?: DecodedField[]; // named fields, in display order
  commitment?: string;
  details?: {
    // Legacy keys, kept for existing consumers (change-detection tooltips)
    validatorAddress?: string;
    rewardAddress?: string;
    rskBlockHash?: string;
    synchronizerAccount?: string;
    auxBlockHash?: string;
    relatedHash?: string;
    suffixDataHex?: string;
    error?: string;
  };
  dataHex: string; // The raw data hex (the part pushed after push opcodes)
}

// Legacy `details` from the new decode, so existing consumers keep working.
function toOpReturnData(d: OpReturnDecoded): OpReturnData {
  const field = (label: string) => d.fields.find((f) => f.label === label)?.value;
  const details: NonNullable<OpReturnData["details"]> = {};
  switch (d.id) {
    case "core":
      if (field("Validator")) details.validatorAddress = field("Validator");
      if (field("Reward address")) details.rewardAddress = field("Reward address");
      break;
    case "rsk":
      if (d.commitment) details.rskBlockHash = d.commitment;
      break;
    case "exsat":
      if (field("Account")) details.synchronizerAccount = field("Account");
      break;
    case "hathor":
      if (d.commitment) details.auxBlockHash = d.commitment;
      break;
    case "syscoin":
      if (field("Syscoin block")) details.relatedHash = field("Syscoin block");
      if (d.dataHex.length > 70) details.suffixDataHex = d.dataHex.slice(70);
      break;
  }
  if (d.error) details.error = d.error;
  return {
    protocol: d.protocol,
    id: d.id,
    chain: d.chain,
    confidence: d.confidence,
    fields: d.fields,
    commitment: d.commitment,
    details: Object.keys(details).length ? details : undefined,
    dataHex: d.dataHex,
  };
}

// Interface for decoded AuxPOW data 
export interface AuxPowData {
  auxHashOrRoot: string; // aux merkle root (with one aux chain: its block hash), display order
  merkleSize?: number;   // Optional: Size of aux chain merkle tree (if found)
  nonce?: number;        // Optional: Nonce used in aux chain merkle calc (if found)
}

// Cache for coinbase outputs - Updated Type
const coinbaseOutputsCache = new Map<string, CoinbaseOutputDetail[]>();

// Cache for output script address decoding to prevent expensive fromOutputScript calls
const outputScriptAddressCache = new Map<string, string | null>();

// Interface for decoded Coinbase ScriptSig info
export interface CoinbaseScriptSigInfo {
  height?: number | null;
  auxPowData?: AuxPowData | null;
  remainingScriptHex: string; // Concatenated hex of parts not identified as height or AuxPOW
}

// Interface for other coinbase transaction details
export interface CoinbaseTxDetails {
  txVersion: number;
  inputSequence: number;
  txLocktime: number;
  witnessCommitmentNonce?: string | null;
}

// Helper function to get a transaction from cache or parse it.
// Throws on malformed hex but caches failures to avoid repeated parse attempts and log spam.
// On first failure, logs the error with hex context. On subsequent failures, throws a
// silent CachedParseError that downstream catch blocks can recognize and skip logging.
export function getTransaction(coinbaseRaw: string): Transaction {
  const cached = transactionCache.get(coinbaseRaw);
  if (cached) return cached;

  if (failedParseCache.has(coinbaseRaw)) {
    throw new CachedParseError();
  }

  try {
    if (transactionCache.size >= MAX_CACHE_SIZE) {
      const firstKey = transactionCache.keys().next().value;
      if (firstKey !== undefined) {
        transactionCache.delete(firstKey);
      }
    }
    const tx = Transaction.fromHex(coinbaseRaw);
    transactionCache.set(coinbaseRaw, tx);
    return tx;
  } catch (err) {
    if (failedParseCache.size >= MAX_CACHE_SIZE) {
      const first = failedParseCache.values().next().value;
      if (first !== undefined) failedParseCache.delete(first);
    }
    failedParseCache.add(coinbaseRaw);
    throw err;
  }
}

// Helper function to manage cache size
function manageCache<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) {
      cache.delete(firstKey);
    }
  }
  cache.set(key, value);
}

// The pool's text tags from the coinbase scriptSig (coinbaseParser): printable text only, never the height, AuxPoW,
// a pushed timestamp or the extranonce bytes (which are per connection and would otherwise show up as noise).
const coinbaseTagCache = new Map<string, string>();

export function getFormattedCoinbaseAsciiTag(
  coinbase1: string,
  extranonce1: string,
  extranonce2_length: number,
  coinbase2: string
): string {
  const key = `${coinbase1}|${extranonce1}|${extranonce2_length}|${coinbase2}`;
  const cached = coinbaseTagCache.get(key);
  if (cached !== undefined) return cached;
  const tag = coinbaseTagText(parseCoinbase(coinbase1, extranonce1 || "", Number(extranonce2_length), coinbase2));
  manageCache(coinbaseTagCache, key, tag);
  return tag;
}

// Takes pre-filtered hex string
export function formatCoinbaseScriptASCII(scriptHex: string): string {
  // Check cache first - Use scriptHex as key now
  if (coinbaseScriptAsciiCache.has(scriptHex)) {
    return coinbaseScriptAsciiCache.get(scriptHex)!;
  }
  
  try {
    // Input hex is already filtered, just convert to ASCII
    const ascii = Buffer.from(scriptHex, "hex").toString("ascii");
    // Filter out non-printable chars
    const printable = ascii
      .split("")
      .filter((ch) => ch >= " " && ch <= "~")
      .join("");
    const result = printable.length > 80 ? printable.substring(0, 80) + "…" : printable;
    
    // Cache the result
    manageCache(coinbaseScriptAsciiCache, scriptHex, result);
    return result;
  } catch (err) {
    console.error("Error formatting pre-filtered coinbase script hex:", err);
    return "";
  }
}

// Calculate the total output value of the coinbase transaction
export function computeCoinbaseOutputValue(coinbaseRaw: string): number {
  // Check cache first
  if (coinbaseOutputValueCache.has(coinbaseRaw)) {
    return coinbaseOutputValueCache.get(coinbaseRaw)!;
  }
  
  try {
    // Get transaction from shared cache
    const tx = getTransaction(coinbaseRaw);
    
    // Sum all output values
    const totalValue = tx.outs.reduce((sum, out) => sum + Number(out.value), 0);
    
    // Cache the result
    manageCache(coinbaseOutputValueCache, coinbaseRaw, totalValue);
    return totalValue;
  } catch (err) {
    if (!isCachedParseError(err)) {
      console.error("Error computing coinbase output value:", err);
    }
    return 0;
  }
}

// Extract first transaction from merkle branches
export function computeFirstTransaction(merkle_branches: string[]): string {
  if (!merkle_branches || merkle_branches.length === 0) {
    return "empty block";
  }
  try {
    const firstBranch = merkle_branches[0];
    return Buffer.from(firstBranch, "hex").reverse().toString("hex");
  } catch {
    console.error("Error computing first_transaction");
    return "empty block";
  }
}

// Decode the data pushed after OP_RETURN (hex). Never throws; see ./mergeMining for the protocols.
export function decodeOpReturnData(dataHex: string): OpReturnData {
  if (!dataHex) return { protocol: 'Empty OP_RETURN', dataHex: '' };
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(dataHex)) return { protocol: 'Malformed OP_RETURN', dataHex };
  return toOpReturnData(decodeOpReturnPayload(Uint8Array.from(Buffer.from(dataHex, 'hex'))));
}

// Extract all coinbase outputs with details
export function computeCoinbaseOutputs(coinbaseRaw: string): CoinbaseOutputDetail[] {
    // Check cache first
    if (coinbaseOutputsCache.has(coinbaseRaw)) {
      return coinbaseOutputsCache.get(coinbaseRaw)!;
    }
  
    try {
      const tx = getTransaction(coinbaseRaw);
      const outputs: CoinbaseOutputDetail[] = tx.outs.map(out => {
        const outputDetail: Partial<CoinbaseOutputDetail> = { value: Number(out.value) };
        const scriptBytes = Buffer.from(out.script);
        const scriptHex = scriptBytes.toString('hex');
        outputDetail.hex = scriptHex; // Always store full script hex for OP_RETURN/Unknown

        // Check cache first for expensive address decoding
        let cachedAddress = outputScriptAddressCache.get(scriptHex);
        
        if (cachedAddress !== undefined) {
          // Cache hit - use cached result
          if (cachedAddress !== null) {
            outputDetail.type = 'address';
            outputDetail.address = cachedAddress;
          } else {
            // Cached null means this script doesn't decode to an address
            processNonAddressScript();
          }
        } else {
          // Cache miss - perform expensive operation and cache result
          try {
            const addr = address.fromOutputScript(scriptBytes, networks.bitcoin);
            outputDetail.type = 'address';
            outputDetail.address = addr;
            // Cache the successful result
            manageCache(outputScriptAddressCache, scriptHex, addr);
          } catch (addrError) {
            // Cache the failed result as null to avoid repeated expensive calls
            manageCache(outputScriptAddressCache, scriptHex, null);
            processNonAddressScript();
          }
        }
        
        // Helper function to process non-address scripts (OP_RETURN, unknown, etc.)
        function processNonAddressScript() {
          const opReturn = decodeOpReturnScript(Uint8Array.from(scriptBytes));
          if (opReturn) {
            outputDetail.type = 'nulldata';
            outputDetail.decodedData = toOpReturnData(opReturn);
          } else {
            outputDetail.type = 'unknown';
          }
        }
        
        return outputDetail as CoinbaseOutputDetail;
      });
      manageCache(coinbaseOutputsCache, coinbaseRaw, outputs);
      return outputs;
    } catch (err) {
      if (!isCachedParseError(err)) {
        console.error("Error computing coinbase outputs:", err);
      }
      return [];
    }
}

// Fetch the fee rate from mempool.space
// Use a global in-flight map so we don't re-request the same txid
const inFlightRequests: { [txid: string]: boolean } = {};

// Helper function to format fee rate with variable precision
function formatFeeRate(fee: number): number {
  if (fee >= 100) {
    return Math.round(fee); // 0 decimal places
  } else if (fee < 10) {
    return Math.round(fee * 100) / 100; // 2 decimal places
  }
  return Math.round(fee * 10) / 10; // 1 decimal place
}

export async function fetchFeeRate(firstTxid: string): Promise<number | string> {
  try {
    // Check CPFP endpoint first
    const cpfpUrl = `https://mempool.space/api/v1/cpfp/${firstTxid}`;
    let resp = await fetch(cpfpUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data.effectiveFeePerVsize) {
        return formatFeeRate(data.effectiveFeePerVsize);
      }
    }

    // If CPFP not found or invalid, fallback to /api/tx
    const txUrl = `https://mempool.space/api/tx/${firstTxid}`;
    resp = await fetch(txUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data.fee && data.weight) {
        return formatFeeRate(data.fee / (data.weight / 4));
      }
    }
    return "not found";
  } catch (err) {
    console.error("Error fetching fee rate:", err);
    return "Error";
  }
}

// Clear a coinbase transaction from all caches
export function clearCoinbaseFromCaches(coinbaseRaw: string): void {
  transactionCache.delete(coinbaseRaw);
  failedParseCache.delete(coinbaseRaw);
  coinbaseOutputsCache.delete(coinbaseRaw);
  coinbaseScriptAsciiCache.delete(coinbaseRaw);
  coinbaseOutputValueCache.delete(coinbaseRaw);
}

// Check if a request is in flight
export function isRequestInFlight(txid: string): boolean {
  return !!inFlightRequests[txid];
}

// Mark a request as in flight
export function markRequestInFlight(txid: string): void {
  inFlightRequests[txid] = true;
}

// Clear a request from in flight
export function clearRequestInFlight(txid: string): void {
  delete inFlightRequests[txid];
}

// Helper function to decode AuxPOW data from coinbase scriptSig 
const AUXPOW_MAGIC_BYTES = Buffer.from('fabe6d6d', 'hex');

export function decodeAuxPowData(scriptSig: Buffer): AuxPowData | null {
  const magicIndex = scriptSig.indexOf(AUXPOW_MAGIC_BYTES);
  if (magicIndex === -1) {
    return null; // Magic bytes not found
  }

  const dataStartIndex = magicIndex + AUXPOW_MAGIC_BYTES.length;
  
  // Check minimum length for the hash/root
  const minLengthForHash = dataStartIndex + 32;
  if (scriptSig.length < minLengthForHash) {
    console.warn("AuxPOW: scriptSig too short for aux hash/root after magic bytes.");
    return null;
  }

  let auxPowResult: Partial<AuxPowData> = {};

  try {
    // The 32-byte root as the coinbase holds it, which is already display order (see coinbaseParser AuxPow.root)
    auxPowResult.auxHashOrRoot = scriptSig.slice(dataStartIndex, dataStartIndex + 32).toString('hex');

    // Check if there's enough data for size and nonce (Dogecoin style)
    const expectedFullLength = dataStartIndex + 32 + 4 + 4;
    if (scriptSig.length >= expectedFullLength) {
      // Attempt to read size and nonce
      auxPowResult.merkleSize = scriptSig.readUInt32LE(dataStartIndex + 32);
      auxPowResult.nonce = scriptSig.readUInt32LE(dataStartIndex + 32 + 4);
    } // else -> Size and nonce are not present immediately after hash

    return auxPowResult as AuxPowData;
    
  } catch (error) {
    console.error("Error decoding AuxPOW data:", error);
    // Return at least the hash if possible, even if size/nonce parsing failed unexpectedly after length check
    if (auxPowResult.auxHashOrRoot) {
       return { auxHashOrRoot: auxPowResult.auxHashOrRoot };
    }
    return null;
  }
}

// New function to parse height and AuxPOW info from scriptSig
export function decodeCoinbaseScriptSigInfo(scriptSig: Buffer): CoinbaseScriptSigInfo {
  let height: number | null = null;
  let auxPowData: AuxPowData | null = null;
  let remainingParts: Buffer[] = [];
  let currentIndex = 0;

  // BIP34 height: the first scriptSig item is a minimal push of the height (little-endian CScriptNum), or OP_1..OP_16
  // for heights 1-16. Decode the push at its actual length rather than a fixed 3 bytes (matches collector/coinbase.py).
  // 3 bytes covers Bitcoin up to 8,388,607; other chains' templates can use other sizes.
  try {
    const op = scriptSig.length > 0 ? scriptSig[0] : -1;
    if (op >= 1 && op <= 8 && scriptSig.length >= 1 + op) {
        const push = scriptSig.subarray(1, 1 + op);
        // readUIntLE supports up to 6 bytes; a set sign bit means a negative number, which is never a height
        if (op <= 6 && (push[op - 1] & 0x80) === 0) {
           height = push.readUIntLE(0, op);
        } else {
           remainingParts.push(scriptSig.subarray(0, 1 + op));
        }
        currentIndex = 1 + op; // Move past the height push data
    } else if (op >= 0x51 && op <= 0x60) {
        height = op - 0x50; // OP_1 .. OP_16
        currentIndex = 1;
    } else if (op >= 1 && op <= 75) {
        // A push that isn't a height (too long, or truncated): keep it as remaining data
        const pushLength = Math.min(op, scriptSig.length - 1);
        remainingParts.push(scriptSig.subarray(0, 1 + pushLength));
        currentIndex = 1 + pushLength;
    } else {
        // No initial push opcode or empty script, treat everything from start as potentially remaining
        // This case is unlikely for valid coinbase scripts
    }
  } catch (e) {
    console.warn("Could not parse height from coinbase scriptSig:", e);
    // Reset index and treat beginning as remaining data if parsing failed
    currentIndex = 0; 
    remainingParts = []; // Clear parts in case partial push was added
  }

  // Try parsing AuxPOW data from the *entire* original script
  auxPowData = decodeAuxPowData(scriptSig); 

  // Determine remaining parts excluding height (if parsed) and AuxPOW (if found)
  if (auxPowData) {
    const magicIndex = scriptSig.indexOf(AUXPOW_MAGIC_BYTES);
    if (magicIndex !== -1) {
      const auxDataStart = magicIndex;
      const auxDataEnd = magicIndex + AUXPOW_MAGIC_BYTES.length + 32 + (auxPowData.merkleSize !== undefined ? 8 : 0); // End includes root + optional size/nonce
      
      // Add segment before AuxPOW, respecting already processed height bytes
      if (auxDataStart > currentIndex) {
        remainingParts.push(scriptSig.slice(currentIndex, auxDataStart));
      }
      // Move index past AuxPOW data
      currentIndex = Math.max(currentIndex, auxDataEnd); 
    }
  }
  
  // Add any remaining part after height/AuxPOW
  if (currentIndex < scriptSig.length) {
    remainingParts.push(scriptSig.slice(currentIndex));
  }

  // Concatenate remaining parts and convert to hex
  const remainingScriptHex = Buffer.concat(remainingParts).toString('hex');

  return {
    height,
    auxPowData,
    remainingScriptHex
  };
}

// Wrapper function to get coinbase scriptSig info from coinbaseRaw
export function computeCoinbaseScriptSigInfo(coinbaseRaw: string): CoinbaseScriptSigInfo {
  try {
    const tx = getTransaction(coinbaseRaw);
    if (!tx.ins || tx.ins.length === 0) {
      return {
        height: null,
        auxPowData: null,
        remainingScriptHex: ""
      };
    }
    const scriptSigBuffer = Buffer.from(tx.ins[0].script);
    return decodeCoinbaseScriptSigInfo(scriptSigBuffer);
  } catch (error) {
    if (!isCachedParseError(error)) {
      console.error("Error in computeCoinbaseScriptSigInfo:", error);
    }
    return {
      height: null,
      auxPowData: null,
      remainingScriptHex: ""
    };
  }
}

// Function to get other coinbase transaction details
export function getCoinbaseTxDetails(coinbaseRaw: string): CoinbaseTxDetails {
  try {
    const tx = getTransaction(coinbaseRaw);
    let witnessCommitmentNonce: string | null = null;

    if (tx.ins && tx.ins.length > 0 && tx.ins[0].witness && tx.ins[0].witness.length === 1) {
        const hasWitnessCommitmentOutput = tx.outs.some(out => Buffer.from(out.script).toString('hex').startsWith('6a24aa21a9ed'));
        if (hasWitnessCommitmentOutput) {
             witnessCommitmentNonce = Buffer.from(tx.ins[0].witness[0]).toString('hex');
        }
    }

    return {
      txVersion: tx.version,
      inputSequence: tx.ins[0]?.sequence || 0, 
      txLocktime: tx.locktime,
      witnessCommitmentNonce: witnessCommitmentNonce
    };
  } catch (err) {
    if (!isCachedParseError(err)) {
      console.error("Error in getCoinbaseTxDetails:", err);
    }
    return { txVersion: 0, inputSequence: 0, txLocktime: 0, witnessCommitmentNonce: null };
  }
} 