"use client";

import React, { createContext, useContext, ReactNode, useState, useCallback } from "react";
import { StratumV1Data } from "./types";

interface HistoricalDataContextType {
  historicalData: StratumV1Data[];
  setHistoricalData: (data: StratumV1Data[]) => void;
  isHistoricalDataLoaded: boolean;
  setIsHistoricalDataLoaded: (loaded: boolean) => void;
  currentHistoricalHeight: number | null;
  setCurrentHistoricalHeight: (height: number | null) => void;
  clearHistoricalData: () => void;
}

const HistoricalDataContext = createContext<HistoricalDataContextType | undefined>(undefined);

export function HistoricalDataProvider({ children }: { children: ReactNode }) {
  const [historicalData, setHistoricalData] = useState<StratumV1Data[]>([]);
  const [isHistoricalDataLoaded, setIsHistoricalDataLoaded] = useState(false);
  const [currentHistoricalHeight, setCurrentHistoricalHeight] = useState<number | null>(null);
  
  // Function to clear historical data
  const clearHistoricalData = useCallback(() => {
    setHistoricalData([]);
    setIsHistoricalDataLoaded(false);
    setCurrentHistoricalHeight(null);
  }, []);
  
  const value = {
    historicalData,
    setHistoricalData,
    isHistoricalDataLoaded,
    setIsHistoricalDataLoaded,
    currentHistoricalHeight,
    setCurrentHistoricalHeight,
    clearHistoricalData
  };

  return (
    <HistoricalDataContext.Provider value={value}>
      {children}
    </HistoricalDataContext.Provider>
  );
}

export function useHistoricalData() {
  const context = useContext(HistoricalDataContext);
  if (context === undefined) {
    throw new Error("useHistoricalData must be used within a HistoricalDataProvider");
  }
  return context;
} 