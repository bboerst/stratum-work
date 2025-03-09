// Utility functions for formatting data in the RealtimeTable

// Reverse a hex string (e.g. for prev_block_hash)
// This function correctly reverses Bitcoin block hashes by reversing 4-byte chunks
export function reverseHex(hex: string): string {
  try {
    // Ensure the hex string has an even number of characters
    if (hex.length % 2 !== 0) {
      hex = '0' + hex;
    }
    
    // For Bitcoin block hashes, we need to reverse in 4-byte chunks
    // Each byte is 2 hex characters, so each chunk is 8 hex characters
    const chunks = [];
    
    // Process the hex string in 8-character (4-byte) chunks
    for (let i = 0; i < hex.length; i += 8) {
      // Get the current 4-byte chunk
      const chunkSize = Math.min(8, hex.length - i);
      const chunk = hex.substring(i, i + chunkSize);
      chunks.push(chunk);
    }
    
    // Reverse the order of the chunks
    chunks.reverse();
    
    // Join the chunks back together
    return chunks.join('');
  } catch (error) {
    console.error('Error in reverseHex:', error);
    return hex;
  }
}

// Format the previous block hash in normal endianness
export function formatPrevBlockHash(raw: string): string {
  return reverseHex(raw);
}

// Reconstruct the coinbase transaction from coinbase1 + extranonce1 + "00" * extranonce2_length + coinbase2
export function formatCoinbaseRaw(
  coinbase1: string,
  extranonce1: string,
  extranonce2_length: number,
  coinbase2: string
): string {
  return coinbase1 + extranonce1 + "00".repeat(extranonce2_length) + coinbase2;
}

// Format ntime as unix time
export function formatNtime(ntimeHex: string): string {
  try {
    const unixTime = parseInt(ntimeHex, 16)
    return unixTime.toString()
  } catch {
    return "N/A";
  }
}

// Format timestamp as human-readable time
export function formatTimeReceived(tsHex: string): string {
  try {
    const ns = BigInt("0x" + tsHex)
    const ms = Number(ns / BigInt(1000000))
    const date = new Date(ms)
    const hh = date.getHours().toString().padStart(2, "0")
    const mm = date.getMinutes().toString().padStart(2, "0")
    const ss = date.getSeconds().toString().padStart(2, "0")
    const msec = date.getMilliseconds().toString().padStart(3, "0")
    return `${hh}:${mm}:${ss}.${msec}`
  } catch {
    return "Invalid time"
  }
}

// Simple hash function for generating colors
export function hashCode(str: string): number {
  return str.split("").reduce((sum, c) => sum + c.charCodeAt(0), 0);
} 