import { useEffect, useState } from "react";
import { StratumV1Data } from "./types";

interface UseDataStreamOptions {
  endpoint?: string;
  initialReconnectFrequency?: number;
  maxReconnectFrequency?: number;
  paused?: boolean;
  maxItems?: number;
}

interface UseDataStreamResult {
  data: StratumV1Data[];
  isConnected: boolean;
  clearData: () => void;
}

/**
 * Custom hook to connect to an EventSource stream and manage the data
 * 
 * @param options Configuration options for the data stream
 * @returns Object containing the current data, connection status, and utility functions
 */
export function useDataStream({
  endpoint = "/api/stream",
  initialReconnectFrequency = 1,
  maxReconnectFrequency = 60,
  paused = false,
  maxItems = 50
}: UseDataStreamOptions = {}): UseDataStreamResult {
  const [data, setData] = useState<StratumV1Data[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  // Function to clear all data
  const clearData = () => setData([]);

  useEffect(() => {
    let evtSource: EventSource | null = null;
    let reconnectFrequencySeconds = initialReconnectFrequency;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const setupEventSource = () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      // Connect to the SSE endpoint
      evtSource = new EventSource(endpoint);
      setIsConnected(true);

      evtSource.onmessage = (event) => {
        if (paused) return;
        
        try {
          const newData: StratumV1Data = JSON.parse(event.data);
          
          // Add the new data to our state
          setData((prev) => {
            // Remove any existing row for that pool_name
            const withoutPool = prev.filter((r) => r.pool_name !== newData.pool_name);
            const newRows = [...withoutPool, newData];
            // Limit how many rows we keep
            return newRows.slice(-maxItems);
          });
        } catch (error) {
          console.error("Error parsing SSE data", error);
        }
      };

      evtSource.onerror = () => {
        setIsConnected(false);
        evtSource?.close();
        evtSource = null;
        
        // Exponential backoff for reconnection
        const reconnectDelay = reconnectFrequencySeconds * 1000;
        reconnectFrequencySeconds = Math.min(reconnectFrequencySeconds * 2, maxReconnectFrequency);
        
        reconnectTimeout = setTimeout(() => {
          setupEventSource();
        }, reconnectDelay);
      };

      evtSource.onopen = () => {
        setIsConnected(true);
        reconnectFrequencySeconds = initialReconnectFrequency;
      };
    };

    setupEventSource();

    return () => {
      if (evtSource) {
        evtSource.close();
      }
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
    };
  }, [endpoint, initialReconnectFrequency, maxReconnectFrequency, paused, maxItems]);

  return { data, isConnected, clearData };
} 