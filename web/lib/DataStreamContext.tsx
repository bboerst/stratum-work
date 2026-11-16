"use client";

import React, { createContext, useContext, ReactNode, useState, useEffect, useRef, useCallback } from "react";

import { useDataStream, type PoolBurst } from "./useDataStream";
import { DEFAULT_STREAM_ENDPOINT } from "./streamEndpoint";
import { StreamData, StreamDataType, StratumV1Data } from "./types";
import { usePathname } from "next/navigation";
import { BufferedTemplate, TemplateBuffer } from "./templateBuffer";
import { prefillTemplateBuffer } from "./prefill";
import { fetchWithRetry } from "./fetchRetry";

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
  burstsByPool: { [poolName: string]: PoolBurst };
}

const DataStreamContext = createContext<DataStreamContextType | undefined>(undefined);

/**
 * The part of the stream context that changes rarely (connection, pause, bursts). Components that need only these
 * read useStreamStatus(), so they don't re-render on every stream flush the way useGlobalDataStream() consumers do.
 */
export type StreamStatusContextType = Pick<
  DataStreamContextType,
  "isConnected" | "paused" | "setPaused" | "setDataTypes" | "activeDataTypes" | "burstsByPool"
>;

const StreamStatusContext = createContext<StreamStatusContextType | undefined>(undefined);

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
  prefill: { status: PrefillStatus; count: number };
}

const TemplateBufferContext = createContext<TemplateBufferSnapshot | undefined>(undefined);

/**
 * Coalesce stream messages and buffer updates so a burst of stream messages costs one re-render: the stream state
 * (recent messages, latest per pool) and the template buffer snapshot are applied together, at most this often.
 */
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
    entries: [], version: 0, epoch: 0, tipHeight: null, currentHeight: null,
  }));
  // Buffer version last published to the snapshot
  const publishedVersionRef = useRef(-1);

  const publishBuffer = useCallback(() => {
    publishedVersionRef.current = buffer.version;
    setBufferSnapshot({
      entries: buffer.entries(),
      version: buffer.version,
      epoch: buffer.epoch,
      tipHeight: buffer.tipHeight,
      currentHeight: buffer.currentHeight,
    });
  }, [buffer]);

  // Feed the buffer from the stream. useDataStream only calls this for messages that pass the pause check; the
  // snapshot is published in the stream's next flush (handleStreamFlush), in the same render as the stream state.
  const handleStreamMessage = useCallback((item: StreamData) => {
    if (item.type === StreamDataType.STRATUM_V1) {
      buffer.add([item.data]);
    } else if (item.type === StreamDataType.BLOCK) {
      buffer.setTip(item.data?.height);
    }
  }, [buffer]);

  const handleStreamFlush = useCallback(() => {
    if (buffer.version !== publishedVersionRef.current) publishBuffer();
  }, [buffer, publishBuffer]);

  useEffect(() => {
    let cancelled = false;

    const loadRuntimeConfig = async () => {
      try {
        const response = await fetchWithRetry("/api/runtime-config", { cache: "no-store" });
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
    coalesceMs: BUFFER_NOTIFY_MS,
    onFlush: handleStreamFlush,
  });
  const { data, isConnected, clearData, filterByType, latestMessagesByPool, burstsByPool } = dataStream;

  // Combine the data stream with the paused state. Memoized, so consumers re-render only when a field changes.
  const value = React.useMemo<DataStreamContextType>(() => ({
    data,
    isConnected,
    clearData,
    filterByType,
    latestMessagesByPool,
    burstsByPool,
    setPaused,
    paused,
    setDataTypes,
    activeDataTypes: dataTypes,
  }), [data, isConnected, clearData, filterByType, latestMessagesByPool, burstsByPool, paused, dataTypes]);

  const statusValue = React.useMemo<StreamStatusContextType>(() => ({
    isConnected,
    paused,
    setPaused,
    setDataTypes,
    activeDataTypes: dataTypes,
    burstsByPool,
  }), [isConnected, paused, dataTypes, burstsByPool]);

  const templateBufferValue = React.useMemo<TemplateBufferSnapshot>(
    () => ({ ...bufferSnapshot, prefill }),
    [bufferSnapshot, prefill],
  );

  return (
    <DataStreamContext.Provider value={value}>
      <StreamStatusContext.Provider value={statusValue}>
        <TemplateBufferContext.Provider value={templateBufferValue}>
          {children}
        </TemplateBufferContext.Provider>
      </StreamStatusContext.Provider>
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

/** Connection, pause and burst state only: doesn't re-render on every stream flush (see StreamStatusContextType). */
export function useStreamStatus() {
  const context = useContext(StreamStatusContext);
  if (context === undefined) {
    throw new Error("useStreamStatus must be used within a DataStreamProvider");
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
