"use client";

import React, { createContext, useContext, ReactNode, useState, useEffect } from "react";

import { useDataStream } from "./useDataStream";
import { DEFAULT_STREAM_ENDPOINT } from "./streamEndpoint";
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
}

const DataStreamContext = createContext<DataStreamContextType | undefined>(undefined);

export function DataStreamProvider({ children }: { children: ReactNode }) {
  // Track paused state globally - starts unpaused and resets on navigation
  const [paused, setPaused] = useState(false);
  const [streamEndpoint, setStreamEndpoint] = useState<string | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    let cancelled = false;

    const loadRuntimeConfig = async () => {
      try {
        const response = await fetch("/api/runtime-config", { cache: "no-store" });
        if (!response.ok) throw new Error(`Runtime config request failed: ${response.status}`);

        const config = await response.json() as { streamEndpoint?: string };
        if (!cancelled) {
          setStreamEndpoint(config.streamEndpoint || DEFAULT_STREAM_ENDPOINT);
        }
      } catch (error) {
        console.error("Error loading runtime config", error);
        if (!cancelled) {
          setStreamEndpoint(DEFAULT_STREAM_ENDPOINT);
        }
      }
    };

    loadRuntimeConfig();

    return () => {
      cancelled = true;
    };
  }, []);
  
  // Auto-resume (unpause) on page navigation
  useEffect(() => {
    setPaused(false);
  }, [pathname]); // Resets pause state whenever route changes
  
  // Track which data types to subscribe to
  const [dataTypes, setDataTypes] = useState<StreamDataType[]>(Object.values(StreamDataType));
  
  // Create a single instance of the data stream
  const dataStream = useDataStream({
    endpoint: streamEndpoint ?? undefined,
    enabled: streamEndpoint !== null,
    paused,
    dataTypes,
  });
  
  // Combine the data stream with the paused state
  const value = {
    ...dataStream,
    setPaused,
    paused,
    setDataTypes,
    activeDataTypes: dataTypes,
    latestMessagesByPool: dataStream.latestMessagesByPool
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
