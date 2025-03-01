"use client";

import React, { createContext, useContext, ReactNode, useState } from "react";
import { useDataStream } from "./useDataStream";
import { StratumV1Data } from "./types";

interface DataStreamContextType {
  data: StratumV1Data[];
  isConnected: boolean;
  clearData: () => void;
  setPaused: (paused: boolean) => void;
  paused: boolean;
}

const DataStreamContext = createContext<DataStreamContextType | undefined>(undefined);

export function DataStreamProvider({ children }: { children: ReactNode }) {
  // Track paused state globally
  const [paused, setPaused] = useState(false);
  
  // Create a single instance of the data stream
  const dataStream = useDataStream({ paused });

  // Combine the data stream with the paused state
  const value = {
    ...dataStream,
    setPaused,
    paused
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