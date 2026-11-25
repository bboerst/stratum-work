/**
 * A block's winning template (#235, /api/block-template-matches): which stored templates carried exactly the block's
 * transaction set, proven by its merkle path (VERIFIED), and how closely each one's coinbase fits. Pure, unit-tested
 * in lib/__tests__/blockTemplateMatches.test.ts; the reads are lib/db/block-template-matches.ts.
 *
 * Per block, one state:
 *   verified      >= 1 stored template has exactly the block's merkle path: that job carried the block's transactions
 *   empty_block   the block has no transactions besides its coinbase: every empty template "matches", proving nothing
 *   no_match      no stored template has the block's transactions (a pool we don't collect, a job never sent to our
 *                 connections, or a collection gap); `closest` says how far the nearest set agreed
 *   unknown       the block's merkle path isn't stored yet (the backend fills it while the node has the block)
 * Per verified match, the coinbase:
 *   coinbase      the block's coinbase starts with the template's coinbase1 and ends with its coinbase2
 *   layout        the brackets differ (per-connection bytes) but the bytes between them are exactly the template's
 *                 extranonce length: this pool's coinbase layout
 *   merkle        the transaction set only (another pool can send the same set)
 *   null          the block's coinbase bytes aren't stored
 * A matching transaction set identifies the job's transactions, not who mined the block: every match is listed, next
 * to the block's own identification.
 */
import type { FirstLatencySql, MatchBlockSql, MatchRowSql } from './db/block-template-matches';
import { connectionLabel } from './parentKind';

export type MatchState = 'verified' | 'empty_block' | 'no_match' | 'unknown';
export type CoinbaseFit = 'coinbase' | 'layout' | 'merkle';

export interface TemplateMatch {
  pool: string;
  connection: string;            // 'a', 'b', … (the pool's connections by site and replica)
  first_us: string;              // the first template with this set on this connection, µs since the epoch
  lat_ms: number | null;         // that template's own latency estimate (null: none)
  lat_m: string | null;          // its method
  templates: number;             // templates with this set on this connection (re-sends included)
  coinbase: CoinbaseFit | null;
}

export interface BlockMatches {
  hash: string;
  pool: string | null;           // the block's own identification
  seen_ms: number | null;        // when the block reached our node (recorded from about 976,000)
  transactions_known: boolean;   // its merkle path is stored
  coinbase_known: boolean;
  state: MatchState;
  matches: TemplateMatch[];      // verified matches, by first receive time
  closest: { depth: number; transactions: number; pools: string[] } | null;   // no_match: the nearest sets
}

/** A match's first receive time in ms, minus its own connection's latency estimate when adjusted (and known). */
export function matchTimeMs(m: Pick<TemplateMatch, 'first_us' | 'lat_ms'>, adjusted: boolean): number {
  return Number(m.first_us) / 1000 - (adjusted && m.lat_ms !== null ? m.lat_ms : 0);
}

export function coinbaseFit(r: Pick<MatchRowSql, 'coinbase_prefix' | 'coinbase_suffix' | 'coinbase_layout'>, known: boolean): CoinbaseFit | null {
  if (!known || r.coinbase_prefix === null) return null;
  if (r.coinbase_prefix && r.coinbase_suffix) return 'coinbase';
  return r.coinbase_layout ? 'layout' : 'merkle';
}

export function blockMatches(blocks: readonly MatchBlockSql[], rows: readonly MatchRowSql[], latencies: readonly FirstLatencySql[]): BlockMatches[] {
  const lat = new Map(latencies.map(l => [`${l.source_id}:${l.at_us}`, l]));
  return blocks.map(b => {
    const mine = rows.filter(r => r.block_hash === b.block_hash);
    const base = { hash: b.block_hash, pool: b.pool, seen_ms: b.seen_ms === null ? null : Number(b.seen_ms),
      transactions_known: b.branches !== null, coinbase_known: b.coinbase_known };
    if (b.branches === null) return { ...base, state: 'unknown' as const, matches: [], closest: null };
    if (b.branches === 0) return { ...base, state: 'empty_block' as const, matches: [], closest: null };
    const full = mine.filter(r => r.full_match && r.branches === b.branches);
    if (full.length > 0) {
      const matches = full.map(r => {
        const l = lat.get(`${r.source_id}:${r.first_us}`);
        return { pool: r.pool, connection: connectionLabel(r.conn), first_us: r.first_us, lat_ms: l?.latency_ms ?? null,
          lat_m: l?.latency_method ?? null, templates: Number(r.n_rows), coinbase: coinbaseFit(r, b.coinbase_known) };
      }).sort((x, y) => Number(x.first_us) - Number(y.first_us) || x.pool.localeCompare(y.pool) || x.connection.localeCompare(y.connection));
      return { ...base, state: 'verified' as const, matches, closest: null };
    }
    const depth = Math.max(0, ...mine.map(r => r.match_depth));
    const closest = depth > 0
      ? { depth, transactions: 2 ** depth - 1, pools: [...new Set(mine.filter(r => r.match_depth === depth).map(r => r.pool))].sort() }
      : null;
    return { ...base, state: 'no_match' as const, matches: [], closest };
  });
}

const FIT_RANK: Record<CoinbaseFit, number> = { coinbase: 3, layout: 2, merkle: 1 };

export interface PoolMatch {
  pool: string;
  first: TemplateMatch;          // the connection that had it first (by the shown time)
  t_ms: number;                  // its shown time: receive time, latency adjusted when `adjusted`
  connections: TemplateMatch[];  // every connection with the set, by shown time
  coinbase: CoinbaseFit | null;  // the best fit over its connections
  mixed: boolean;                // its connections' fits differ
}

/**
 * One row per pool: a pool's connections often each get the job (sometimes with different coinbase bytes), so the
 * matches are grouped by pool. The row's time is its earliest connection's, the fit the best of them; the rest stays
 * in `connections`. Pools by time.
 */
export function matchesByPool(matches: readonly TemplateMatch[], adjusted: boolean): PoolMatch[] {
  const by = new Map<string, { m: TemplateMatch; t: number }[]>();
  for (const m of matches) {
    const list = by.get(m.pool) ?? [];
    list.push({ m, t: matchTimeMs(m, adjusted) });
    by.set(m.pool, list);
  }
  return [...by.entries()].map(([pool, list]) => {
    list.sort((a, b) => a.t - b.t || a.m.connection.localeCompare(b.m.connection));
    const fits = list.map(x => x.m.coinbase);
    const known = fits.filter((f): f is CoinbaseFit => f !== null);
    const coinbase = known.length ? known.reduce((a, b) => (FIT_RANK[b] > FIT_RANK[a] ? b : a)) : null;
    return { pool, first: list[0].m, t_ms: list[0].t, connections: list.map(x => x.m), coinbase, mixed: new Set(fits).size > 1 };
  }).sort((a, b) => a.t_ms - b.t_ms || a.pool.localeCompare(b.pool));
}
