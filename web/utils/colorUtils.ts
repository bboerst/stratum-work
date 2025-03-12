import { hashCode } from './formatters';

// Memo caches for colors
const coinbaseColorCache = new Map<string, string>();
const merkleColorCache = new Map<string, string>();
const timeColorCache = new Map<string, string>();

// Create a color from a set of coinbase outputs, for highlighting
export function generateColorFromOutputs(
  outputs: { address: string; value: number }[]
): string {
  if (!outputs || outputs.length === 0) return "transparent";
  const filtered = outputs.filter((o) => !o.address.includes("nulldata"));
  const text = filtered.map((o) => `${o.address}:${o.value.toFixed(8)}`).join("|");
  
  // Memoize result
  if (coinbaseColorCache.has(text)) {
    return coinbaseColorCache.get(text)!;
  }
  
  const hue = Math.abs(hashCode(text) % 360);
  const color = `hsl(${hue}, 60%, 80%)`;
  coinbaseColorCache.set(text, color);
  return color;
}

// Generate a color for merkle branches
export function getMerkleColor(branch: string): string {
  if (!branch) return "transparent";
  if (merkleColorCache.has(branch)) {
    return merkleColorCache.get(branch)!;
  }
  
  const hash = hashCode(branch);
  const hue = Math.abs(hash % 360);
  const lightness = 60 + (hash % 25);
  const color = `hsl(${hue}, 100%, ${lightness}%)`;
  merkleColorCache.set(branch, color);
  return color;
}

// Generate a color from unix time string with drastic contrast based on the reversed unix time
export function getTimeColor(unixTime: string): string {
  if (timeColorCache.has(unixTime)) return timeColorCache.get(unixTime)!;
  
  const reversed = unixTime.split("").reverse().join("");
  const num = parseInt(reversed, 10);
  const hue = Math.abs(num % 360);
  const color = `hsl(${hue}, 80%, 70%)`;
  timeColorCache.set(unixTime, color);
  return color;
} 