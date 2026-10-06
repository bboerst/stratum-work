import type { Scope } from '@/lib/templates/types';
import type { Template } from '@/lib/templates/types';

/** Latest template in `arr` (sorted by receivedAtMs) received at or before `t`. */
function currentAt(arr: readonly Template[], t: number): Template | undefined {
  let c: Template | undefined;
  for (const x of arr) {
    if (x.receivedAtMs <= t) c = x;
    else break;
  }
  return c;
}

/**
 * Compare a pool's observe and work templates. Over the time both modes have a current
 * template, `identicalShare` is the fraction where both share prevHash and merkleBranches
 * (the coinbase always differs by account). null when either mode is missing.
 */
export function compareModes(templates: readonly Template[], pool: string, nowMs: number): {
  observe: Template[]; work: Template[]; identicalShare: number | null; overlapMs: number;
} {
  const mine = templates.filter(t => t.pool === pool).sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  const observe = mine.filter(t => t.mode === 'observe');
  const work = mine.filter(t => t.mode === 'work');
  if (!observe.length || !work.length) return { observe, work, identicalShare: null, overlapMs: 0 };
  const start = Math.max(observe[0].receivedAtMs, work[0].receivedAtMs);
  const cutSet = new Set<number>([start, nowMs]);
  for (const t of mine) if (t.receivedAtMs > start && t.receivedAtMs < nowMs) cutSet.add(t.receivedAtMs);
  const cuts = Array.from(cutSet).sort((a, b) => a - b);
  let same = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    if (cuts[i] >= nowMs) break;
    const o = currentAt(observe, cuts[i]);
    const w = currentAt(work, cuts[i]);
    if (o && w && o.prevHash === w.prevHash && o.merkleBranches.join() === w.merkleBranches.join()) {
      same += cuts[i + 1] - cuts[i];
    }
  }
  const overlapMs = Math.max(0, nowMs - start);
  return { observe, work, identicalShare: overlapMs ? same / overlapMs : null, overlapMs };
}

/** End of the comparison window: now for live; a range's end, capped at now, so overlap never runs past the range. */
export function observeEndMs(scope: Scope, nowMs: number): number {
  return scope.kind === 'range' ? Math.min(scope.toMs, nowMs) : nowMs;
}
