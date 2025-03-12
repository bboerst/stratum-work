import { SortedRow, SortDirection, SortConfig } from "@/types/tableTypes";

/**
 * Sort coinbase outputs by address more efficiently
 */
export function sortCoinbaseOutputs(
  aValue: any, 
  bValue: any, 
  direction: SortDirection
): number {
  // Convert outputs to sort keys (once per comparison)
  const getSortKey = (outputs: any[]): string => {
    if (!Array.isArray(outputs) || outputs.length === 0) return '';
    
    // Extract and join valid addresses with a separator
    return outputs
      .filter(o => typeof o === 'object' && o !== null && 'address' in o && !o.address.includes('nulldata'))
      .map(o => o.address)
      .join('|'); // Using pipe as it's unlikely to appear in addresses
  };
  
  // Generate sort keys just once per comparison
  const aKey = getSortKey(aValue as any[]);
  const bKey = getSortKey(bValue as any[]);
  
  // Simple string comparison on the sort keys
  return direction === "asc" 
    ? aKey.localeCompare(bKey) 
    : bKey.localeCompare(aKey);
}

/**
 * Sort timestamp strings
 */
export function sortTimestamps(
  aValue: any,
  bValue: any,
  direction: SortDirection
): number {
  const aString = String(aValue);
  const bString = String(bValue);
  
  if (aString.includes('-') && bString.includes('-')) {
    // These are ISO date strings
    const dateA = new Date(aString).getTime();
    const dateB = new Date(bString).getTime();
    return direction === "asc" ? dateA - dateB : dateB - dateA;
  }
  
  // Otherwise, compare as strings
  return direction === "asc" ? aString.localeCompare(bString) : bString.localeCompare(aString);
}

/**
 * Generic function to sort rows by a key
 */
export function sortRowsByKey<T extends Record<string, any>>(
  data: T[],
  key: keyof T,
  direction: SortDirection
): T[] {
  // For coinbase_outputs, we can optimize by precomputing sort keys for the entire dataset
  if (key === "coinbase_outputs" && data.length > 0) {
    // Create a Map to store sort keys for each item
    const sortKeyMap = new Map<T, string>();
    
    // Precompute sort keys for all items
    for (const item of data) {
      const outputs = item[key];
      if (!Array.isArray(outputs) || outputs.length === 0) {
        sortKeyMap.set(item, '');
        continue;
      }
      
      // Extract and join valid addresses
      const sortKey = outputs
        .filter((o: any) => typeof o === 'object' && o !== null && 'address' in o && !o.address.includes('nulldata'))
        .map((o: any) => o.address)
        .join('|');
      
      sortKeyMap.set(item, sortKey);
    }
    
    // Sort using the precomputed keys (much faster)
    return [...data].sort((a, b) => {
      const aKey = sortKeyMap.get(a) || '';
      const bKey = sortKeyMap.get(b) || '';
      
      return direction === "asc" 
        ? aKey.localeCompare(bKey) 
        : bKey.localeCompare(aKey);
    });
  }
  
  // For other keys, use the regular comparison logic
  return [...data].sort((a, b) => {
    const aValue = a[key];
    const bValue = b[key];
    
    // Handle null/undefined values
    if (aValue === undefined || aValue === null) return 1;
    if (bValue === undefined || bValue === null) return -1;
    
    // Special case for coinbase_outputs when not using the optimization above
    if (key === "coinbase_outputs") {
      return sortCoinbaseOutputs(aValue, bValue, direction);
    }
    
    // Numeric values
    if (typeof aValue === 'number' && typeof bValue === 'number') {
      return direction === "asc" ? aValue - bValue : bValue - aValue;
    }
    
    // Timestamp handling
    if (key === "timestamp") {
      return sortTimestamps(aValue, bValue, direction);
    }
    
    // String values (default case)
    const aString = String(aValue);
    const bString = String(bValue);
    
    return direction === "asc" 
      ? aString.localeCompare(bString) 
      : bString.localeCompare(aString);
  });
} 