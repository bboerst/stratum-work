"use client";

import React, { createContext, useContext, useState, useCallback, useMemo, useEffect, ReactNode } from "react";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from "@/lib/types";

const STORAGE_KEY_HIDDEN = "poolFilterHidden";

function loadHiddenPools(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(STORAGE_KEY_HIDDEN);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr);
    }
  } catch { /* ignore corrupt data */ }
  return new Set();
}

interface PoolFilterContextType {
  allPools: string[];
  hiddenPools: Set<string>;
  togglePool: (poolName: string) => void;
  isPoolVisible: (poolName: string) => boolean;
  showAllPools: () => void;
  hideAllPools: () => void;
  visiblePoolCount: number;
}

const PoolFilterContext = createContext<PoolFilterContextType | undefined>(undefined);

export function PoolFilterProvider({ children }: { children: ReactNode }) {
  const { data, latestMessagesByPool } = useGlobalDataStream();
  const [hiddenPools, setHiddenPools] = useState<Set<string>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const restored = loadHiddenPools();
    if (restored.size > 0) setHiddenPools(restored);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY_HIDDEN, JSON.stringify(Array.from(hiddenPools)));
  }, [hiddenPools, hydrated]);

  const allPools = useMemo(() => {
    const poolSet = new Set<string>();
    Object.keys(latestMessagesByPool).forEach(name => poolSet.add(name));
    data.forEach(item => {
      if (item.type === StreamDataType.STRATUM_V1 && item.data.pool_name) {
        poolSet.add(item.data.pool_name);
      }
    });
    return Array.from(poolSet).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [data, latestMessagesByPool]);

  const togglePool = useCallback((poolName: string) => {
    setHiddenPools(prev => {
      const next = new Set(prev);
      if (next.has(poolName)) {
        next.delete(poolName);
      } else {
        next.add(poolName);
      }
      return next;
    });
  }, []);

  const isPoolVisible = useCallback((poolName: string) => {
    return !hiddenPools.has(poolName);
  }, [hiddenPools]);

  const showAllPools = useCallback(() => {
    setHiddenPools(new Set());
  }, []);

  const hideAllPools = useCallback(() => {
    setHiddenPools(new Set(allPools));
  }, [allPools]);

  const visiblePoolCount = allPools.length - hiddenPools.size;

  const value = useMemo(() => ({
    allPools,
    hiddenPools,
    togglePool,
    isPoolVisible,
    showAllPools,
    hideAllPools,
    visiblePoolCount,
  }), [allPools, hiddenPools, togglePool, isPoolVisible, showAllPools, hideAllPools, visiblePoolCount]);

  return (
    <PoolFilterContext.Provider value={value}>
      {children}
    </PoolFilterContext.Provider>
  );
}

export function usePoolFilter() {
  const context = useContext(PoolFilterContext);
  if (context === undefined) {
    throw new Error("usePoolFilter must be used within a PoolFilterProvider");
  }
  return context;
}
