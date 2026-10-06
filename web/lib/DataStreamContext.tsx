"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, ReactNode } from "react";

import { StreamData, StreamDataType, StratumV1Data } from "./types";
import { usePathname } from "next/navigation";
import { getLiveStore, ScopeProvider } from "./templates/ScopeProvider";
import { toLegacyStreamData, type LegacyStreamData } from "./templates/legacyAdapter";

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

// Reads the shared live TemplateStore (started by the live ScopeProvider below) and presents it in the shape the
// table, timing, sankey and infra views were written against.
function LegacyBridge({ children }: { children: ReactNode }) {
  const store = getLiveStore();
  const subscribe = useCallback((fn: () => void) => store.subscribe(fn), [store]);
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Track paused state globally - starts unpaused and resets on navigation
  const [paused, setPaused] = useState(false);
  const [dataTypes, setDataTypes] = useState<StreamDataType[]>(Object.values(StreamDataType));
  const [clearedAt, setClearedAt] = useState(0);
  const pathname = usePathname();

  useEffect(() => {
    setPaused(false);
  }, [pathname]);

  // While paused, keep returning the last computed value.
  const frozen = useRef<LegacyStreamData | null>(null);
  const computed = useMemo(() => {
    if (paused && frozen.current) return frozen.current;
    const templates = Array.from(snap.byConnection.values()).flat().filter(t => t.receivedAtMs > clearedAt);
    const blocks = snap.streamBlocks.filter(b => b.rxMs > clearedAt);
    const v = toLegacyStreamData(templates, blocks);
    v.data = v.data.filter(d => dataTypes.includes(d.type));
    frozen.current = v;
    return v;
  }, [snap, paused, dataTypes, clearedAt]);

  const filterByType = useCallback((type: StreamDataType) => computed.data.filter(d => d.type === type), [computed]);
  const clearData = useCallback(() => setClearedAt(Date.now()), []);
  const isConnected = snap.status.connected;

  const value = useMemo<DataStreamContextType>(() => ({
    data: computed.data,
    isConnected,
    clearData,
    setPaused,
    paused,
    filterByType,
    setDataTypes,
    activeDataTypes: dataTypes,
    latestMessagesByPool: computed.latestMessagesByPool,
  }), [computed, isConnected, clearData, paused, filterByType, dataTypes]);

  return (
    <DataStreamContext.Provider value={value}>
      {children}
    </DataStreamContext.Provider>
  );
}

export function DataStreamProvider({ children }: { children: ReactNode }) {
  // The live ScopeProvider starts the shared live source; LegacyBridge reads the same store.
  return (
    <ScopeProvider scope={{ kind: "live" }}>
      <LegacyBridge>{children}</LegacyBridge>
    </ScopeProvider>
  );
}

export function useGlobalDataStream() {
  const context = useContext(DataStreamContext);
  if (context === undefined) {
    throw new Error("useGlobalDataStream must be used within a DataStreamProvider");
  }
  return context;
}
