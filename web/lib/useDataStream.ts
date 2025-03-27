import { useEffect, useState, useRef, useCallback, useTransition, useMemo } from "react";
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

// Custom debounce implementation
function createDebounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  wait: number
): T & { cancel: () => void } {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;
  
  const debounced = function(...args: Parameters<T>) {
    if (cancelled) return;
    
    if (timeout) {
      clearTimeout(timeout);
    }
    
    timeout = setTimeout(() => {
      timeout = null;
      if (!cancelled) {
        func(...args);
      }
    }, wait);
  } as T & { cancel: () => void };
  
  debounced.cancel = function() {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    cancelled = true;
  };
  
  return debounced;
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
  
  // Add useTransition for non-urgent updates
  const [, startTransition] = useTransition();
  
  // Use refs to track the streaming state to avoid unnecessary re-renders
  const evtSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectFrequencyRef = useRef(initialReconnectFrequency);
  const pausedRef = useRef(paused);
  const dataTypesRef = useRef(dataTypes);
  const maxItemsRef = useRef(maxItems);
  
  // Pending updates buffer to collect multiple updates before processing
  const pendingUpdatesRef = useRef<StreamData[]>([]);
  
  // Update refs when props change
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  
  useEffect(() => {
    dataTypesRef.current = dataTypes;
  }, [dataTypes]);
  
  useEffect(() => {
    maxItemsRef.current = maxItems;
  }, [maxItems]);

  // Function to clear all data
  const clearData = useCallback(() => setData([]), []);
  
  // Function to filter data by type
  const filterByType = useCallback((type: StreamDataType) => {
    return data.filter(item => item.type === type);
  }, [data]);
  
  // Create a debounced function to batch process updates
  const debouncedProcessFn = useMemo(() => {
    return createDebounce(() => {
      if (pendingUpdatesRef.current.length === 0) return;
      
      const updates = [...pendingUpdatesRef.current];
      pendingUpdatesRef.current = [];
      
      startTransition(() => {
        setData((prev) => {
          let filteredData = [...prev];
          
          // Process each update in the batch
          updates.forEach(newData => {
            if (newData.type === StreamDataType.STRATUM_V1) {
              // For Stratum data, we replace existing entries with the same pool_name and height
              filteredData = filteredData.filter(item => 
                !(item.type === StreamDataType.STRATUM_V1 && 
                  item.data.pool_name === newData.data.pool_name &&
                  item.data.height === newData.data.height)
              );
            } else if (newData.type === StreamDataType.BLOCK) {
              // For Block data, we replace existing entries with the same hash
              filteredData = filteredData.filter(item => 
                !(item.type === StreamDataType.BLOCK && 
                  item.data.hash === newData.data.hash)
              );
            }
            
            // Add the new data
            filteredData.push(newData);
          });
          
          // Limit how many rows we keep
          const result = filteredData.slice(-maxItemsRef.current);
          return result;
        });
      });
    }, 25); // Process batches every 100ms
  }, [startTransition]);
  
  // Process incoming message
  const processMessage = useCallback((event: MessageEvent) => {
    if (pausedRef.current) return;
    
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
      
      // Add the new data to our pending updates buffer
      pendingUpdatesRef.current.push(newData);
      
      // Trigger the debounced processing function
      debouncedProcessFn();
    } catch (error) {
      console.error("Error parsing SSE data", error);
    }
  }, [debouncedProcessFn]);

  // Set up and tear down the EventSource
  useEffect(() => {
    const setupEventSource = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      // Build the endpoint URL with data type filters if specified
      const url = new URL(endpoint, window.location.origin);
      if (dataTypesRef.current.length > 0 && dataTypesRef.current.length < Object.values(StreamDataType).length) {
        dataTypesRef.current.forEach(type => {
          url.searchParams.append('types', type);
        });
      }

      // Connect to the SSE endpoint
      evtSourceRef.current = new EventSource(url.toString());
      setIsConnected(true);

      evtSourceRef.current.onmessage = processMessage;

      evtSourceRef.current.onerror = () => {
        setIsConnected(false);
        evtSourceRef.current?.close();
        evtSourceRef.current = null;
        
        // Exponential backoff for reconnection
        const reconnectDelay = reconnectFrequencyRef.current * 1000;
        reconnectFrequencyRef.current = Math.min(reconnectFrequencyRef.current * 2, maxReconnectFrequency);
        
        reconnectTimeoutRef.current = setTimeout(() => {
          setupEventSource();
        }, reconnectDelay);
      };

      evtSourceRef.current.onopen = () => {
        setIsConnected(true);
        reconnectFrequencyRef.current = initialReconnectFrequency;
      };
    };

    setupEventSource();

    return () => {
      if (evtSourceRef.current) {
        evtSourceRef.current.close();
        evtSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      // Cancel any pending debounced updates
      debouncedProcessFn.cancel();
    };
  }, [endpoint, initialReconnectFrequency, maxReconnectFrequency, processMessage, debouncedProcessFn]);

  return { data, isConnected, clearData, filterByType };
} 