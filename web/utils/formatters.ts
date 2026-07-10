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

// Format ntime hex string in various formats
export type NtimeFormat = 'unix' | 'iso' | 'relative' | 'hex';

export function formatNtime(ntimeHex: string, format: NtimeFormat = 'unix'): string {
  try {
    const unixSeconds = parseInt(ntimeHex, 16);
    if (isNaN(unixSeconds)) throw new Error('Invalid hex');

    switch (format) {
      case 'hex':
        return `0x${ntimeHex}`;
      case 'iso':
        return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').substring(0, 19);
      case 'relative': {
        const now = Date.now() / 1000;
        const diff = now - unixSeconds;
        if (diff < 0) {
          const absDiff = Math.abs(diff);
          if (absDiff < 60) return `in ${Math.round(absDiff)}s`;
          if (absDiff < 3600) return `in ${Math.round(absDiff / 60)}m`;
          return `in ${Math.round(absDiff / 3600)}h`;
        }
        if (diff < 60) return `${Math.round(diff)}s ago`;
        if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
        return `${Math.round(diff / 86400)}d ago`;
      }
      case 'unix':
      default:
        return unixSeconds.toString();
    }
  } catch {
    return "N/A";
  }
}

// Get tooltip text for ntime (always shows all formats)
export function formatNtimeTooltip(ntimeHex: string): string {
  try {
    const unixSeconds = parseInt(ntimeHex, 16);
    if (isNaN(unixSeconds)) return "N/A";
    const iso = new Date(unixSeconds * 1000).toISOString().replace('T', ' ').substring(0, 19);
    return `Unix: ${unixSeconds}\nISO: ${iso}\nHex: 0x${ntimeHex}`;
  } catch {
    return "N/A";
  }
}

// Format nbits hex string (just return hex for now, maybe add difficulty calc later)
export function formatNbits(nbitsHex?: string): string {
  return nbitsHex ? `0x${nbitsHex}` : "N/A";
}

// Format timestamp as human-readable time
export function formatTimeReceived(ts: string): string {
  // First, try parsing as hex nanoseconds
  try {
    const ns = BigInt("0x" + ts);
    const ms = Number(ns / BigInt(1000000));
    const date = new Date(ms);
    // Check if the resulting date is valid before formatting
    if (isNaN(date.getTime())) {
      throw new Error("Invalid date from hex");
    }
    const hh = date.getHours().toString().padStart(2, "0");
    const mm = date.getMinutes().toString().padStart(2, "0");
    const ss = date.getSeconds().toString().padStart(2, "0");
    const msec = date.getMilliseconds().toString().padStart(3, "0");
    return `${hh}:${mm}:${ss}.${msec}`;
  } catch (hexError) {
    // If hex parsing fails, try parsing as an ISO-like date string
    try {
      // The old format might look like "2024-12-10T01:30:46.002175"
      // Adding 'Z' assumes the old format was UTC
      const date = new Date(ts + (ts.includes('T') && !ts.endsWith('Z') ? 'Z' : '')); 
      
      if (isNaN(date.getTime())) {
        throw new Error("Invalid date from string");
      }
      const hh = date.getUTCHours().toString().padStart(2, "0"); // Use UTC hours
      const mm = date.getUTCMinutes().toString().padStart(2, "0"); // Use UTC minutes
      const ss = date.getUTCSeconds().toString().padStart(2, "0"); // Use UTC seconds
      const msec = date.getUTCMilliseconds().toString().padStart(3, "0"); // Use UTC milliseconds
      return `${hh}:${mm}:${ss}.${msec}`;
    } catch (stringError) {
      // If both attempts fail, return "Invalid time"
      console.error(`Error formatting timestamp "${ts}":`, hexError, stringError);
      return "Invalid time";
    }
  }
}

// Simple hash function for generating colors
export function hashCode(str: string): number {
  return str.split("").reduce((sum, c) => sum + c.charCodeAt(0), 0);
} 