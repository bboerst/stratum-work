import { StreamDataType, type StratumV1Data, type StreamData } from '@/lib/types';
import type { StreamBlock } from './store';
import type { Template } from './types';

export interface LegacyStreamData { data: StreamData[]; latestMessagesByPool: Record<string, StratumV1Data> }

/**
 * Rebuilds what `useDataStream` used to hold from the store: one STRATUM_V1 entry per (pool, height) keeping the
 * latest, one BLOCK entry per hash, oldest first (the legacy array order), capped to the newest `maxItems`.
 * Only observe-mode templates count, and a pool seen through several connections contributes each content once
 * (from the connection that delivered it first).
 */
export function toLegacyStreamData(templates: readonly Template[], streamBlocks: readonly StreamBlock[], maxItems = 50): LegacyStreamData {
  const byPool = new Map<string, Template[]>();
  for (const t of templates) {
    if (t.mode !== 'observe' || !t.pool) continue;
    let arr = byPool.get(t.pool);
    if (!arr) { arr = []; byPool.set(t.pool, arr); }
    arr.push(t);
  }
  const items: Array<{ at: number; d: StreamData }> = [];
  const latestMessagesByPool: Record<string, StratumV1Data> = {};
  for (const [pool, ts] of byPool) {
    ts.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    // Content first delivered by one connection is ignored when another connection repeats it; repeats on the
    // same connection (new job id / timestamp) still replace the row, as the single legacy connection did.
    const owner = new Map<string, string>();
    const byHeight = new Map<number, Template>();
    let latest: Template | null = null;
    for (const t of ts) {
      const first = owner.get(t.contentKey);
      if (first === undefined) owner.set(t.contentKey, t.connectionId);
      else if (first !== t.connectionId) continue;
      byHeight.set(t.height, t);
      latest = t;
    }
    if (latest) latestMessagesByPool[pool] = latest.raw;
    for (const t of byHeight.values()) {
      const id = (t.raw as { _id?: string })._id ?? `${t.raw.pool_name}-${t.raw.timestamp}`;
      items.push({ at: t.receivedAtMs, d: { type: StreamDataType.STRATUM_V1, id, timestamp: t.raw.timestamp, data: t.raw } });
    }
  }
  const seen = new Set<string>();
  for (const { block: b, rxMs } of streamBlocks) {
    if (!b?.hash || seen.has(b.hash)) continue;
    seen.add(b.hash);
    // Sort on arrival: the header timestamp trails arrival by minutes and would push fresh blocks past the cap.
    items.push({ at: rxMs, d: { type: StreamDataType.BLOCK, id: b.hash, timestamp: b.timestamp, data: b } });
  }
  items.sort((a, b) => a.at - b.at);
  return { data: items.slice(Math.max(0, items.length - maxItems)).map(i => i.d), latestMessagesByPool };
}
