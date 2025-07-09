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
  const [hasLoadedFromStorage, setHasLoadedFromStorage] = useState(false);
  
  // Keep track of pools we've seen before to detect truly new ones
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
  
  // Load enabled pools from localStorage only once when first pools become available
  useEffect(() => {
    if (typeof window !== "undefined" && availablePools.length > 0 && !hasLoadedFromStorage) {
      const saved = localStorage.getItem("enabledPools");
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as string[];
          setEnabledPools(new Set(parsed));
        } catch {
          // If parsing fails, enable all pools by default
          setEnabledPools(new Set(availablePools));
        }
      } else {
        // If no saved data, enable all pools by default
        setEnabledPools(new Set(availablePools));
      }
      
      // Mark all current pools as seen
      availablePools.forEach(pool => seenPoolsRef.current.add(pool));
      setHasLoadedFromStorage(true);
    }
  // Only depend on the length and load status to avoid re-running on every data change
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availablePools.length, hasLoadedFromStorage]);
  
  // Auto-enable truly new pools that appear
  useEffect(() => {
    if (hasLoadedFromStorage && availablePools.length > 0) {
      const currentSeen = seenPoolsRef.current;
      const newPools = availablePools.filter(pool => !currentSeen.has(pool));
      
      if (newPools.length > 0) {
        // Update our seen pools
        newPools.forEach(pool => currentSeen.add(pool));
        
        // Add new pools to enabled set (they should be enabled by default)
        setEnabledPools(prev => {
          const newSet = new Set(prev);
          newPools.forEach(pool => newSet.add(pool));
          return newSet;
        });
      }
    }
  }, [availablePools, hasLoadedFromStorage]);
  
  // Save enabled pools to localStorage whenever they change
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("enabledPools", JSON.stringify(Array.from(enabledPools)));
    }
  }, [enabledPools]);
  
  // Filter data based on enabled pools
  const filteredData = useMemo(() => {
    // Always apply filtering logic, regardless of initialization state
    const filtered = dataStream.data.filter(item => {
      if (item.type === StreamDataType.STRATUM_V1) {
        const stratumData = item.data as StratumV1Data;
        
        // If we haven't loaded from storage yet, allow all pools through
        if (!hasLoadedFromStorage) {
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
  }, [dataStream.data, enabledPools, hasLoadedFromStorage]);
  
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