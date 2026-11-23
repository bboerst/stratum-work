/**
 * One height's fork timeline as runs, for the Forks page (/api/forks/timeline): per pool, each change of parent, or
 * of whether its work is invalid, with the time it happened. The browser gets runs only, never templates, so a list of
 * races costs a few KB per row (the height page's /api/analysis-data is megabytes per height).
 *
 * A template is marked invalid only where the backend's invalid-coinbase finding names its pool at that height, and
 * by that finding's rule (backend/analytics/invalid_coinbase_no_merkle.py): empty, and its coinbase pays more than the
 * subsidy, reassembled with the stored extranonce2 length or the one other length that parses.
 */
import { followsDeployment } from './softForks';
import { getFirstWork, getLaneEnds, getLaneFacts, getLaneTemplates, type LaneTemplateSql } from './db/fork-lanes';
import { getDrillBlocks } from './db/unknown-parents';
import { knownBlockHashes } from './db/postgres';
import { classifyPrevHashes, unknownParentKinds, type PrevHashStatus } from './forkStatus';
import { parseCoinbase } from '../utils/coinbaseParser';
import type { ArrivalBlock } from './forkTimelineAxis';
import type { ParentKind } from './parentKind';

/** [ms after from_ms, index into parents, 1 when the work is invalid (a finding)] */
export type LaneRun = [at: number, parent: number, invalid: 0 | 1];

export interface LaneParent {
  hash: string;                  // display order
  status: PrevHashStatus | null; // null: no best block at height - 1 to compare with
  kind: ParentKind | null;       // of an unknown parent, inferred
  follows: string | null;        // the deployment its chain follows (lib/softForks.ts), e.g. 'BIP-110'
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

/** The templates (by time) as runs: a run starts where a pool's parent or invalidity changes. No tolerances. */
export function buildRuns(
  rows: readonly LaneTemplateSql[], subsidies: ReadonlyMap<string, number>,
): Pick<ForkLanes, 'from_ms' | 'last_ms' | 'lanes'> & { hashes: string[]; lastUs: Map<string, string> } {
  const hashes: string[] = [];
  const index = new Map<string, number>();
  const lanes = new Map<string, LaneRun[]>();
  const lastUs = new Map<string, string>();
  if (rows.length === 0) return { from_ms: 0, last_ms: 0, lanes: [], hashes, lastUs };
  const firstUs = Number(rows[0].at_us);
  for (const t of rows) {
    let parent = index.get(t.parent);
    if (parent === undefined) {
      parent = hashes.length;
      hashes.push(t.parent);
      index.set(t.parent, parent);
    }
    const invalid = isInvalidWork(t, subsidies) ? 1 : 0;
    const runs = lanes.get(t.pool) ?? [];
    const last = runs.at(-1);
    if (!last || last[1] !== parent || last[2] !== invalid) runs.push([(Number(t.at_us) - firstUs) / 1000, parent, invalid]);
    lanes.set(t.pool, runs);
    lastUs.set(t.pool, String(t.at_us));
  }
  return {
    from_ms: firstUs / 1000,
    last_ms: (Number(rows[rows.length - 1].at_us) - firstUs) / 1000,
    lanes: [...lanes].map(([pool, runs]) => ({ pool, runs, end: (Number(lastUs.get(pool)) - firstUs) / 1000 })),
    hashes,
    lastUs,
  };
}

/**
 * The height's timeline. `span`: the receive times of the episodes at this height, which the read always covers.
 * A stale block that only the stale-block records know has no arrival time at our node (its time is when it was
 * first recorded), so it gets no seen time here and no arrival marker.
 */
export async function getForkLanes(
  height: number, span: { fromMs: number; toMs: number }, excludePools: string[],
): Promise<ForkLanes> {
  // Independent reads go out together: each is a round trip to the database.
  const blocksRead = getDrillBlocks(height);
  blocksRead.catch(() => {});
  const facts = await getLaneFacts(height, span.fromMs, span.toMs);
  const subsidies = new Map<string, number>();
  for (const o of facts.offenders ?? []) {
    if (o.pool_name && typeof o.subsidy_sats === 'number' && !excludePools.includes(o.pool_name)) subsidies.set(o.pool_name, o.subsidy_sats);
  }
  const rows = await getLaneTemplates(height, facts.t_from, facts.t_to, excludePools, [...subsidies.keys()]);
  const { hashes, lastUs, ...runs } = buildRuns(rows, subsidies);
  const versionsOf = new Map<string, number[]>();
  for (const r of rows) {
    if (!versionsOf.has(r.parent)) versionsOf.set(r.parent, []);
    versionsOf.get(r.parent)!.push(Number(r.version));
  }
  const blocks = await blocksRead;
  const unseen = (b: (typeof blocks)[number]) => !(b.seen && !b.stale_only);
  const [endRows, known, workRows] = await Promise.all([
    getLaneEnds(height, [...lastUs.keys()], [...lastUs.values()], span.toMs),
    facts.active ? knownBlockHashes(hashes) : Promise.resolve(null),
    // the next height's work on this height's blocks (the block that ended the race), where no arrival was recorded
    getFirstWork(height + 1, blocks.filter(b => b.height === height && unseen(b)).map(b => b.block_hash), runs.from_ms, span.toMs, excludePools),
  ]);
  // first work on a block at height - 1: the earliest run on it
  const work = new Map(workRows.map(r => [r.hash, Number(r.at_us) / 1000]));
  hashes.forEach((hash, i) => {
    const at = Math.min(...runs.lanes.flatMap(l => l.runs.filter(r => r[1] === i).map(r => r[0])));
    if (Number.isFinite(at)) work.set(hash, runs.from_ms + at);
  });
  const ends = new Map(endRows.map(r => [r.pool, Number(r.end_us) / 1000 - runs.from_ms]));
  for (const lane of runs.lanes) lane.end = ends.get(lane.pool) ?? lane.end;

  const status = facts.active && known ? classifyPrevHashes(hashes, facts.active, known) : null;
  const hexBits = (bits: string | null) => (bits === null ? null : Number(bits).toString(16).padStart(8, '0'));
  const kinds = unknownParentKinds(status, rows.map(r => ({ prev_hash: r.parent, nbits: Number(r.nbits) })), height,
    hexBits(facts.bits_prev), hexBits(facts.bits_at));
  return {
    height,
    active: facts.active,
    ...runs,
    parents: hashes.map(hash => ({
      hash, status: status?.[hash] ?? null, kind: kinds?.[hash] ?? null,
      follows: followsDeployment(height, hash === facts.active,
        facts.active_version === null ? null : Number(facts.active_version), versionsOf.get(hash) ?? [])?.name ?? null,
    })),
    blocks: blocks.map(b => ({
      hash: b.block_hash, height: b.height, best: b.best, miner: b.miner ?? null,
      seen_ms: b.seen && !b.stale_only ? Number(b.arrival_ms) : null, stale_only: b.stale_only,
      work_ms: unseen(b) ? work.get(b.block_hash) ?? null : null,
    })),
  };
}
