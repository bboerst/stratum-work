"use client";

import React, { createContext, useContext, ReactNode, useState } from "react";
import { useDataStream } from "./useDataStream";
import { StreamData, StreamDataType, StratumV1Data } from "./types";

interface DataStreamContextType {
  data: StreamData[];
  isConnected: boolean;
  clearData: () => void;
  setPaused: (paused: boolean) => void;
  paused: boolean;
  filterByType: (type: StreamDataType) => StreamData[];
  setDataTypes: (types: StreamDataType[]) => void;
  activeDataTypes: StreamDataType[];
  latestMessagesByPool: { [poolName: string]: StratumV1Data };
}

const DataStreamContext = createContext<DataStreamContextType | undefined>(undefined);

export function DataStreamProvider({ children }: { children: ReactNode }) {
  // Track paused state globally
  const [paused, setPaused] = useState(false);
  
  // Track which data types to subscribe to
  const [dataTypes, setDataTypes] = useState<StreamDataType[]>(Object.values(StreamDataType));
  
  // Create a single instance of the data stream
  const dataStream = useDataStream({ paused, dataTypes });
  
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