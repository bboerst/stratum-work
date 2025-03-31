import { useEffect, useState, useRef, useCallback, useTransition } from "react";
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
  
  // Add useTransition for non-urgent updates
  const [, startTransition] = useTransition();
  
  // Use refs to track the streaming state to avoid unnecessary re-renders
  const evtSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectFrequencyRef = useRef(initialReconnectFrequency);
  const pausedRef = useRef(paused);
  const dataTypesRef = useRef(dataTypes);
  const maxItemsRef = useRef(maxItems);
  
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
      
      // Process the new data immediately
      startTransition(() => {
        setData((prev) => {
          let filteredData = [...prev];
          
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
          
          // Limit how many rows we keep
          return filteredData.slice(-maxItemsRef.current);
        });
      });
    } catch (error) {
      console.error("Error parsing SSE data", error);
    }
  }, [startTransition]);

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
    };
  }, [endpoint, initialReconnectFrequency, maxReconnectFrequency, processMessage]);

  return { data, isConnected, clearData, filterByType };
} 