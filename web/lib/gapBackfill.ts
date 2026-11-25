/**
 * Filling in gaps from history (TemplateBuffer.gapBefore): after a gap (the pre-fill/stream seam, a pause, a reconnect,
 * a throttled burst) the page reads history again, and a read that has both sides of a gap proves nothing was missed
 * there and adds whatever was. Pure TypeScript with injectable timers, unit-tested in lib/__tests__/gapBackfill.test.ts.
 *
 * Timing (measured on dev 2026-11-25): a template was in a history read at most 7 s after it arrived on the stream (the
 * database is about a second behind; the pre-fill response is shared for 5 s). So the first read comes 8 s after the
 * first gap, then again at 20 s and 45 s while gaps remain. A pending read is never pushed back by new gaps (at page
 * load every pool's first live template is one, spread over half a minute), and reads are at least MIN_INTERVAL_MS
 * apart, so a pool that keeps bursting costs one read per MIN_INTERVAL_MS at most. The shared response bounds the
 * database to one query per 5 s however many viewers read.
 */
export const BACKFILL_DELAYS_MS = [8_000, 20_000, 45_000];
export const BACKFILL_MIN_INTERVAL_MS = 10_000;
const JITTER_MS = 2_000;

export interface GapBackfillDeps {
  /** Reads history into the buffer (and publishes it). */
  read: () => Promise<void>;
  /** Gaps a read might still fill (recent ones). */
  pending: () => number;
  /** Bumped whenever a gap appears (TemplateBuffer.gapVersion). */
  gapVersion: () => number;
  /** False while paused or hidden: nothing is shown, and the next gap after resuming starts over. */
  canRun: () => boolean;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class GapBackfill {
  private timer: unknown = null;
  private tries = 0;
  private seen = 0;
  private lastReadAt = -Infinity;
  private disposed = false;
  private readonly d: Required<GapBackfillDeps>;

  constructor(deps: GapBackfillDeps) {
    this.d = {
      now: () => Date.now(),
      random: Math.random,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: t => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...deps,
    };
  }

  /** Call after the buffer changes: starts reading if a new gap appeared and no read is pending. */
  notify(): void {
    const v = this.d.gapVersion();
    if (this.disposed || v === this.seen) return;
    this.seen = v;
    if (this.timer !== null) return; // keep the pending read where it is
    this.tries = 0;
    this.arm(BACKFILL_DELAYS_MS[0]);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
  }

  private arm(delayMs: number): void {
    const at = Math.max(this.d.now() + delayMs + this.d.random() * JITTER_MS, this.lastReadAt + BACKFILL_MIN_INTERVAL_MS);
    this.timer = this.d.setTimer(() => void this.run(), at - this.d.now());
  }

  private async run(): Promise<void> {
    this.timer = null;
    if (this.disposed) return;
    if (!this.d.canRun()) {
      this.seen = -1; // re-armed by the next notify after resuming
      return;
    }
    if (this.d.pending() === 0) return;
    this.tries++;
    this.lastReadAt = this.d.now();
    try {
      await this.d.read();
    } catch (error) {
      console.error('Error re-reading history to fill a gap', error);
    }
    if (this.disposed) return;
    // Gaps the read itself leaves (older than it covers) aren't filled by reading again: only newer ones re-arm.
    this.seen = this.d.gapVersion();
    if (this.timer === null && this.tries < BACKFILL_DELAYS_MS.length && this.d.pending() > 0) {
      this.arm(BACKFILL_DELAYS_MS[this.tries] - BACKFILL_DELAYS_MS[this.tries - 1]);
    }
  }
}
