/**
 * Timing chart block markers: where each new block starts, as the first job any feed sends on the new parent.
 *
 * The stream's BLOCK message is stamped when the backend publishes it, after pools have already switched, so the
 * marker comes from the templates themselves: the first template whose prev_hash we haven't seen and whose height is
 * above the height being mined so far. That ignores
 *  - a lagging feed still sending work on the old parent (its prev_hash was seen before),
 *  - a second parent at the same height (a competing block: the height doesn't increase), and
 *  - other chains' templates mixed into the feeds (heights far from Bitcoin's: outside the band around the Bitcoin
 *    tip when it's known, and more than MAX_HEIGHT_STEP above the current height either way).
 *
 * The first height in the input is the baseline and gets no marker: we can't know its first job was in the input.
 * The exception is a complete height (historical view of one height): its first template is the first job on it.
 *
 * Pure TypeScript, unit-tested in lib/__tests__/blockMarkers.test.ts.
 */

export interface MarkerInput {
  /** Plotted time, ms (the same timestamp the chart draws the bar at). */
  timestamp: number;
  height: number;
  prev_hash?: string;
}

export interface BlockMarker {
  /** The new template height (work on the block after the new tip). */
  height: number;
  /** Time of the first job on the new parent, ms. */
  timestamp: number;
}

/** Largest height increase that still counts as the next block (a missed block or two, not another chain). */
export const MAX_HEIGHT_STEP = 2;
/** Heights kept around the Bitcoin tip (mirrors the template buffer: 3 heights kept, at most tip + 2). */
const BELOW_TIP = 2;
const ABOVE_TIP = 2;

export interface BlockMarkerOptions {
  /** Bitcoin tip (highest stored block), when known: template heights outside [tip - 2, tip + 2] are ignored. */
  tipHeight?: number | null;
  /** The input is every template at this one height: mark its first template. */
  completeHeight?: number;
}

/** Block markers, oldest first. `points` must be in time order (oldest first). */
export function blockMarkers(points: readonly MarkerInput[], options: BlockMarkerOptions = {}): BlockMarker[] {
  const { tipHeight, completeHeight } = options;

  if (completeHeight !== undefined) {
    const first = points.find(p => p.height === completeHeight);
    return first ? [{ height: completeHeight, timestamp: first.timestamp }] : [];
  }

  const hasTip = tipHeight !== null && tipHeight !== undefined && Number.isInteger(tipHeight);
  const markers: BlockMarker[] = [];
  const seenParents = new Set<string>();
  let current: number | null = null;

  for (const p of points) {
    if (!p.prev_hash || !Number.isInteger(p.height) || p.height <= 0) continue;
    if (hasTip && (p.height < tipHeight - BELOW_TIP || p.height > tipHeight + ABOVE_TIP)) continue;
    const parent = p.prev_hash.toLowerCase();

    if (current === null) {
      current = p.height;
      seenParents.add(parent);
      continue;
    }
    if (p.height > current + MAX_HEIGHT_STEP) continue; // not the next Bitcoin block: another chain
    if (seenParents.has(parent)) continue;
    seenParents.add(parent);
    if (p.height > current) {
      markers.push({ height: p.height, timestamp: p.timestamp });
      current = p.height;
    }
  }
  return markers;
}

/** "HH:MM:SS.mmm" in UTC. */
export function formatUtcMillis(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}
