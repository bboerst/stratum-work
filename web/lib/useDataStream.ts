import { useEffect, useState } from "react";
import { StreamData, StreamDataType, StratumV1Data } from "./types";

interface UseDataStreamOptions {
  endpoint?: string;
  initialReconnectFrequency?: number;
  maxReconnectFrequency?: number;
  paused?: boolean;
  maxItems?: number;
  dataTypes?: StreamDataType[];
}

interface UseDataStreamResult {
  data: StreamData[];
  isConnected: boolean;
  clearData: () => void;
  filterByType: (type: StreamDataType) => StreamData[];
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
  maxItems = 50,
  dataTypes = Object.values(StreamDataType)
}: UseDataStreamOptions = {}): UseDataStreamResult {
  const [data, setData] = useState<StreamData[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  // Function to clear all data
  const clearData = () => setData([]);
  
  // Function to filter data by type
  const filterByType = (type: StreamDataType) => {
    return data.filter(item => item.type === type);
  };

  useEffect(() => {
    let evtSource: EventSource | null = null;
    let reconnectFrequencySeconds = initialReconnectFrequency;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const setupEventSource = () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      // Build the endpoint URL with data type filters if specified
      const url = new URL(endpoint, window.location.origin);
      if (dataTypes.length > 0 && dataTypes.length < Object.values(StreamDataType).length) {
        dataTypes.forEach(type => {
          url.searchParams.append('types', type);
        });
      }

      // Connect to the SSE endpoint
      evtSource = new EventSource(url.toString());
      setIsConnected(true);

      evtSource.onmessage = (event) => {
        if (paused) return;
        
        try {
          const parsedData = JSON.parse(event.data);
          
          // Check if the data is in the new format (has a type field)
          // or the old format (direct StratumV1Data)
          let newData: StreamData;
          
          if ('type' in parsedData) {
            // New format - already has type field
            newData = parsedData as StreamData;
          } else if ('pool_name' in parsedData) {
            // Old format - StratumV1Data
            // Convert to new format
            newData = {
              type: StreamDataType.STRATUM_V1,
              id: parsedData._id || `stratum-${Date.now()}`,
              timestamp: parsedData.timestamp,
              data: parsedData as StratumV1Data
            };
          } else {
            // Unknown format
            return;
          }
          
          // Add the new data to our state
          setData((prev) => {
            // For each data type, we might have different uniqueness criteria
            let filteredData = [...prev];
            
            if (newData.type === StreamDataType.STRATUM_V1) {
              // For Stratum data, we replace existing entries with the same pool_name
              filteredData = prev.filter(item => 
                !(item.type === StreamDataType.STRATUM_V1 && 
                  item.data.pool_name === newData.data.pool_name)
              );
            } else if (newData.type === StreamDataType.BLOCK) {
              // For Block data, we replace existing entries with the same hash
              filteredData = prev.filter(item => 
                !(item.type === StreamDataType.BLOCK && 
                  item.data.hash === newData.data.hash)
              );
            }
            
            const newRows = [...filteredData, newData];
            // Limit how many rows we keep
            const result = newRows.slice(-maxItems);
            return result;
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
  }, [endpoint, initialReconnectFrequency, maxReconnectFrequency, paused, maxItems, dataTypes]);

  return { data, isConnected, clearData, filterByType };
} 