/**
 * One height's fork timeline as runs, for the Forks page (/api/forks/timeline): per pool, each change of parent, of
 * whether its work is invalid, or of whether its template is empty (no transactions), with the time it happened. A
 * pool that went back to the block before (our best block at height - 2: work at height - 1) gets a run on it, with
 * the status `previous`, so its run on the parent it left ends there instead of at its next template here. The browser gets runs only, never templates, so a list of
 * races costs a few KB per row (the height page's /api/analysis-data is megabytes per height).
 *
 * A template is marked invalid only where the backend's invalid-coinbase finding names its pool at that height, and
 * by that finding's rule (backend/analytics/invalid_coinbase_no_merkle.py): empty, and its coinbase pays more than the
 * subsidy, reassembled with the stored extranonce2 length or the one other length that parses.
 */
import { getFirstWork, getLaneEnds, getLaneFacts, getLaneReturns, getLaneTemplates, type LaneTemplateSql } from './db/fork-lanes';
import { getDrillBlocks } from './db/unknown-parents';
import { excludedAt, type RealtimeExclusion } from './poolBlacklist';
import { knownBlockHashes } from './db/postgres';
import { classifyPrevHashes, neverAppeared, unknownParentKinds, type LaneStatus } from './forkStatus';
import { parseCoinbase } from '../utils/coinbaseParser';
import type { ArrivalBlock } from './forkTimelineAxis';
import type { ParentKind } from './parentKind';

/** [ms after from_ms, index into parents, 1 when the work is invalid (a finding), 1 when the template is empty] */
export type LaneRun = [at: number, parent: number, invalid: 0 | 1, empty: 0 | 1];

/** A pool going back to the block before (lib/db/fork-lanes.ts getLaneReturns): the first template of the return. */
export interface LaneReturn { pool: string; at_us: string; empty: boolean }

export interface LaneParent {
  hash: string;                  // display order
  status: LaneStatus | null;     // null: no best block at height - 1 to compare with; 'previous': the block before
  kind: ParentKind | null;       // of an unknown parent, inferred
}

export interface ForkLanes {
  height: number;
  active: string | null;         // our best block at height - 1 (display order), what the parents are judged against
  from_ms: number;               // the first template
  last_ms: number;               // the last one, after from_ms
  parents: LaneParent[];
  // By first template. `end`: where the pool's last run ends, ms after from_ms: its first template for the next
  // height, or its own last one here when we saw none (silence isn't drawn as work).
  lanes: { pool: string; runs: LaneRun[]; end: number }[];
  blocks: ArrivalBlock[];        // the blocks we know at height - 1 and height
}

const MAX_EXTRANONCE2 = 16;      // the backend's EXTRANONCE2_LENGTHS: 0..16
const NULL_PREVOUT = '00'.repeat(32) + 'ffffffff';

/** What a template's coinbase pays, by the backend's reassembly rule; null when that can't be told. */
export function coinbaseTotal(cb1: string, en1: string, stored: number, cb2: string): number | null {
  const total = (length: number): number | null => {
    const parsed = parseCoinbase(cb1, en1, length, cb2);
    if (!parsed.ok || parsed.outputs.length === 0) return null;
    const prevout = parsed.fields.find(f => f.kind === 'prevout');
    const raw = cb1 + en1 + '00'.repeat(length) + cb2;
    if (!prevout || raw.slice(prevout.start * 2, prevout.end * 2).toLowerCase() !== NULL_PREVOUT) return null;
    return parsed.outputs.reduce((sum, o) => sum + o.value, 0);
  };
  const asStored = total(stored);
  if (asStored !== null) return asStored;
  const found: number[] = [];
  for (let n = 0; n <= MAX_EXTRANONCE2; n++) {
    if (n === stored) continue;
    const t = total(n);
    if (t !== null) found.push(t);
  }
  return found.length === 1 ? found[0] : null;
}

/** Whether a template is one the finding is about. `subsidies`: the finding's subsidy per pool it names. */
export function isInvalidWork(t: LaneTemplateSql, subsidies: ReadonlyMap<string, number>): boolean {
  const subsidy = subsidies.get(t.pool);
  if (!t.empty || subsidy === undefined || t.coinbase1 === null || t.coinbase2 === null) return false;
  const paid = coinbaseTotal(t.coinbase1, t.extranonce1 ?? '', Number(t.extranonce2_length ?? 0), t.coinbase2);
  return paid !== null && paid > subsidy;
}

/**
 * The templates (by time) as runs: a run starts where a pool's parent, invalidity or emptiness changes. No tolerances.
 * `returns` (by time): where pools went back to `before`, the block at height - 2; a return starts a run on it, which
 * the pool's next template here ends. A return before the pool's first template here isn't one, and is dropped.
 * `lastUs` (for the lanes' ends) and `last_ms` are the templates' only.
 */
export function buildRuns(
  rows: readonly LaneTemplateSql[], subsidies: ReadonlyMap<string, number>,
  returns: readonly LaneReturn[] = [], before: string | null = null,
): Pick<ForkLanes, 'from_ms' | 'last_ms' | 'lanes'> & { hashes: string[]; lastUs: Map<string, string> } {
  const hashes: string[] = [];
  const index = new Map<string, number>();
  const lanes = new Map<string, LaneRun[]>();
  const lastUs = new Map<string, string>();
  if (rows.length === 0) return { from_ms: 0, last_ms: 0, lanes: [], hashes, lastUs };
  const firstUs = Number(rows[0].at_us);
  const indexOf = (hash: string) => {
    let parent = index.get(hash);
    if (parent === undefined) {
      parent = hashes.length;
      hashes.push(hash);
      index.set(hash, parent);
    }
    return parent;
  };
  const add = (pool: string, atUs: number, parent: number, invalid: 0 | 1, empty: 0 | 1) => {
    const runs = lanes.get(pool)!;
    const last = runs.at(-1);
    if (!last || last[1] !== parent || last[2] !== invalid || last[3] !== empty) runs.push([(atUs - firstUs) / 1000, parent, invalid, empty]);
  };
  let r = 0;
  const backs = before === null ? [] : returns;
  const flushReturns = (untilUs: number) => {
    for (; r < backs.length && Number(backs[r].at_us) < untilUs; r++) {
      const b = backs[r];
      if (lanes.has(b.pool)) add(b.pool, Number(b.at_us), indexOf(before!), 0, b.empty ? 1 : 0);
    }
  };
  for (const t of rows) {
    const at = Number(t.at_us);
    flushReturns(at);
    const parent = indexOf(t.parent);
    if (!lanes.has(t.pool)) lanes.set(t.pool, []);
    add(t.pool, at, parent, isInvalidWork(t, subsidies) ? 1 : 0, t.empty ? 1 : 0);
    lastUs.set(t.pool, String(t.at_us));
  }
  flushReturns(Infinity);
  return {
    from_ms: firstUs / 1000,
    last_ms: (Number(rows[rows.length - 1].at_us) - firstUs) / 1000,
    lanes: [...lanes].map(([pool, runs]) => ({ pool, runs, end: (Number(lastUs.get(pool)) - firstUs) / 1000 })),
    hashes,
    lastUs,
  };
}

const unzip = (pairs: [string, string][]): [string[], string[]] => [pairs.map(p => p[0]), pairs.map(p => p[1])];

/**
 * The height's timeline. `span`: the receive times of the episodes at this height, which the read always covers.
 * A stale block that only the stale-block records know has no arrival time at our node (its time is when it was
 * first recorded), so it gets no seen time here and no arrival marker.
 */
export async function getForkLanes(
  height: number, span: { fromMs: number; toMs: number }, ex: RealtimeExclusion,
): Promise<ForkLanes> {
  // POOL_BLACKLIST is realtime-only: an excluded pool is left out of the reads of a height above our tip (the next
  // height's, while this one is the tip), and kept at or below it
  const excludePools = excludedAt(ex, height), excludeNext = excludedAt(ex, height + 1);
  // Independent reads go out together: each is a round trip to the database.
  const blocksRead = getDrillBlocks(height);
  blocksRead.catch(() => {});
  const facts = await getLaneFacts(height, span.fromMs, span.toMs);
  const subsidies = new Map<string, number>();
  for (const o of facts.offenders ?? []) {
    if (o.pool_name && typeof o.subsidy_sats === 'number' && !excludePools.includes(o.pool_name)) subsidies.set(o.pool_name, o.subsidy_sats);
  }
  // where pools went back to the block before: only with a stored best block at height - 2 (none: no read)
  const [rows, returns] = await Promise.all([
    getLaneTemplates(height, facts.t_from, facts.t_to, excludePools, [...subsidies.keys()]),
    facts.before ? getLaneReturns(height, facts.before, facts.t_from, facts.t_to, excludePools) : Promise.resolve([]),
  ]);
  const { hashes, lastUs, ...runs } = buildRuns(rows, subsidies, returns, facts.before);
  const blocks = await blocksRead;
  const unseen = (b: (typeof blocks)[number]) => !(b.seen && !b.stale_only);
  const [endRows, known, workRows] = await Promise.all([
    getLaneEnds(height, ...unzip([...lastUs].filter(([pool]) => !excludeNext.includes(pool))), span.toMs),
    facts.active ? knownBlockHashes(hashes) : Promise.resolve(null),
    // the next height's work on this height's blocks (the block that ended the race), where no arrival was recorded
    getFirstWork(height + 1, blocks.filter(b => b.height === height && unseen(b)).map(b => b.block_hash), runs.from_ms, span.toMs, excludeNext),
  ]);
  // first work on a block at height - 1: the earliest run on it
  const work = new Map(workRows.map(r => [r.hash, Number(r.at_us) / 1000]));
  hashes.forEach((hash, i) => {
    if (hash === facts.before) return;   // the block at height - 2: no marker here
    const at = Math.min(...runs.lanes.flatMap(l => l.runs.filter(r => r[1] === i).map(r => r[0])));
    if (Number.isFinite(at)) work.set(hash, runs.from_ms + at);
  });
  const ends = new Map(endRows.map(r => [r.pool, Number(r.end_us) / 1000 - runs.from_ms]));
  for (const lane of runs.lanes) lane.end = ends.get(lane.pool) ?? lane.end;

  const status = facts.active && known ? classifyPrevHashes(hashes, facts.active, known) : null;
  const hexBits = (bits: string | null) => (bits === null ? null : Number(bits).toString(16).padStart(8, '0'));
  const kinds = unknownParentKinds(status, rows.map(r => ({ prev_hash: r.parent, nbits: Number(r.nbits) })), height,
    hexBits(facts.bits_prev), hexBits(facts.bits_at));
  // the block before is known and not our best at height - 1, so classifyPrevHashes would call it stale
  const parents: LaneParent[] = hashes.map(hash => (hash === facts.before
    ? { hash, status: 'previous' as const, kind: null }
    : { hash, status: status?.[hash] ?? null, kind: kinds?.[hash] ?? null }));
  // an unrecorded block whose lanes show it never appeared (judged on the first kinds of all parents, then applied)
  const never = new Set(parents.filter(p => neverAppeared({ parents, lanes: runs.lanes }, p.hash)).map(p => p.hash));
  for (const p of parents) if (never.has(p.hash)) p.kind = 'never_appeared';
  return {
    height,
    active: facts.active,
    ...runs,
    parents,
    blocks: blocks.map(b => ({
      hash: b.block_hash, height: b.height, best: b.best, miner: b.miner ?? null,
      seen_ms: b.seen && !b.stale_only ? Number(b.arrival_ms) : null, stale_only: b.stale_only,
      work_ms: unseen(b) ? work.get(b.block_hash) ?? null : null,
    })),
  };
}
