"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * Per-visual "latency adjusted" display setting. Default ON.
 * `timing-chart` also covers the height page (it reuses RealtimeChart and
 * HistoricalPoolTiming shares the same intent there).
 */
export type TimingVisualKey = "table" | "timing-chart";

const STORAGE_PREFIX = "latency-adjusted:";
const DEFAULT_VALUE = true;

interface TimingDisplayContextType {
  latencyAdjusted: Record<TimingVisualKey, boolean>;
  setLatencyAdjusted: (key: TimingVisualKey, value: boolean) => void;
}

const TimingDisplayContext = createContext<TimingDisplayContextType | undefined>(undefined);

export function TimingDisplayProvider({ children }: { children: React.ReactNode }) {
  const [latencyAdjusted, setState] = useState<Record<TimingVisualKey, boolean>>({
    table: DEFAULT_VALUE,
    "timing-chart": DEFAULT_VALUE,
  });

  // Load persisted values on mount (client only)
  useEffect(() => {
    try {
      const restored: Partial<Record<TimingVisualKey, boolean>> = {};
      (["table", "timing-chart"] as TimingVisualKey[]).forEach(key => {
        const stored = localStorage.getItem(STORAGE_PREFIX + key);
        if (stored !== null) restored[key] = stored === "true";
      });
      if (Object.keys(restored).length > 0) {
        setState(prev => ({ ...prev, ...restored }));
      }
    } catch {
      // Ignore unavailable/corrupt storage; defaults apply
    }
  }, []);

  const setLatencyAdjusted = useCallback((key: TimingVisualKey, value: boolean) => {
    setState(prev => ({ ...prev, [key]: value }));
    try {
      localStorage.setItem(STORAGE_PREFIX + key, String(value));
    } catch {
      // Persistence is best-effort (private browsing, quota)
    }
  }, []);

  return (
    <TimingDisplayContext.Provider value={{ latencyAdjusted, setLatencyAdjusted }}>
      {children}
    </TimingDisplayContext.Provider>
  );
}

/** Returns [enabled, setEnabled] for one visual's latency-adjusted setting. */
export function useLatencyAdjusted(key: TimingVisualKey): [boolean, (value: boolean) => void] {
  const context = useContext(TimingDisplayContext);
  if (!context) {
    throw new Error("useLatencyAdjusted must be used within a TimingDisplayProvider");
  }
  const { latencyAdjusted, setLatencyAdjusted } = context;
  const setter = useCallback((value: boolean) => setLatencyAdjusted(key, value), [key, setLatencyAdjusted]);
  return [latencyAdjusted[key], setter];
}
