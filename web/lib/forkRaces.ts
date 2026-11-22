/**
 * The Forks page's rows and history strip (components/Forks.tsx), from the summary's episodes (lib/unknownParents.ts).
 *
 * A race is counted once per fork point, not once per block: a branch two blocks deep is one race. Two episodes are
 * joined only on a recorded fact: a recorded stale block whose parent is another episode's recorded stale block, or two
 * recorded stale blocks at one height with the same parent. Nothing is joined by heights or times alone, so a branch
 * block we never recorded (its parent unknown) stays a row of its own. Every other episode is a row of its own.
 * Pure: unit-tested in lib/__tests__/forkRaces.test.ts.
 */

export const EPOCH_BLOCKS = 2016;

/** What these functions read of an episode. */
export interface RaceEpisode {
  parent: string;
  height: number;
  heights?: number[];
  kind: string;
  first_ms: number;
  last_ms: number;
  invalid_coinbase: unknown | null;
  facts: { tip_at_first: number | null; stale_block?: { prev?: string | null } | null };
}

export interface RaceRow<E extends RaceEpisode = RaceEpisode> {
  key: string;                   // the first episode's parent
  episodes: E[];                 // by height, then first template
  heights: number[];             // every height its episodes claim, ascending
  kind: string;                  // the first episode's kind
  invalid: boolean;              // invalid work anywhere in it: an invalid parent or coinbase, or a finding on a race
  position: number;              // where it sits in Bitcoin time: the height being mined when it began
  first_ms: number;
  last_ms: number;
}

const RACE_KINDS = new Set(['stale', 'bitcoin_block']);
export const isRace = (kind: string) => RACE_KINDS.has(kind);
export const isInvalid = (e: RaceEpisode) => e.kind === 'invalid_parent' || e.kind === 'invalid_coinbase' || e.invalid_coinbase !== null;

/** Bitcoin time: our tip when the first template arrived, + 1. Another chain's own heights aren't ours. */
export function positionOf(e: RaceEpisode): number {
  return e.facts.tip_at_first === null ? e.height : e.facts.tip_at_first + 1;
}

/** The rows, newest first. */
export function raceRows<E extends RaceEpisode>(episodes: readonly E[]): RaceRow<E>[] {
  const recorded = new Map(episodes.filter(e => e.kind === 'stale').map(e => [e.parent, e]));
  const root = new Map<string, string>();
  const rootOf = (e: E): string => {
    const known = root.get(e.parent);
    if (known) return known;
    let r = e.parent;
    const prev = e.kind === 'stale' ? e.facts.stale_block?.prev ?? null : null;
    const up = prev ? recorded.get(prev) : undefined;
    if (up && up !== e) r = rootOf(up);
    else if (prev) {
      // a sibling at the same height with the same parent: the same fork point
      const sib = episodes.find(x => x !== e && x.kind === 'stale' && x.height === e.height && x.facts.stale_block?.prev === prev);
      if (sib && sib.parent < e.parent) r = rootOf(sib);
    }
    root.set(e.parent, r);
    return r;
  };
  const groups = new Map<string, E[]>();
  for (const e of episodes) {
    const r = e.kind === 'stale' ? rootOf(e) : e.parent;
    groups.set(r, [...(groups.get(r) ?? []), e]);
  }
  const rows: RaceRow<E>[] = [];
  for (const es of groups.values()) {
    es.sort((a, b) => a.height - b.height || a.first_ms - b.first_ms || (a.parent < b.parent ? -1 : 1));
    const heights = [...new Set(es.flatMap(e => (e.heights?.length ? e.heights : [e.height])))].sort((a, b) => a - b);
    rows.push({
      key: es[0].parent, episodes: es, heights, kind: es[0].kind, invalid: es.some(isInvalid),
      position: Math.min(...es.map(positionOf)),
      first_ms: Math.min(...es.map(e => e.first_ms)), last_ms: Math.max(...es.map(e => e.last_ms)),
    });
  }
  return rows.sort((a, b) => b.position - a.position || b.first_ms - a.first_ms);
}

/** The strip's columns: one per difficulty epoch from `from` to `to`, each with its rows (oldest at the bottom). */
export function stripColumns<E extends RaceEpisode>(rows: readonly RaceRow<E>[], from: number, to: number): { epoch: number; rows: RaceRow<E>[] }[] {
  const first = Math.floor(from / EPOCH_BLOCKS), last = Math.floor(to / EPOCH_BLOCKS);
  const cols = Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => ({ epoch: first + i, rows: [] as RaceRow<E>[] }));
  for (const r of [...rows].sort((a, b) => a.position - b.position || a.first_ms - b.first_ms)) {
    const c = cols[Math.floor(r.position / EPOCH_BLOCKS) - first];
    if (c) c.rows.push(r);
  }
  return cols;
}
