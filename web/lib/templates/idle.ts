type Deadline = { timeRemaining(): number };
type Idle = (cb: (d: Deadline) => void) => void;

const defaultIdle: Idle = cb => {
  const ric = (globalThis as { requestIdleCallback?: (cb: (d: Deadline) => void) => void }).requestIdleCallback;
  if (ric) ric(cb);
  else setTimeout(() => { const end = Date.now() + 8; cb({ timeRemaining: () => Math.max(0, end - Date.now()) }); }, 0);
};

const MAX_BATCH = 1024;

/**
 * Feed `items` to `fn` in batches, yielding to the browser between idle slices.
 * Batch size adapts (starts at 1, doubles while batches are cheap, halves when one overruns)
 * so each `fn` call stays within roughly `sliceMs`.
 */
export function runIdleChunks<T>(items: T[], fn: (batch: T[]) => void, opts: { sliceMs?: number; idle?: Idle } = {}): Promise<void> {
  const sliceMs = opts.sliceMs ?? 8, idle = opts.idle ?? defaultIdle;
  let i = 0, size = 1;
  return new Promise((resolve, reject) => {
    if (!items.length) { resolve(); return; }
    const step = (d: Deadline) => {
      try {
        const end = performance.now() + Math.min(sliceMs, Math.max(1, d.timeRemaining()));
        do {
          const t0 = performance.now();
          fn(items.slice(i, i + size));
          i += size;
          const took = performance.now() - t0;
          if (took < sliceMs / 2) size = Math.min(size * 2, MAX_BATCH);
          else if (took > sliceMs) size = Math.max(1, Math.floor(size / 2));
        } while (i < items.length && performance.now() < end && d.timeRemaining() > 0);
      } catch (e) { reject(e); return; }
      if (i < items.length) idle(step); else resolve();
    };
    idle(step);
  });
}
