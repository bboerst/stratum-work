/**
 * Realtime pre-fill (#130): which recent templates to send a browser when it opens a realtime view, so the table,
 * timing chart and Sankey are populated before the first stream message. Pure functions, unit-tested in
 * lib/__tests__/prefill.test.ts; the route is app/api/realtime-prefill/route.ts.
 */
import { timestampMicros } from './templateBuffer';
import type { StratumV1Data } from './types';

/** The widest window the timing chart offers (its time-window control stops at 300 s). */
export const PREFILL_WINDOW_MS = 300_000;

export interface PrefillTemplate {
  pool_name?: string | null;
  timestamp: string;
  chain_family?: string | null;
}

/** Heights to read: the one being mined (tip + 1), plus the tip itself while it's young enough to be on the chart. */
export function prefillHeights(tip: { height: number; timestamp: number }, nowMs: number, windowMs = PREFILL_WINDOW_MS): number[] {
  const heights = [tip.height + 1];
  if (nowMs - tip.timestamp * 1000 < windowMs) heights.push(tip.height);
  return heights;
}

/**
 * From the templates at those heights, keep what the visuals use:
 *  - everything received in the last `windowMs` (the timing chart), and
 *  - each pool's latest template before that (the table and Sankey show each pool's latest; the chart needs it as
 *    the start of the bar crossing its left edge).
 * Blacklisted pools and non-Bitcoin templates are dropped, exactly as the stream route and /api/mining-notify do.
 * Output is oldest first.
 */
export function selectPrefillTemplates<T extends PrefillTemplate>(
  records: T[],
  { nowMs, windowMs = PREFILL_WINDOW_MS, isBlacklisted }: {
    nowMs: number;
    windowMs?: number;
    isBlacklisted: (poolName: string | null | undefined) => boolean;
  },
): T[] {
  const cutoffUs = BigInt(Math.floor(nowMs - windowMs)) * BigInt(1000);
  const withTime: { rec: T; us: bigint }[] = [];
  for (const rec of records) {
    if (!rec.pool_name || isBlacklisted(rec.pool_name)) continue;
    if (rec.chain_family) continue;
    const us = timestampMicros(rec.timestamp);
    if (us === null) continue;
    withTime.push({ rec, us });
  }
  withTime.sort((a, b) => (a.us < b.us ? -1 : a.us > b.us ? 1 : 0));

  const lastBefore = new Map<string, { rec: T; us: bigint }>();
  const inWindow: { rec: T; us: bigint }[] = [];
  for (const item of withTime) {
    if (item.us >= cutoffUs) inWindow.push(item);
    else lastBefore.set(item.rec.pool_name!, item);
  }
  return [...lastBefore.values(), ...inWindow]
    .sort((a, b) => (a.us < b.us ? -1 : a.us > b.us ? 1 : 0))
    .map(item => item.rec);
}

export const PREFILL_ENDPOINT = '/api/realtime-prefill';

export interface PrefillResult {
  status: 'loaded' | 'disabled';
  /** Templates added to the buffer (after de-duplication against anything the stream already delivered). */
  count: number;
}

/** What the browser needs from TemplateBuffer, so this can be tested without the class. */
export interface PrefillTarget {
  setTip(height: number | null | undefined): unknown;
  add(templates: StratumV1Data[], origin: 'prefill'): number;
}

/**
 * Browser side: seed the shared template buffer from /api/realtime-prefill. With historical data disabled, nothing
 * is requested and the visuals fill from the stream only, as before #130. Throws on a failed request.
 */
export async function prefillTemplateBuffer(
  buffer: PrefillTarget,
  { historicalDataEnabled, fetchFn = (input, init) => fetch(input, init) }: {
    historicalDataEnabled: boolean;
    fetchFn?: typeof fetch;
  },
): Promise<PrefillResult> {
  if (!historicalDataEnabled) return { status: 'disabled', count: 0 };

  const response = await fetchFn(PREFILL_ENDPOINT, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Pre-fill request failed: ${response.status}`);
  const body = await response.json() as { enabled?: boolean; tip?: { height: number } | null; templates?: StratumV1Data[] };
  if (body.enabled === false) return { status: 'disabled', count: 0 };

  buffer.setTip(body.tip?.height);
  const count = buffer.add(Array.isArray(body.templates) ? body.templates : [], 'prefill');
  return { status: 'loaded', count };
}
