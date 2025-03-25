import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Combines multiple class names into a single string, merging Tailwind CSS classes properly
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format numerical timestamp (could be hex-derived) for display
 */
export const formatTimestamp = (timestamp: number) => {
  try {
    // Convert microseconds to milliseconds for Date
    const date = new Date(timestamp / 1000);
    
    // Format as HH:MM:SS.mmm
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
    const microseconds = (timestamp % 1000).toString().padStart(3, '0');
    
    return `${hours}:${minutes}:${seconds}.${milliseconds}${microseconds}`;
  } catch {
    return String(timestamp); // Fallback
  }
};
