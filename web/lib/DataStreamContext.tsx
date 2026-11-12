"use client";

import React, { createContext, useContext, ReactNode, useState, useEffect, useRef, useCallback } from "react";

import { useDataStream } from "./useDataStream";
import { DEFAULT_STREAM_ENDPOINT } from "./streamEndpoint";
import { StreamData, StreamDataType, StratumV1Data } from "./types";
import { usePathname } from "next/navigation";
import { BufferedTemplate, TemplateBuffer, liveSinceMs } from "./templateBuffer";
import { prefillTemplateBuffer } from "./prefill";

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

export type PrefillStatus = "pending" | "loading" | "loaded" | "disabled" | "error";

/** A render-time snapshot of the shared template buffer (lib/templateBuffer.ts, #130). */
export interface TemplateBufferSnapshot {
  /** Buffered Bitcoin templates, oldest first. */
  entries: BufferedTemplate[];
  version: number;
  /** Changes when entries arrived out of order; incremental consumers rebuild from `entries`. */
  epoch: number;
  tipHeight: number | null;
  currentHeight: number | null;
  /** Receive time of the first template that came over the stream (the history/live boundary). */
  liveSinceMs: number | null;
  prefill: { status: PrefillStatus; count: number };
}

const TemplateBufferContext = createContext<TemplateBufferSnapshot | undefined>(undefined);

/** Coalesce buffer updates so a burst of stream messages costs one re-render of the visuals. */
const BUFFER_NOTIFY_MS = 150;

interface RuntimeConfig {
  streamEndpoint?: string;
  historicalDataEnabled?: boolean;
}

export function DataStreamProvider({ children }: { children: ReactNode }) {
  // Track paused state globally - starts unpaused and resets on navigation
  const [paused, setPaused] = useState(false);
  const [streamEndpoint, setStreamEndpoint] = useState<string | null>(null);
  const [historicalDataEnabled, setHistoricalDataEnabled] = useState<boolean | null>(null);
  const pathname = usePathname();

  // Shared template buffer: lives here so it survives switching between visuals (#130).
  const [buffer] = useState(() => new TemplateBuffer());
  const [prefillResult, setPrefillResult] = useState<{ status: PrefillStatus; count: number } | null>(null);
  const prefill = React.useMemo<{ status: PrefillStatus; count: number }>(() => {
    if (historicalDataEnabled === null) return { status: "pending", count: 0 };
    if (!historicalDataEnabled) return { status: "disabled", count: 0 };
    return prefillResult ?? { status: "loading", count: 0 };
  }, [historicalDataEnabled, prefillResult]);
  const [bufferSnapshot, setBufferSnapshot] = useState<Omit<TemplateBufferSnapshot, "prefill">>(() => ({
    entries: [], version: 0, epoch: 0, tipHeight: null, currentHeight: null, liveSinceMs: null,
  }));
  const notifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publishBuffer = useCallback(() => {
    notifyTimerRef.current = null;
    const entries = buffer.entries();
    setBufferSnapshot({
      entries,
      version: buffer.version,
      epoch: buffer.epoch,
      tipHeight: buffer.tipHeight,
      currentHeight: buffer.currentHeight,
      liveSinceMs: liveSinceMs(entries),
    });
  }, [buffer]);

  const scheduleBufferPublish = useCallback(() => {
    if (notifyTimerRef.current === null) {
      notifyTimerRef.current = setTimeout(publishBuffer, BUFFER_NOTIFY_MS);
    }
  }, [publishBuffer]);

  useEffect(() => () => {
    if (notifyTimerRef.current !== null) clearTimeout(notifyTimerRef.current);
  }, []);

  // Feed the buffer from the stream. useDataStream only calls this for messages that pass the pause check.
  const handleStreamMessage = useCallback((item: StreamData) => {
    const before = buffer.version;
    if (item.type === StreamDataType.STRATUM_V1) {
      buffer.add([item.data], "live");
    } else if (item.type === StreamDataType.BLOCK) {
      buffer.setTip(item.data?.height);
    }
    if (buffer.version !== before) scheduleBufferPublish();
  }, [buffer, scheduleBufferPublish]);

  useEffect(() => {
    let cancelled = false;

    const loadRuntimeConfig = async () => {
      try {
        const response = await fetch("/api/runtime-config", { cache: "no-store" });
        if (!response.ok) throw new Error(`Runtime config request failed: ${response.status}`);

        const config = await response.json() as RuntimeConfig;
        if (!cancelled) {
          setStreamEndpoint(config.streamEndpoint || DEFAULT_STREAM_ENDPOINT);
          setHistoricalDataEnabled(config.historicalDataEnabled === true);
        }
      } catch (error) {
        console.error("Error loading runtime config", error);
        if (!cancelled) {
          setStreamEndpoint(DEFAULT_STREAM_ENDPOINT);
          // Without the config we can't tell whether history is enabled; skip the pre-fill (today's behavior).
          setHistoricalDataEnabled(false);
        }
      }
    };

    loadRuntimeConfig();

    return () => {
      cancelled = true;
    };
  }, []);
  
  // Pre-fill the buffer from history once, alongside connecting the stream (#130). With historical data disabled
  // nothing is fetched and the visuals fill from the stream only, as before.
  useEffect(() => {
    if (!historicalDataEnabled) return;

    let cancelled = false;
    prefillTemplateBuffer(buffer, { historicalDataEnabled })
      .then(result => {
        if (cancelled) return;
        publishBuffer();
        setPrefillResult(result);
      })
      .catch(error => {
        console.error("Error pre-filling realtime data", error);
        if (!cancelled) setPrefillResult({ status: "error", count: 0 });
      });

    return () => {
      cancelled = true;
    };
  }, [historicalDataEnabled, buffer, publishBuffer]);

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
    onMessage: handleStreamMessage,
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

  const templateBufferValue = React.useMemo<TemplateBufferSnapshot>(
    () => ({ ...bufferSnapshot, prefill }),
    [bufferSnapshot, prefill],
  );

  return (
    <DataStreamContext.Provider value={value}>
      <TemplateBufferContext.Provider value={templateBufferValue}>
        {children}
      </TemplateBufferContext.Provider>
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

/** The shared, bounded buffer of recent templates that the realtime visuals read from (#130). */
export function useTemplateBuffer() {
  const context = useContext(TemplateBufferContext);
  if (context === undefined) {
    throw new Error("useTemplateBuffer must be used within a DataStreamProvider");
  }
  return context;
}
