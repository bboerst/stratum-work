import { useEffect, useState, useRef, useCallback, useTransition } from "react";
import { getStreamEndpoint } from "./streamEndpoint";
import { StreamData, StreamDataType, StratumV1Data } from "./types";
import { StreamBatch, appendStreamItems, mergeLatestByPool } from "./streamBatch";

interface UseDataStreamOptions {
  endpoint?: string;
  enabled?: boolean;
  initialReconnectFrequency?: number;
  maxReconnectFrequency?: number;
  paused?: boolean;
  maxItems?: number;
  dataTypes?: StreamDataType[];
  /** Called with every message that isn't dropped by pause, e.g. to feed the shared template buffer (#130). */
  onMessage?: (item: StreamData) => void;
  /**
   * Apply queued messages to the state at most this often (ms), as one render instead of one per message. 0 (the
   * default) applies each message as it arrives.
   */
  coalesceMs?: number;
  /** Called inside each flush, so state updates made there (e.g. publishing the template buffer) share its render. */
  onFlush?: () => void;
}

/** The latest burst seen for a pool: the stream route showed only some of its templates live (#105). */
export interface PoolBurst {
  /** Templates not shown live during this burst so far (all of them are stored). */
  suppressed: number;
  /** When the burst started and when it was last reported (ms since the epoch, server clock). */
  firstMs: number;
  lastMs: number;
  /** When this client last received a marker (client clock), for fading the indicator. */
  seenAt: number;
}

interface UseDataStreamResult {
  data: StreamData[];
  isConnected: boolean;
  clearData: () => void;
  filterByType: (type: StreamDataType) => StreamData[];
  latestMessagesByPool: { [poolName: string]: StratumV1Data };
  burstsByPool: { [poolName: string]: PoolBurst };
}

/** A burst episode ends (for the indicator) when no marker came for this long. */
export const BURST_EPISODE_GAP_MS = 30_000;

/** A pool's burst is shown for this long after its last marker. */
export const BURST_DISPLAY_MS = 2 * 60_000;

/** Drops bursts older than BURST_DISPLAY_MS; returns `prev` itself when nothing changes (no re-render). */
export function pruneBursts(
  prev: { [poolName: string]: PoolBurst },
  now: number,
): { [poolName: string]: PoolBurst } {
  const stale = Object.keys(prev).filter(p => now - prev[p].seenAt >= BURST_DISPLAY_MS);
  if (stale.length === 0) return prev;
  const next = { ...prev };
  for (const p of stale) delete next[p];
  return next;
}

/** Folds a burst marker into the per-pool state; a marker after a quiet gap starts a new episode. */
export function applyBurstMarker(
  prev: { [poolName: string]: PoolBurst },
  marker: { pool_name: string; suppressed: number; first_ms: number; last_ms: number },
  now: number,
): { [poolName: string]: PoolBurst } {
  const cur = prev[marker.pool_name];
  const continues = cur !== undefined && now - cur.seenAt < BURST_EPISODE_GAP_MS;
  return {
    ...prev,
    [marker.pool_name]: {
      suppressed: (continues ? cur.suppressed : 0) + marker.suppressed,
      firstMs: continues ? cur.firstMs : marker.first_ms,
      lastMs: marker.last_ms,
      seenAt: now,
    },
  };
}

/**
 * Custom hook to connect to an EventSource stream and manage the data
 * 
 * @param options Configuration options for the data stream
 * @returns Object containing the current data, connection status, and utility functions
 */
export function useDataStream({
  endpoint = getStreamEndpoint(),
  enabled = true,
  initialReconnectFrequency = 1,
  maxReconnectFrequency = 60,
  paused = false,
  maxItems = 50,
  dataTypes = Object.values(StreamDataType),
  onMessage,
  coalesceMs = 0,
  onFlush,
}: UseDataStreamOptions = {}): UseDataStreamResult {
  const [data, setData] = useState<StreamData[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [latestMessagesByPool, setLatestMessagesByPool] = useState<{ [poolName: string]: StratumV1Data }>({});
  const [burstsByPool, setBurstsByPool] = useState<{ [poolName: string]: PoolBurst }>({});
  useEffect(() => {
    const id = setInterval(() => setBurstsByPool(prev => pruneBursts(prev, Date.now())), 10_000);
    return () => clearInterval(id);
  }, []);
  
  // Add useTransition for non-urgent updates
  const [, startTransition] = useTransition();
  
  // Use refs to track the streaming state to avoid unnecessary re-renders
  const evtSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectFrequencyRef = useRef(initialReconnectFrequency);
  const pausedRef = useRef(paused);
  const dataTypesRef = useRef(dataTypes);
  const maxItemsRef = useRef(maxItems);
  const onMessageRef = useRef(onMessage);
  const onFlushRef = useRef(onFlush);
  const coalesceMsRef = useRef(coalesceMs);
  // Messages received since the last flush, and the pending flush
  const batchRef = useRef(new StreamBatch());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Update refs when props change
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  
  useEffect(() => {
    dataTypesRef.current = dataTypes;
  }, [dataTypes]);
  
  useEffect(() => {
    maxItemsRef.current = maxItems;
  }, [maxItems]);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    onFlushRef.current = onFlush;
  }, [onFlush]);

  useEffect(() => {
    coalesceMsRef.current = coalesceMs;
  }, [coalesceMs]);

  // Apply the queued messages in one batch of state updates: same final state as applying them one by one
  // (lib/streamBatch.ts), one render.
  const flush = useCallback(() => {
    flushTimerRef.current = null;
    const batch = batchRef.current;
    batchRef.current = new StreamBatch();
    startTransition(() => {
      if (!batch.empty) {
        setLatestMessagesByPool(prev => mergeLatestByPool(prev, batch.latestByPool));
        setData(prev => appendStreamItems(prev, batch.items, maxItemsRef.current));
      }
      onFlushRef.current?.();
    });
  }, [startTransition]);

  useEffect(() => () => {
    if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
  }, []);

  // Function to clear all data
  const clearData = useCallback(() => setData([]), []);
  
  // Function to filter data by type
  const filterByType = useCallback((type: StreamDataType) => {
    return data.filter(item => item.type === type);
  }, [data]);
  
  // Process incoming message
  const processMessage = useCallback((event: MessageEvent) => {
    if (pausedRef.current) return;
    
    try {
      const parsedData = JSON.parse(event.data);
      
      // Check if the data is in the new format (has a type field)
      // or the old format (direct StratumV1Data)
      let newData: StreamData | null = null;
      let stratumData: StratumV1Data | null = null;
      
      if ('type' in parsedData && parsedData.type === 'burst') {
        // The stream route throttled this pool's templates (#105): record it, don't add it to the data.
        if (typeof parsedData.pool_name === 'string' && typeof parsedData.suppressed === 'number') {
          startTransition(() => setBurstsByPool(prev => applyBurstMarker(prev, parsedData, Date.now())));
        }
        return;
      } else if ('type' in parsedData) {
        // Only known types enter the data (e.g. the route's {"type":"connection"} greeting doesn't).
        if (parsedData.type !== StreamDataType.STRATUM_V1 && parsedData.type !== StreamDataType.BLOCK) return;
        // New format - already has type field
        newData = parsedData as StreamData;
        if (newData.type === StreamDataType.STRATUM_V1) {
            stratumData = newData.data as StratumV1Data;
        }
      } else if ('pool_name' in parsedData) {
        // Old format - StratumV1Data
        // Convert to new format
        stratumData = parsedData as StratumV1Data;
        newData = {
          type: StreamDataType.STRATUM_V1,
          // Safely access _id if it exists and has a value, otherwise generate fallback
          id: (stratumData && typeof stratumData === 'object' && '_id' in stratumData && (stratumData as { _id?: string })._id)
              ? (stratumData as { _id: string })._id // Assert as string here since we checked it exists
              : `${stratumData.pool_name}-${stratumData.timestamp}`,
          timestamp: stratumData.timestamp,
          data: stratumData
        };
      } else {
        // Unknown format
        return;
      }

      onMessageRef.current?.(newData);

      // Queue it for the next flush: the per-pool latest template and the recent-messages list
      batchRef.current.add(newData, stratumData);
      if (coalesceMsRef.current <= 0) flush();
      else if (flushTimerRef.current === null) flushTimerRef.current = setTimeout(flush, coalesceMsRef.current);
    } catch (error) {
      console.error("Error parsing SSE data", error);
    }
  }, [startTransition, flush]);

  // Set up and tear down the EventSource
  useEffect(() => {
    if (!enabled) {
      setIsConnected(false);
      return;
    }

    const setupEventSource = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }

      // Build the endpoint URL with data type filters if specified
      const url = new URL(endpoint, window.location.origin);
      if (dataTypesRef.current.length > 0 && dataTypesRef.current.length < Object.values(StreamDataType).length) {
        dataTypesRef.current.forEach(type => {
          url.searchParams.append('types', type);
        });
      }

      // Connect to the SSE endpoint
      evtSourceRef.current = new EventSource(url.toString());
      setIsConnected(true);

      evtSourceRef.current.onmessage = processMessage;

      evtSourceRef.current.onerror = () => {
        setIsConnected(false);
        evtSourceRef.current?.close();
        evtSourceRef.current = null;
        
        // Exponential backoff for reconnection
        const reconnectDelay = reconnectFrequencyRef.current * 1000;
        reconnectFrequencyRef.current = Math.min(reconnectFrequencyRef.current * 2, maxReconnectFrequency);
        
        reconnectTimeoutRef.current = setTimeout(() => {
          setupEventSource();
        }, reconnectDelay);
      };

      evtSourceRef.current.onopen = () => {
        setIsConnected(true);
        reconnectFrequencyRef.current = initialReconnectFrequency;
      };
    };

    setupEventSource();

    return () => {
      if (evtSourceRef.current) {
        evtSourceRef.current.close();
        evtSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
  }, [enabled, endpoint, initialReconnectFrequency, maxReconnectFrequency, processMessage]);

  return { data, isConnected, clearData, filterByType, latestMessagesByPool, burstsByPool };
}
