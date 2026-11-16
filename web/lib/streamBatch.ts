/**
 * Folding stream messages into the stream hook's state in batches (lib/useDataStream.ts).
 *
 * The stream can deliver many messages per second, and a burst at a new block (every pool sends new work at once).
 * Applying each message as its own React state update re-renders every consumer per message; queuing them and
 * applying the queue once per flush gives the same final state with one render. These helpers are that fold, pure so
 * they can be unit-tested (lib/__tests__/streamBatch.test.ts): applying a batch equals applying its messages one by
 * one, in order.
 */
import { StreamData, StreamDataType, StratumV1Data } from "./types";

/**
 * Adds one message to the recent-messages list: a template replaces the same pool's entry at the same height, a block
 * replaces the entry with the same hash, then the list keeps its newest `maxItems`.
 */
export function appendStreamItem(prev: StreamData[], item: StreamData, maxItems: number): StreamData[] {
  let next: StreamData[];
  if (item.type === StreamDataType.STRATUM_V1) {
    const t = item.data as StratumV1Data;
    next = prev.filter(
      (p) => !(p.type === StreamDataType.STRATUM_V1 && p.data.pool_name === t.pool_name && p.data.height === t.height)
    );
  } else if (item.type === StreamDataType.BLOCK) {
    next = prev.filter((p) => !(p.type === StreamDataType.BLOCK && p.data.hash === item.data.hash));
  } else {
    next = [...prev];
  }
  next.push(item);
  return next.slice(-maxItems);
}

/** appendStreamItem over a batch, in order. Returns `prev` itself for an empty batch (no re-render). */
export function appendStreamItems(prev: StreamData[], items: readonly StreamData[], maxItems: number): StreamData[] {
  let next = prev;
  for (const item of items) next = appendStreamItem(next, item, maxItems);
  return next;
}

/** Messages received since the last flush. */
export class StreamBatch {
  items: StreamData[] = [];
  /** The newest template per pool in this batch. */
  latestByPool: { [poolName: string]: StratumV1Data } = {};

  add(item: StreamData, stratum: StratumV1Data | null): void {
    this.items.push(item);
    if (stratum && stratum.pool_name) this.latestByPool[stratum.pool_name] = stratum;
  }

  get empty(): boolean {
    return this.items.length === 0;
  }
}

/** Merges a batch's newest template per pool into the per-pool map; `prev` itself when the batch has none. */
export function mergeLatestByPool(
  prev: { [poolName: string]: StratumV1Data },
  batch: { [poolName: string]: StratumV1Data }
): { [poolName: string]: StratumV1Data } {
  return Object.keys(batch).length ? { ...prev, ...batch } : prev;
}
