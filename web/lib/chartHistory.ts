/**
 * Time-window trimming for the realtime timing chart (#143).
 *
 * Each pool's bars run from one template to the next, and the last bar runs from the pool's latest template to "now"
 * (the chart's right edge). To scroll bars smoothly off the left edge, a pool's history must keep the point just
 * before the window's left edge (the cutoff) as well as everything inside the window, including when NOTHING is inside
 * the window: a quiet pool's latest template is still the bar spanning the whole chart. Dropping it left an empty row.
 *
 * A pool whose latest template is older than `staleBeforeMs` (by default 10 windows ago) is treated as gone (e.g. its
 * collector disconnected), so a dead pool doesn't show a bar forever.
 */
export interface TimedPoint {
  timestamp: number;
}

/**
 * The part of one pool's history (sorted oldest first) the chart needs: the last point before `cutoffMs` plus every
 * point at or after it. Returns [] when the history is empty or its newest point is older than `staleBeforeMs`.
 */
export function windowedHistory<T extends TimedPoint>(history: T[], cutoffMs: number, staleBeforeMs = -Infinity): T[] {
  if (history.length === 0) return [];
  if (history[history.length - 1].timestamp < staleBeforeMs) return [];
  const firstInWindowIdx = history.findIndex(point => point.timestamp >= cutoffMs);
  const startIdx = firstInWindowIdx === -1 ? history.length - 1 : Math.max(0, firstInWindowIdx - 1);
  return history.slice(startIdx);
}

/** How many window lengths a pool may stay silent before its bar is dropped. */
export const STALE_AFTER_WINDOWS = 10;

/** Cutoff below which a pool with no newer template is considered gone: `now - STALE_AFTER_WINDOWS × window`. */
export function staleBefore(nowMs: number, windowMs: number): number {
  return nowMs - STALE_AFTER_WINDOWS * windowMs;
}

/**
 * Change-tracking primers for a chart rebuild (#143 follow-up).
 *
 * Bar colors come from comparing each template with the previous template from the same pool. When the chart
 * rebuilds from the shared buffer (mount, view switch, window change) it plots only the window, so each pool's
 * first plotted template would have nothing to compare with and render gray, while a page refresh happened to
 * process the whole buffer and colored it. These are the templates to feed the change tracker first (not to plot):
 * for each pool, the buffered entry immediately before that pool's earliest plotted entry. Oldest first.
 */
export function changeTrackerPrimers<T extends { seq: number; timeMs: number; data: { pool_name?: string | null } }>(
  all: T[],
  plotted: T[],
  /** The order change detection uses (each template's own receive time); defaults to `timeMs`. */
  orderMs: (entry: T) => number = entry => entry.timeMs,
): T[] {
  const before = (x: T, y: T) => orderMs(x) < orderMs(y) || (orderMs(x) === orderMs(y) && x.seq < y.seq);
  const firstPlotted = new Map<string, T>();
  for (const entry of plotted) {
    const pool = entry.data.pool_name ?? '';
    const current = firstPlotted.get(pool);
    if (!current || before(entry, current)) firstPlotted.set(pool, entry);
  }
  const primer = new Map<string, T>();
  for (const entry of all) {
    const pool = entry.data.pool_name ?? '';
    const first = firstPlotted.get(pool);
    if (!first || entry === first || !before(entry, first)) continue;
    const best = primer.get(pool);
    if (!best || before(best, entry)) primer.set(pool, entry);
  }
  return [...primer.values()].sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
}
