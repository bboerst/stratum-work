"use client";

import React, { createContext, useContext, ReactNode, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useDataStream } from "./useDataStream";
import { StreamData, StreamDataType, StratumV1Data } from "./types";
import { usePathname } from "next/navigation";

interface DataStreamContextType {
  data: StreamData[];
  isConnected: boolean;
  clearData: () => void;
  setPaused: (value: boolean | ((prev: boolean) => boolean)) => void;
  paused: boolean;
  filterByType: (type: StreamDataType) => StreamData[];
  setDataTypes: (types: StreamDataType[]) => void;
  activeDataTypes: StreamDataType[];
  latestMessagesByPool: { [poolName: string]: StratumV1Data };
  filteredData: StreamData[];
  availablePools: string[];
  enabledPools: Set<string>;
  setEnabledPools: (pools: Set<string>) => void;
  togglePool: (poolName: string) => void;
  toggleAllPools: (enabled: boolean) => void;
}

const DataStreamContext = createContext<DataStreamContextType | undefined>(undefined);

export function DataStreamProvider({ children }: { children: ReactNode }) {
  // Track paused state globally - starts unpaused and resets on navigation
  const [paused, setPaused] = useState(false);
  const pathname = usePathname();
  
  // Auto-resume (unpause) on page navigation
  useEffect(() => {
    setPaused(false);
  }, [pathname]); // Resets pause state whenever route changes
  
  // Track which data types to subscribe to
  const [dataTypes, setDataTypes] = useState<StreamDataType[]>(Object.values(StreamDataType));
  
  // Track enabled pools for filtering
  const [enabledPools, setEnabledPools] = useState<Set<string>>(new Set());
  const [hasInitialized, setHasInitialized] = useState(false);
  const seenPoolsRef = useRef<Set<string>>(new Set());
  
  // Create a single instance of the data stream
  const dataStream = useDataStream({ paused, dataTypes });
  
  // Extract available pools from the data stream
  const availablePools = useMemo(() => {
    const pools = new Set<string>();
    dataStream.data.forEach(item => {
      if (item.type === StreamDataType.STRATUM_V1) {
        const stratumData = item.data as StratumV1Data;
        if (stratumData.pool_name) {
          pools.add(stratumData.pool_name);
        }
      }
    });
    return Array.from(pools).sort();
  }, [dataStream.data]);
  
  // Initialize enabled pools when first pools become available
  useEffect(() => {
    if (availablePools.length > 0 && !hasInitialized) {
      // Always enable all pools by default (no localStorage)
      setEnabledPools(new Set(availablePools));
      // Mark all current pools as seen
      availablePools.forEach(pool => seenPoolsRef.current.add(pool));
      setHasInitialized(true);
    }
  }, [availablePools, hasInitialized]);
  
  // Auto-enable truly new pools that appear after initialization
  useEffect(() => {
    if (hasInitialized && availablePools.length > 0) {
      const currentSeen = seenPoolsRef.current;
      const newPools = availablePools.filter(pool => !currentSeen.has(pool));
      
      if (newPools.length > 0) {
        // Update our seen pools
        newPools.forEach(pool => currentSeen.add(pool));
        
        // Add only truly new pools to enabled set
        setEnabledPools(prev => {
          const newSet = new Set(prev);
          newPools.forEach(pool => newSet.add(pool));
          return newSet;
        });
      }
    }
  }, [availablePools, hasInitialized]);
  
  
  // Filter data based on enabled pools
  const filteredData = useMemo(() => {
    // Always apply filtering logic, regardless of initialization state
    const filtered = dataStream.data.filter(item => {
      if (item.type === StreamDataType.STRATUM_V1) {
        const stratumData = item.data as StratumV1Data;
        
        // If we haven't initialized yet, allow all pools through
        if (!hasInitialized) {
          return true;
        }
        
        // If no pools are enabled, block all stratum data
        if (enabledPools.size === 0) {
          return false;
        }
        
        // Check if this specific pool is enabled
        const isEnabled = enabledPools.has(stratumData.pool_name);
        return isEnabled;
      }
      // For non-stratum data, always include it
      return true;
    });
    
    return filtered;
  }, [dataStream.data, enabledPools, hasInitialized]);
  
  // Toggle a single pool
  const togglePool = useCallback((poolName: string) => {
    setEnabledPools(prev => {
      const newSet = new Set(prev);
      const wasEnabled = newSet.has(poolName);
      if (wasEnabled) {
        newSet.delete(poolName);
      } else {
        newSet.add(poolName);
      }
      return newSet;
    });
  }, []);
  
  // Toggle all pools
  const toggleAllPools = useCallback((enabled: boolean) => {
    if (enabled) {
      setEnabledPools(new Set(availablePools));
    } else {
      setEnabledPools(new Set());
    }
  }, [availablePools]);
  
  // Combine the data stream with the paused state and pool filtering
  const value = {
    ...dataStream,
    setPaused,
    paused,
    setDataTypes,
    activeDataTypes: dataTypes,
    latestMessagesByPool: dataStream.latestMessagesByPool,
    filteredData,
    availablePools,
    enabledPools,
    setEnabledPools,
    togglePool,
    toggleAllPools
  };

  return (
    <DataStreamContext.Provider value={value}>
      {children}
    </DataStreamContext.Provider>
  );
}

export function useGlobalDataStream() {
  const context = useContext(DataStreamContext);
  if (context === undefined) {
    throw new Error("useGlobalDataStream must be used within a DataStreamProvider");
  }
  return context;
} 