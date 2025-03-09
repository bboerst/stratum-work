import { Transaction, address, networks } from "bitcoinjs-lib";

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

// Function-specific caches
const coinbaseOutputsCache = new Map<string, { address: string; value: number }[]>();
const coinbaseScriptAsciiCache = new Map<string, string>();
const coinbaseOutputValueCache = new Map<string, number>();

// Helper function to get a transaction from cache or parse it
function getTransaction(coinbaseRaw: string): Transaction {
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

// Extract ASCII portion of the coinbase script from the first transaction input
export function formatCoinbaseScriptASCII(coinbaseRaw: string): string {
  // Check cache first
  if (coinbaseScriptAsciiCache.has(coinbaseRaw)) {
    return coinbaseScriptAsciiCache.get(coinbaseRaw)!;
  }
  
  try {
    // Get transaction from shared cache
    const tx = getTransaction(coinbaseRaw);
    
    // script hex from first input
    const scriptHex = tx.ins[0].script.toString("hex");
    // remove first 8 hex characters (4 bytes)
    const trimmed = scriptHex.slice(8);
    const ascii = Buffer.from(trimmed, "hex").toString("ascii");
    // filter out non-printable chars
    const printable = ascii
      .split("")
      .filter((ch) => ch >= " " && ch <= "~")
      .join("");
    const result = printable.length > 80 ? printable.substring(0, 80) + "…" : printable;
    
    // Cache the result
    manageCache(coinbaseScriptAsciiCache, coinbaseRaw, result);
    return result;
  } catch (err) {
    console.error("Error formatting coinbase script:", err);
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
    const totalValue = tx.outs.reduce((sum, out) => sum + out.value, 0) / 1e8;
    
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

// Extract all coinbase outputs that have a recognized address
export function computeCoinbaseOutputs(coinbaseRaw: string): {
  address: string;
  value: number }[] {
    // Check cache first
    if (coinbaseOutputsCache.has(coinbaseRaw)) {
      return coinbaseOutputsCache.get(coinbaseRaw)!;
    }
  
    try {
      // Get transaction from shared cache
      const tx = getTransaction(coinbaseRaw);
      
      // Pre-allocate the array
      const outputs: { address: string; value: number }[] = [];
      
      // Process all outputs in a single pass
      for (let i = 0; i < tx.outs.length; i++) {
        const out = tx.outs[i];
        try {
          // Only attempt to extract address if the script is not empty
          if (out.script.length > 0) {
            const addr = address.fromOutputScript(out.script, networks.bitcoin);
            outputs.push({ address: addr, value: out.value / 1e8 });
          }
        } catch {
          // skip if address cannot be determined (e.g., OP_RETURN)
        }
      }
      
      // Cache the result
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