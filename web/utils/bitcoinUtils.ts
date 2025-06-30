import { Transaction, address, networks } from "bitcoinjs-lib";
import { formatCoinbaseRaw } from './formatters'; // Import necessary formatter

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

// Shared transaction cache
const transactionCache = new Map<string, Transaction>();

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

// Type definition for decoded OP_RETURN data
export interface OpReturnData {
  protocol: string; 
  details?: {
    // CoreDAO specific
    validatorAddress?: string;
    rewardAddress?: string;
    // RSK specific
    rskBlockHash?: string;
    // ExSat specific
    synchronizerAccount?: string;
    // Hathor specific
    auxBlockHash?: string;
    // Syscoin specific
    relatedHash?: string; // If merge-mining: Syscoin block hash? Else: TXID, asset ID, etc.
    suffixDataHex?: string; // If merge-mining: Flags/version? Else: Other context-dependent data.
    remainingDataHex?: string; // If pattern doesn't match
    // Generic error
    error?: string;
    // Other protocols might add fields here
  };
  dataHex: string; // The raw data hex (the part pushed after push opcodes)
}

// Interface for decoded AuxPOW data 
export interface AuxPowData {
  auxHashOrRoot: string; // Merkle Root (Dogecoin) or Aux Block Hash (Namecoin-style)
  merkleSize?: number;   // Optional: Size of aux chain merkle tree (if found)
  nonce?: number;        // Optional: Nonce used in aux chain merkle calc (if found)
}

// Cache for coinbase outputs - Updated Type
const coinbaseOutputsCache = new Map<string, CoinbaseOutputDetail[]>();

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

// Helper function to get a transaction from cache or parse it
export function getTransaction(coinbaseRaw: string): Transaction {
  if (!transactionCache.has(coinbaseRaw)) {
    // Manage cache size
    if (transactionCache.size >= MAX_CACHE_SIZE) {
      const firstKey = transactionCache.keys().next().value;
      if (firstKey !== undefined) {
        transactionCache.delete(firstKey);
      }
    }
    // Parse and cache the transaction
    const tx = Transaction.fromHex(coinbaseRaw);
    transactionCache.set(coinbaseRaw, tx);
    return tx;
  }
  return transactionCache.get(coinbaseRaw)!;
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

// Computes the final ASCII tag from coinbase parts, excluding height/auxpow
export function getFormattedCoinbaseAsciiTag(
  coinbase1: string,
  extranonce1: string,
  extranonce2_length: number,
  coinbase2: string
): string {
  try {
    // 1. Construct raw coinbase
    const cbRaw = formatCoinbaseRaw(coinbase1, extranonce1, extranonce2_length, coinbase2);
    // 2. Get transaction (use cache)
    const tx = getTransaction(cbRaw);
    if (!tx.ins || tx.ins.length === 0) {
      return ""; // No input script
    }
    const scriptSigBuffer = tx.ins[0].script;
    // 3. Decode script sig to get remaining hex (use cache)
    const scriptSigInfo = decodeCoinbaseScriptSigInfo(scriptSigBuffer);
    // 4. Format remaining hex to ASCII (use cache)
    return formatCoinbaseScriptASCII(scriptSigInfo.remainingScriptHex);
  } catch (error) {
    console.error("Error in getFormattedCoinbaseAsciiTag:", error);
    return ""; // Return empty string on error
  }
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
    const totalValue = tx.outs.reduce((sum, out) => sum + out.value, 0);
    
    // Cache the result
    manageCache(coinbaseOutputValueCache, coinbaseRaw, totalValue);
    return totalValue;
  } catch (err) {
    console.error("Error computing coinbase output value:", err);
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

// Helper function to decode ExSat synchronizer account hex
const EXSAT_ENCODING_MAP = [
  'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p',
  'q','r','s','t','u','v','w','x','y','z','1','2','3','4','5','.'
];

function decodeExsatAccount(hexString: string): string {
  let result = '';
  for (let i = 0; i < hexString.length; i += 2) {
    const byteVal = parseInt(hexString.substring(i, i + 2), 16);
    if (!isNaN(byteVal) && byteVal >= 0 && byteVal < EXSAT_ENCODING_MAP.length) {
      result += EXSAT_ENCODING_MAP[byteVal];
    } else {
      result += '?'; // Indicate unknown byte
    }
  }
  return result;
}

// Helper function to decode OP_RETURN data based on known patterns
export function decodeOpReturnData(dataHex: string): OpReturnData {
  if (!dataHex) return { protocol: 'Empty OP_RETURN', dataHex: '' };

  const dataBuffer = Buffer.from(dataHex, 'hex');
  const dataLength = dataBuffer.length; // Get length for checks

  // Runestone: Handled specifically in computeCoinbaseOutputs due to its unique marker (6a5d)

  // Witness Commitment: Starts with 'aa21a9ed'
  if (dataHex.startsWith('aa21a9ed')) {
    return { protocol: 'WitnessCommitment', dataHex };
  }

  // Omni: Starts with '6f6d6e69' ('omni')
  if (dataHex.startsWith('6f6d6e69')) {
    return { protocol: 'Omni', dataHex };
  }

  // RSK Block: Starts with '52534b424c4f434b3a' ('RSKBLOCK:')
  if (dataHex.startsWith('52534b424c4f434b3a')) {
    const rskMarker = '52534b424c4f434b3a';
    const rskMarkerBytesLength = Buffer.from(rskMarker, 'hex').length;
    if (dataBuffer.length >= rskMarkerBytesLength + 32) {
        const rskBlockHash = dataBuffer.slice(rskMarkerBytesLength, rskMarkerBytesLength + 32).toString('hex');
        return { protocol: 'RSK Block', details: { rskBlockHash }, dataHex };
    } else {
        return { protocol: 'RSK Block', details: { error: 'Incomplete data' }, dataHex };
    }
  }

  // CoreDAO: Starts with '434f524501' ('CORE' + version 1)
  if (dataHex.startsWith('434f524501')) {
    const coreMarker = '434f524501';
    const coreMarkerBytesLength = Buffer.from(coreMarker, 'hex').length;
    const expectedDataLength = coreMarkerBytesLength + 20 + 20; // Marker + Validator Addr + Reward Addr
     if (dataBuffer.length >= expectedDataLength) {
        const validatorAddress = '0x' + dataBuffer.slice(coreMarkerBytesLength, coreMarkerBytesLength + 20).toString('hex');
        const rewardAddress = '0x' + dataBuffer.slice(coreMarkerBytesLength + 20, coreMarkerBytesLength + 40).toString('hex');
        return { protocol: 'CoreDAO', details: { validatorAddress, rewardAddress }, dataHex };
     } else {
        return { protocol: 'CoreDAO', details: { error: 'Incomplete data' }, dataHex };
     }
  }

  // ExSat: Starts with '455853415401' ('EXSAT' + version 1)
  if (dataHex.startsWith('455853415401')) {
    const exsatMarker = '455853415401';
    const exsatMarkerBytesLength = Buffer.from(exsatMarker, 'hex').length;
    const accountHex = dataBuffer.slice(exsatMarkerBytesLength).toString('hex'); // Rest is account hex
    const synchronizerAccount = decodeExsatAccount(accountHex);
    return { protocol: 'ExSat', details: { synchronizerAccount }, dataHex };
  }

  // Hathor Network: Starts with '48617468' ('Hath')
  if (dataHex.startsWith('48617468')) {
     const hathorMarker = '48617468';
     const hathorMarkerBytes = Buffer.from(hathorMarker, 'hex');
     if (dataBuffer.length >= hathorMarkerBytes.length + 32) {
        const auxBlockHash = dataBuffer.slice(hathorMarkerBytes.length, hathorMarkerBytes.length + 32).toString('hex');
        return { protocol: 'Hathor Network', details: { auxBlockHash }, dataHex };
     } else {
        return { protocol: 'Hathor Network', details: { error: 'Incomplete data' }, dataHex };
     }
  }

  // Syscoin: Starts with '737973' ('sys')
  if (dataHex.startsWith('737973')) {
    const sysMarker = '737973';
    const sysMarkerBytesLength = 3; // Buffer.from(sysMarker, 'hex').length;
    const expectedHashLength = 32;
    const expectedSuffixLength = 3;
    const minExpectedDataLength = sysMarkerBytesLength + expectedHashLength + expectedSuffixLength;

    if (dataBuffer.length >= minExpectedDataLength) {
        const relatedHash = dataBuffer.slice(sysMarkerBytesLength, sysMarkerBytesLength + expectedHashLength).toString('hex');
        // Capture the assumed 3-byte suffix, and potentially more if the total length is greater
        const suffixDataHex = dataBuffer.slice(sysMarkerBytesLength + expectedHashLength).toString('hex'); 
        return { 
           protocol: 'Syscoin', 
           details: { 
              relatedHash, // Potentially Syscoin block hash if merge-mining data
              suffixDataHex // Potentially flags/version if merge-mining data
           }, 
           dataHex // Keep the original full data hex
        };
    } else if (dataBuffer.length > sysMarkerBytesLength) {
        // It's Syscoin, but not long enough for the hash + suffix pattern observed
        const remainingDataHex = dataBuffer.slice(sysMarkerBytesLength).toString('hex');
        return { protocol: 'Syscoin', details: { error: 'Incomplete data for observed pattern', remainingDataHex }, dataHex };
    } else {
       // Just 'sys' marker
       return { protocol: 'Syscoin', details: { error: 'Marker only' }, dataHex };
    }
  }

  // Stacks Block Commit and BIP47 are handled contextually in computeCoinbaseOutputs
  // due to reliance on push opcodes and exact script length.

  // Generic length-based protocols (checked if others don't match)
  if (dataLength === 0) {
    return { protocol: 'OP_RETURN (0 byte)', dataHex };
  }
  if (dataLength === 20) {
    return { protocol: 'OP_RETURN (20 byte)', dataHex };
  }
  if (dataLength === 80) {
    // Check if it *might* be Stacks or BIP47 but didn't match the full script context
    // Avoid mislabeling them if they somehow end up here
    if (!dataHex.startsWith('58325b') && // Stacks 'X2[' start after push op
        !(dataHex.length === 80 && (dataBuffer[0] === 0x01 || dataBuffer[0] === 0x02) && (dataBuffer[2] === 0x02 || dataBuffer[2] === 0x03))) // BIP47 payload check
    {
      return { protocol: 'OP_RETURN (80 byte)', dataHex };
    }
  }

  // If none of the above match
  return { protocol: 'Unknown', dataHex };
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
        const outputDetail: Partial<CoinbaseOutputDetail> = { value: out.value };
        const scriptBytes = out.script;
        const scriptHex = scriptBytes.toString('hex');
        outputDetail.hex = scriptHex; // Always store full script hex for OP_RETURN/Unknown

        try {
          const addr = address.fromOutputScript(scriptBytes, networks.bitcoin);
          outputDetail.type = 'address';
          outputDetail.address = addr;
        } catch (addrError) {
          // Check for OP_RETURN (0x6a)
          if (scriptBytes.length > 0 && scriptBytes[0] === 0x6a) { 
            outputDetail.type = 'nulldata';
            let dataHex = ''; // Data portion after OP_RETURN and push ops

            // === Special Protocol Checks (Based on full scriptHex) ===

            // Runestone: Starts with '6a5d' (OP_RETURN OP_PUSHNUM_13)
            if (scriptHex.startsWith('6a5d')) {
                // Data starts after '6a5d'
                dataHex = scriptBytes.slice(2).toString('hex');
                outputDetail.decodedData = { protocol: 'Runestone', dataHex };
            } 
            // Stacks Block Commit: Specific marker and length
            else if (scriptHex.startsWith('6a4c5058325b') && scriptBytes.length === 83) { // OP_RETURN OP_PUSHDATA1 80 'X2['...
                dataHex = scriptBytes.slice(3).toString('hex'); // Data after '6a4c50'
                outputDetail.decodedData = { protocol: 'Stacks Block Commit', dataHex };
            } 
            // BIP47 Payment Code: Specific marker, length, and payload structure
            else if (scriptHex.startsWith('6a4c50') && scriptBytes.length === 83) { // OP_RETURN OP_PUSHDATA1 80 ...
                const payload = scriptBytes.slice(3); // Data after '6a4c50'
                dataHex = payload.toString('hex');
                if ((payload[0] === 0x01 || payload[0] === 0x02) && (payload[2] === 0x02 || payload[2] === 0x03)) {
                    outputDetail.decodedData = { protocol: 'BIP47 Payment Code', dataHex };
                } else {
                    // Wasn't BIP47, decode normally using the extracted dataHex
                    outputDetail.decodedData = decodeOpReturnData(dataHex);
                }
            } 
            // === General OP_RETURN Data Extraction (if no special case matched) ===
            else if (scriptBytes.length > 1) {
                const pushOp = scriptBytes[1];
                if (pushOp >= 0x01 && pushOp <= 0x4b) { // OP_PUSHBYTES_X
                    if (scriptBytes.length >= 2 + pushOp) {
                       dataHex = scriptBytes.slice(2, 2 + pushOp).toString('hex');
                    }
                } else if (pushOp === 0x4c) { // OP_PUSHDATA1
                    if (scriptBytes.length >= 3) {
                        const dataLen = scriptBytes[2];
                         if (scriptBytes.length >= 3 + dataLen) {
                            dataHex = scriptBytes.slice(3, 3 + dataLen).toString('hex');
                         }
                    }
                } else if (pushOp === 0x4d) { // OP_PUSHDATA2
                    if (scriptBytes.length >= 4) {
                         const dataLen = scriptBytes.readUInt16LE(2);
                         if (scriptBytes.length >= 4 + dataLen) {
                             dataHex = scriptBytes.slice(4, 4 + dataLen).toString('hex');
                         }
                    }
                } else if (pushOp === 0x4e) { // OP_PUSHDATA4
                    if (scriptBytes.length >= 6) {
                        const dataLen = scriptBytes.readUInt32LE(2);
                         if (scriptBytes.length >= 6 + dataLen) {
                            dataHex = scriptBytes.slice(6, 6 + dataLen).toString('hex');
                         }
                    }
                }
                // If data was extracted, decode it
                if (dataHex.length > 0 || (pushOp === 0x00 || (pushOp === 0x4c && scriptBytes[2] === 0x00))) { // Handle OP_0 or PUSHDATA1 0
                   outputDetail.decodedData = decodeOpReturnData(dataHex);
                } else {
                   // If no data could be extracted (malformed push?)
                   outputDetail.decodedData = { protocol: 'Malformed OP_RETURN', dataHex: scriptHex.substring(2) }; // Show hex after 6a
                }
            } else {
                 // Only OP_RETURN (6a), no push op or data
                 outputDetail.decodedData = { protocol: 'Empty OP_RETURN', dataHex: '' };
            }
          } else {
            outputDetail.type = 'unknown';
          }
        }
        return outputDetail as CoinbaseOutputDetail;
      });
      manageCache(coinbaseOutputsCache, coinbaseRaw, outputs);
      return outputs;
    } catch (err) {
      console.error("Error computing coinbase outputs:", err);
      return [];
    }
}

// Fetch the fee rate from mempool.space
// Use a global in-flight map so we don't re-request the same txid
const inFlightRequests: { [txid: string]: boolean } = {};

export async function fetchFeeRate(firstTxid: string): Promise<number | string> {
  try {
    // Check CPFP endpoint first
    const cpfpUrl = `https://mempool.space/api/v1/cpfp/${firstTxid}`;
    let resp = await fetch(cpfpUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data.effectiveFeePerVsize) {
        return Math.round(data.effectiveFeePerVsize);
      }
    }

    // If CPFP not found or invalid, fallback to /api/tx
    const txUrl = `https://mempool.space/api/tx/${firstTxid}`;
    resp = await fetch(txUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data.fee && data.weight) {
        return Math.round(data.fee / (data.weight / 4));
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
    // Always extract the 32-byte hash/root
    auxPowResult.auxHashOrRoot = scriptSig.slice(dataStartIndex, dataStartIndex + 32).reverse().toString('hex');

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

  // Try parsing height (bytes 1-3 LE, assuming byte 0 is push opcode)
  try {
    if (scriptSig.length >= 4 && scriptSig[0] >= 1 && scriptSig[0] <= 75) { // Check for push opcode
        const heightBytesLength = scriptSig[0];
        if (heightBytesLength >= 3 && scriptSig.length >= 1 + heightBytesLength) {
           // Standard BIP34 height is pushed with minimal push
           // We check bytes 1, 2, 3 specifically if the push length allows
           height = scriptSig.readUIntLE(1, 3); 
           currentIndex = 1 + heightBytesLength; // Move past the height push data
        } else {
            // Height not encoded as expected, treat the initial push as remaining data
            remainingParts.push(scriptSig.slice(0, 1 + heightBytesLength));
            currentIndex = 1 + heightBytesLength;
        }
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
    const scriptSigBuffer = tx.ins[0].script;
    return decodeCoinbaseScriptSigInfo(scriptSigBuffer);
  } catch (error) {
    console.error("Error in computeCoinbaseScriptSigInfo:", error);
    return {
      height: null,
      auxPowData: null,
      remainingScriptHex: ""
    };
  }
}

// Function to get other coinbase transaction details
export function getCoinbaseTxDetails(coinbaseRaw: string): CoinbaseTxDetails {
  const tx = getTransaction(coinbaseRaw);
  let witnessCommitmentNonce: string | null = null;

  // Witness data exists on the first input, and has exactly one element
  // This element is typically the nonce for the witness commitment
  if (tx.ins && tx.ins.length > 0 && tx.ins[0].witness && tx.ins[0].witness.length === 1) {
      // Double-check by ensuring a witness commitment output actually exists
      const hasWitnessCommitmentOutput = tx.outs.some(out => out.script.toString('hex').startsWith('6a24aa21a9ed'));
      if (hasWitnessCommitmentOutput) {
           witnessCommitmentNonce = tx.ins[0].witness[0].toString('hex');
      }
  }

  return {
    txVersion: tx.version,
    // Coinbase input sequence is typically 0xffffffff, but read it anyway
    inputSequence: tx.ins[0]?.sequence || 0, 
    txLocktime: tx.locktime,
    witnessCommitmentNonce: witnessCommitmentNonce
  };
} 