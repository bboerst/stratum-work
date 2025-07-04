import { useState, useEffect } from 'react';
import { sankeyDataProcessor } from '@/lib/sankeyDataProcessor';
import { eventSourceService } from '@/lib/eventSourceService';
import { useGlobalDataStream } from '@/lib/DataStreamContext';
import { StreamDataType } from '@/lib/types';

export interface UseSankeyControlsProps {
  data?: any[];
}

export interface UseSankeyControlsReturn {
  error: string | null;
  setError: (error: string | null) => void;
  isConnected: boolean;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  stratumV1Data: any[];
  dataVersion: number;
}

export const useSankeyControls = ({ 
  data = [] 
}: UseSankeyControlsProps): UseSankeyControlsReturn => {
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [dataVersion, setDataVersion] = useState<number>(0);
  const { filterByType, paused, setPaused } = useGlobalDataStream();
  
  // Get stratum V1 data from the global data stream if not provided via props
  const stratumV1Data = data.length > 0 ? data : filterByType(StreamDataType.STRATUM_V1);
  
  // Handle events from the EventSource
  const handleEvent = (event: any) => {
    try {
      if (paused) return;
      
      // Process the new event
      sankeyDataProcessor.processStratumV1Event(event);
      
      // Trigger re-render by updating data version
      setDataVersion(prev => prev + 1);
      
    } catch (err) {
      console.error("Error processing event:", err);
      setError(`Error processing event: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  
  // Initialize or reset the diagram data
  const initializeDiagram = () => {
    try {
      // Reset any previous data
      sankeyDataProcessor.reset();
      
      // Process real data if available
      if (stratumV1Data.length > 0) {
        processRealData();
      }
      
      // Trigger initial render
      setDataVersion(prev => prev + 1);
      
      // Clear any previous errors
      setError(null);
    } catch (err) {
      console.error("Error initializing diagram:", err);
      setError(`Error initializing diagram: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  
  // Process data from the global data stream
  const processRealData = () => {
    try {
      if (stratumV1Data.length === 0) return;
      
      console.log(`Processing ${stratumV1Data.length} stratum V1 events`);
      
      // Process each event through the sankey data processor
      stratumV1Data.forEach((event: any) => {
        sankeyDataProcessor.processStratumV1Event(event);
      });
      
    } catch (err) {
      console.error("Error processing real data:", err);
      setError(`Error processing data: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  
  // Connect to EventSource API and handle initialization
  useEffect(() => {
    try {
      // Register event handler
      eventSourceService.onEvent(handleEvent);
      setIsConnected(true);
    } catch (err) {
      console.error("Error connecting to EventSource:", err);
      setError(`Error connecting to EventSource: ${err instanceof Error ? err.message : String(err)}`);
      setIsConnected(false);
    }
    
    // Initialize the diagram
    initializeDiagram();
    
    // Cleanup
    return () => {
      try {
        eventSourceService.offEvent(handleEvent);
      } catch (err) {
        console.error("Error disconnecting from EventSource:", err);
      }
    };
  }, []); // Empty dependency array - runs once on mount
  
  // Process global data stream events when they change
  useEffect(() => {
    if (stratumV1Data.length > 0) {
      // Reset data processor first
      sankeyDataProcessor.reset();
      processRealData();
      // Trigger re-render
      setDataVersion(prev => prev + 1);
    }
  }, [stratumV1Data]);
  
  return {
    error,
    setError,
    isConnected,
    paused,
    setPaused,
    stratumV1Data,
    dataVersion,
  };
};
