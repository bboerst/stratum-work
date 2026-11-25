"use client";

import React, { createContext, useContext, ReactNode, useState, useEffect, useRef, useCallback } from "react";

import { useDataStream, type PoolBurst } from "./useDataStream";
import { DEFAULT_STREAM_ENDPOINT } from "./streamEndpoint";
import { StreamData, StreamDataType, StratumV1Data } from "./types";
import { usePathname } from "next/navigation";
import { BufferedTemplate, TemplateBuffer } from "./templateBuffer";
import { PREFILL_WINDOW_MS, prefillTemplateBuffer } from "./prefill";
import { fetchWithRetry } from "./fetchRetry";
import { configureTxApi } from "./txFeeRates";
import type { TxApiConfig } from "./txApiConfig";

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

/**
 * Filling in gaps (the pre-fill/stream seam, a pause, a reconnect, a throttled burst): the history read is repeated
 * this long after a gap appears, then again, until the gaps are covered or the tries run out (TemplateBuffer: a read
 * that has both sides of a gap proves nothing was missed, and adds anything that was). The database has a template
 * a few seconds after the stream (measured on dev 2026-11-25: every pool's first live template was in a read 12-40 s
 * later), and the pre-fill response is shared for 5 s, so these reads cost the database at most one query per 5 s
 * however many viewers there are.
 */
export const BACKFILL_DELAYS_MS = [8_000, 20_000, 45_000];
const BACKFILL_JITTER_MS = 2_000;

interface RuntimeConfig {
  streamEndpoint?: string;
  historicalDataEnabled?: boolean;
  txApi?: Partial<TxApiConfig>;
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
      buffer.add([item.data], undefined, { live: true });
    } else if (item.type === StreamDataType.BLOCK) {
      buffer.setTip(item.data?.height);
    }
  }, [buffer]);

  const handleStreamGap = useCallback((poolName?: string) => buffer.markGap(poolName), [buffer]);

  // Re-read history after gaps (BACKFILL_DELAYS_MS). Refs, so the stream callbacks stay stable.
  const historicalRef = useRef(false);
  const pausedRef = useRef(false);
  const backfillRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; tries: number; seenGapVersion: number }>(
    { timer: null, tries: 0, seenGapVersion: 0 },
  );
  // runBackfill re-arms itself through this ref
  const runBackfillRef = useRef<() => void>(() => {});

  const runBackfill = useCallback(async () => {
    const state = backfillRef.current;
    state.timer = null;
    // Paused or hidden: nothing is shown; the next gap after resuming starts over.
    if (pausedRef.current || (typeof document !== "undefined" && document.hidden)) {
      state.seenGapVersion = -1;
      return;
    }
    if (buffer.pendingGaps(Date.now() - PREFILL_WINDOW_MS) === 0) return;
    state.tries++;
    try {
      await prefillTemplateBuffer(buffer, { historicalDataEnabled: true });
      publishBuffer();
    } catch (error) {
      console.error("Error re-reading history to fill a gap", error);
    }
    // Gaps the read itself left (older than what it covers) won't be filled by reading again.
    state.seenGapVersion = buffer.gapVersion;
    if (state.timer === null && state.tries < BACKFILL_DELAYS_MS.length && buffer.pendingGaps(Date.now() - PREFILL_WINDOW_MS) > 0) {
      const delay = BACKFILL_DELAYS_MS[state.tries] - BACKFILL_DELAYS_MS[state.tries - 1] + Math.random() * BACKFILL_JITTER_MS;
      state.timer = setTimeout(() => runBackfillRef.current(), delay);
    }
  }, [buffer, publishBuffer]);
  useEffect(() => {
    runBackfillRef.current = () => { void runBackfill(); };
  }, [runBackfill]);

  const scheduleBackfill = useCallback(() => {
    const state = backfillRef.current;
    if (!historicalRef.current || state.seenGapVersion === buffer.gapVersion) return;
    // A new gap: start the tries over from the first delay.
    state.seenGapVersion = buffer.gapVersion;
    state.tries = 0;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => runBackfillRef.current(), BACKFILL_DELAYS_MS[0] + Math.random() * BACKFILL_JITTER_MS);
  }, [buffer]);

  useEffect(() => () => {
    if (backfillRef.current.timer !== null) clearTimeout(backfillRef.current.timer);
  }, []);

  const handleStreamFlush = useCallback(() => {
    if (buffer.version !== publishedVersionRef.current) publishBuffer();
    scheduleBackfill();
  }, [buffer, publishBuffer, scheduleBackfill]);

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
          configureTxApi(config.txApi);
        }
      } catch (error) {
        console.error("Error loading runtime config", error);
        if (!cancelled) {
          setStreamEndpoint(DEFAULT_STREAM_ENDPOINT);
          // Without the config we can't tell whether history is enabled; skip the pre-fill (today's behavior).
          setHistoricalDataEnabled(false);
          configureTxApi(null);   // fee rates: the previous behavior (mempool.space)
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
    historicalRef.current = true;
    prefillTemplateBuffer(buffer, { historicalDataEnabled })
      .then(result => {
        if (cancelled) return;
        publishBuffer();
        setPrefillResult(result);
        scheduleBackfill();
      })
      .catch(error => {
        console.error("Error pre-filling realtime data", error);
        if (!cancelled) setPrefillResult({ status: "error", count: 0 });
      });

    return () => {
      cancelled = true;
    };
  }, [historicalDataEnabled, buffer, publishBuffer, scheduleBackfill]);

  // Auto-resume (unpause) on page navigation
  useEffect(() => {
    setPaused(false);
  }, [pathname]); // Resets pause state whenever route changes
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  
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
    onGap: handleStreamGap,
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
