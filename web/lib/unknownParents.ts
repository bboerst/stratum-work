/**
 * /api/forks (alias /api/unknown-parents): episodes assembled from the per-(parent, pool) rows and their facts (kind inferred by
 * lib/parentKind.ts), and the drill-in's template rows.
 *
 * Template rows: the MiningNotify shape (pg-mapping), extranonce1 masked (connectionMask, #105),
 * plus fields decoded on the server so the browser only renders them (client performance principle): the coinbase
 * scriptSig's height, text tags and merge-mining (AuxPoW) commitment, and the outputs. Server-only (connectionMask).
 *
 * Other chains' coinbases needn't be Bitcoin transactions: parseCoinbase never throws and keeps what it could parse.
 * Output addresses are in Bitcoin's encoding (the same script on another chain has another address format).
 */
import { maskTemplate } from './connectionMask';
import { templateRowToMiningNotify } from './db/pg-mapping';
import {
  DEFAULT_RANGE, DRILL_MARGIN_MS, RANGE_BLOCKS, getDrillRows, getEpisodeFacts, getEpisodePoolRows, getInvalidCoinbaseFlags,
  getStaleEpisodePoolRows, type DrillTemplateRow, type EpisodeFactsSql, type EpisodePoolSql, type InvalidCoinbaseFlagSql,
  type ParentLabel, type UnknownParentsRange,
} from './db/unknown-parents';
import {
  NEAR_TIP, bitcoinDifficulty, connectionLabel, parentKind, parentPowOk, tipOffset, type ParentKind,
} from './parentKind';
import { parseCoinbase, coinbaseTagText } from '../utils/coinbaseParser';
import { addressFromScript } from '../utils/addressFromScript';
import { decodeOpReturnScript } from '../utils/mergeMining';
import { reverseHex } from '../utils/formatters';

export interface UnknownParentOutput {
  value: number;                 // satoshis (the other chain's base unit)
  address?: string;              // Bitcoin encoding of a standard script
  protocol?: string;             // OP_RETURN protocol, when recognised
  script_hex: string;
}

export interface UnknownParentTemplate {
  id: string;
  pool_name: string;
  parent: ParentLabel;           // the parent this template built on: this episode's, a best / stale block, another
  connections: string[];         // the pool's connections that received it (a, b, …)
  height: number;                // as reported (the BIP34 push the collector parsed, or 0 when it couldn't)
  received_at: number;           // ms since the epoch (this row's own receive time)
  received_us: string;           // the same in µs: the page cursor
  copies: number;                // connections that saw this exact template (de-duplicated reads)
  prev_hash: string;             // display order
  version: string;
  nbits: string;
  ntime: string;
  clean_jobs: boolean;
  extranonce1: string;           // masked
  extranonce2_length: number;
  merkle_branches: number;       // count
  coinbase1: string;
  coinbase2: string;
  coinbase_ok: boolean;          // parsed as a transaction to the end
  coinbase_error?: string;
  scriptsig_height: number | null;
  coinbase_tags: string;         // printable text in the scriptSig (no height, AuxPoW or extranonce bytes)
  auxpow: boolean;
  auxpow_root: string | null;
  auxpow_merkle_size: number | null;
  outputs: UnknownParentOutput[];
  output_total: number;
}

const MAX_OUTPUTS_SHOWN = 20;

export function toUnknownParentTemplate(row: DrillTemplateRow): UnknownParentTemplate {
  const t = maskTemplate(templateRowToMiningNotify(row));
  const parsed = parseCoinbase(t.coinbase1, t.extranonce1, t.extranonce2_length, t.coinbase2, { ntime: parseInt(t.ntime, 16) });
  const bytes = Buffer.from(t.coinbase1 + t.extranonce1 + '00'.repeat(t.extranonce2_length) + t.coinbase2, 'hex');
  const outputs = parsed.outputs.slice(0, MAX_OUTPUTS_SHOWN).map(o => {
    const script = bytes.subarray(o.script.start, o.script.end);
    const out: UnknownParentOutput = { value: o.value, script_hex: script.toString('hex') };
    const address = addressFromScript(script);
    if (address) out.address = address;
    else {
      const op = decodeOpReturnScript(Uint8Array.from(script));
      if (op) out.protocol = op.protocol;
    }
    return out;
  });
  const aux = parsed.scriptSig?.auxpow ?? null;
  // The SQL summary's rule (magic anywhere in coinbase1 or coinbase2), so the flag matches the AuxPoW share.
  const auxpow = t.coinbase1.includes('fabe6d6d') || t.coinbase2.includes('fabe6d6d') || aux !== null;
  return {
    id: t.id, pool_name: row.source_name, parent: row.parent_label,
    connections: [...(row.conns ?? [])].sort((x, y) => x - y).map(connectionLabel), height: t.height,
    received_at: Math.floor(Number(row.received_us) / 1000), received_us: String(row.received_us),
    copies: Number(row.copies ?? 1),
    prev_hash: reverseHex(t.prev_hash), version: t.version, nbits: t.nbits, ntime: t.ntime, clean_jobs: t.clean_jobs,
    extranonce1: t.extranonce1 ?? '', extranonce2_length: t.extranonce2_length, merkle_branches: t.merkle_branches.length,
    coinbase1: t.coinbase1, coinbase2: t.coinbase2,
    coinbase_ok: parsed.ok, ...(parsed.error ? { coinbase_error: parsed.error } : {}),
    scriptsig_height: parsed.scriptSig?.height ?? null,
    coinbase_tags: parsed.scriptSig ? coinbaseTagText(parsed) : '',
    auxpow, auxpow_root: aux?.root ?? null, auxpow_merkle_size: aux?.merkleSize ?? null,
    outputs, output_total: parsed.outputs.reduce((s, o) => s + o.value, 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Episodes

export interface EpisodePool {
  pool: string;
  connections: string[];         // a, b, …: which of the pool's connections built on the parent
  templates: number;
}

export interface EpisodeFacts {
  tip_at_first: number | null;   // our best-chain tip when the first template arrived
  tip_at_last: number | null;    // ... when the last one did (with tip_at_first: the episode's place in Bitcoin time)
  tip_offset: number | null;     // height - 1 - tip_at_first
  nbits: string[];               // the templates' nbits (hex), most common first
  bitcoin_bits: string | null;   // Bitcoin's bits at height - 1 (hex), null when no block is stored there
  bitcoin_bits_at: string | null;  // ... at height (consulted at a retarget height)
  bitcoin_difficulty: boolean | null;  // the templates' nbits are Bitcoin's there (null: nothing to compare with)
  pow_ok: boolean;               // the parent meets the target of pow_bits
  pow_bits: string;              // the bits the PoW was checked against: Bitcoin's at height - 1, else the templates'
  in_stale_blocks: boolean;      // the parent is a recorded stale block (stale now)
  stale_block: StaleBlockFacts | null;   // ... and what we recorded of it
}

export interface StaleBlockFacts {
  height: number;
  header_source: string | null;  // how its header reached us (stale_blocks.header_source)
  miner: string | null;          // the pool that mined it, when identified (stale_blocks.mining_pool.name)
}

/**
 * The invalid_coinbase_no_merkle finding of our best block at the episode's height: templates there whose coinbase paid
 * more than the subsidy with no transactions to pay fees from. Per pool (the finding lists one entry per template).
 */
export interface InvalidCoinbase {
  height: number;
  pools: { pool: string; templates: number; total_sats: number; subsidy_sats: number | null }[];
}

/**
 * An episode's kind: 'stale' when the parent is a recorded stale block (a fact), otherwise the kind lib/parentKind.ts
 * infers for an unknown parent; 'invalid_coinbase' for a height whose only finding is invalid coinbases (no other
 * parent there).
 */
export type EpisodeKind = 'stale' | ParentKind | 'invalid_coinbase';
export const EPISODE_KINDS: readonly EpisodeKind[] =
  ['stale', 'bitcoin_block', 'other_chain', 'invalid_parent', 'invalid_coinbase', 'undetermined'];

export interface Episode {
  parent: string;                // the parent (a block other than our best one), display-order hex; for an
                                 // 'invalid_coinbase' row our best block at height - 1
  height: number;                // the templates' height (the most common one), so the parent is at height - 1
  heights: number[];             // every height its templates gave, ascending
  pools: EpisodePool[];          // by first template
  first_ms: number;
  last_ms: number;
  duration_ms: number;
  templates: number;             // de-duplicated (exact copies across a pool's connections count once)
  auxpow_templates: number | null;   // null: not read (a stale parent's templates are read without their coinbases)
  auxpow_share: number | null;   // 0..1
  facts: EpisodeFacts;
  kind: EpisodeKind;             // 'stale' recorded; otherwise INFERRED from the facts (lib/parentKind.ts)
  invalid_coinbase: InvalidCoinbase | null;
}

/** An episode before its facts are read. */
export type EpisodeDraft = Omit<Episode, 'facts' | 'kind' | 'invalid_coinbase'> & { nbitsCounts: Map<number, number> };

const hex32 = (n: number) => n.toString(16).padStart(8, '0');

/** The most common key; ties go to the lowest, so the choice is deterministic. */
export function modeOf(counts: Map<number, number>): number {
  let best: number | null = null, bestN = -1;
  for (const [k, n] of counts) if (n > bestN || (n === bestN && best !== null && k < best)) { best = k; bestN = n; }
  return best ?? 0;
}

/** Group the per-(parent, pool) rows into episodes (one per parent), ordered by first template. */
export function draftEpisodes(rows: EpisodePoolSql[]): EpisodeDraft[] {
  const byParent = new Map<string, EpisodePoolSql[]>();
  for (const r of rows) byParent.set(r.parent, [...(byParent.get(r.parent) ?? []), r]);
  const add = (m: Map<number, number>, obj: Record<string, string | number> | null) => {
    for (const [k, v] of Object.entries(obj ?? {})) m.set(Number(k), (m.get(Number(k)) ?? 0) + Number(v));
  };
  const out: EpisodeDraft[] = [];
  for (const [parent, rs] of byParent) {
    const heights = new Map<number, number>(), nbits = new Map<number, number>();
    let templates = 0, aux: number | null = 0, first = Infinity, last = -Infinity;
    const pools: (EpisodePool & { first: number })[] = [];
    for (const r of rs) {
      add(heights, r.heights);
      add(nbits, r.nbits);
      const n = Number(r.n), f = Number(r.first_ms), l = Number(r.last_ms);
      templates += n;
      aux = aux === null || r.auxpow === null ? null : aux + Number(r.auxpow);
      first = Math.min(first, f);
      last = Math.max(last, l);
      const conns = [...(r.conns ?? [])].sort((a, b) => a - b).map(connectionLabel);
      pools.push({ pool: r.pool, connections: conns, templates: n, first: f });
    }
    pools.sort((a, b) => a.first - b.first || (a.pool < b.pool ? -1 : 1));
    out.push({
      parent, height: modeOf(heights), heights: [...heights.keys()].sort((a, b) => a - b),
      pools: pools.map(p => ({ pool: p.pool, connections: p.connections, templates: p.templates })),
      first_ms: first, last_ms: last, duration_ms: last - first, templates,
      auxpow_templates: aux, auxpow_share: aux === null ? null : templates ? aux / templates : 0, nbitsCounts: nbits,
    });
  }
  return out.sort((a, b) => a.first_ms - b.first_ms || (a.parent < b.parent ? -1 : 1));
}

/**
 * The range's episodes: the rows per parent and pool, of unknown parents (getEpisodePoolRows) and of stale ones
 * (getStaleEpisodePoolRows; the two sets of parents are disjoint: an unknown parent is in no block table), then the
 * facts per episode, then the invalid-coinbase findings (withInvalidCoinbase).
 */
export async function getEpisodes(excludePools: string[], range: UnknownParentsRange = DEFAULT_RANGE): Promise<Episode[]> {
  const [unknown, stale, flags] = await Promise.all([
    getEpisodePoolRows(excludePools, range), getStaleEpisodePoolRows(excludePools, range), getInvalidCoinbaseFlags(),
  ]);
  const drafts = draftEpisodes([...unknown, ...stale]);
  const facts = await getEpisodeFacts(drafts.map(d => ({ parent: d.parent, height: d.height, first_ms: d.first_ms, last_ms: d.last_ms })));
  return withInvalidCoinbase(finishEpisodes(drafts, facts), flags, excludePools, RANGE_BLOCKS[range]);
}

/** A finding's offenders per pool, without the excluded pools (null when none is left). */
export function invalidCoinbaseOf(flag: InvalidCoinbaseFlagSql, excludePools: string[]): InvalidCoinbase | null {
  const by = new Map<string, InvalidCoinbase['pools'][number]>();
  for (const o of flag.offenders ?? []) {
    const pool = o.pool_name || 'Unknown';
    if (excludePools.includes(pool)) continue;
    const p = by.get(pool) ?? { pool, templates: 0, total_sats: 0, subsidy_sats: null };
    p.templates++;
    p.total_sats = Math.max(p.total_sats, Number(o.total_sats ?? 0));
    if (typeof o.subsidy_sats === 'number') p.subsidy_sats = o.subsidy_sats;
    by.set(pool, p);
  }
  if (by.size === 0) return null;
  return { height: flag.height, pools: [...by.values()].sort((a, b) => b.templates - a.templates || (a.pool < b.pool ? -1 : 1)) };
}

/**
 * Attach each invalid-coinbase finding to the episodes at its height that were at our tip then (|tip offset| <=
 * NEAR_TIP, and not another chain's: a foreign height can pass through a Bitcoin one). A finding with no such episode
 * becomes its own 'invalid_coinbase' row (when its height is in the range: above tip - rangeBlocks), keyed by our best
 * block at height - 1 and timed from its arrival to the flagged block's, so nothing the findings list shows is lost.
 */
export function withInvalidCoinbase(
  episodes: Episode[], flags: InvalidCoinbaseFlagSql[], excludePools: string[], rangeBlocks: number | null,
): Episode[] {
  const out = episodes.map(e => ({ ...e, invalid_coinbase: e.invalid_coinbase ?? null }));
  const extra: Episode[] = [];
  for (const flag of flags) {
    const ic = invalidCoinbaseOf(flag, excludePools);
    if (!ic) continue;
    const at = out.filter(e => e.height === flag.height && e.kind !== 'other_chain'
      && e.facts.tip_offset !== null && Math.abs(e.facts.tip_offset) <= NEAR_TIP);
    for (const e of at) e.invalid_coinbase = ic;
    if (at.length > 0) continue;
    const tip = flag.tip === null ? null : Number(flag.tip);
    if (rangeBlocks !== null && (tip === null || flag.height <= tip - rangeBlocks)) continue;
    const parent = flag.parent ?? '';
    if (!parent || out.some(e => e.parent === parent) || extra.some(e => e.parent === parent)) continue;
    const last = Number(flag.arrival_ms);
    const first = flag.parent_arrival_ms === null ? last : Math.min(last, Number(flag.parent_arrival_ms));
    const templates = ic.pools.reduce((n, p) => n + p.templates, 0);
    extra.push({
      parent, height: flag.height, heights: [flag.height],
      pools: ic.pools.map(p => ({ pool: p.pool, connections: [], templates: p.templates })),
      first_ms: first, last_ms: last, duration_ms: last - first, templates, auxpow_templates: null, auxpow_share: null,
      facts: {
        tip_at_first: flag.height - 1, tip_at_last: flag.height - 1, tip_offset: 0, nbits: [], bitcoin_bits: null,
        bitcoin_bits_at: null, bitcoin_difficulty: null, pow_ok: true, pow_bits: '', in_stale_blocks: false, stale_block: null,
      },
      kind: 'invalid_coinbase', invalid_coinbase: ic,
    });
  }
  return [...out, ...extra].sort((a, b) => a.first_ms - b.first_ms || (a.parent < b.parent ? -1 : 1));
}

export interface DrillBlock {
  hash: string;                  // display hex
  height: number;
  arrival_ms: number;            // when it reached us: coalesce(seen_at, block_time), or first seen as stale
  best: boolean;                 // on our best chain (else: a block we know that isn't)
}

export interface Drill {
  from_ms: number;               // the receive-time range read: the episode ± DRILL_MARGIN_MS
  to_ms: number;
  templates: UnknownParentTemplate[];   // earliest first
  truncated: boolean;            // more than DRILL_MAX_TEMPLATES in the range: the first ones are shown
  clipped: boolean;              // the episode lasted longer than DRILL_MAX_SPAN_MS: only its start is read
  blocks: DrillBlock[];          // every block we know at height - 1 and height
}

/** One episode's drill-in: its pools' templates at height - 1 .. height + 1 around its receive times, and the blocks. */
// A long episode (a feed stuck on one parent for hours) would read hours of every pool's templates: read its start only.
export const DRILL_MAX_SPAN_MS = 30 * 60_000;

export async function getDrill(e: Episode, excludePools: string[]): Promise<Drill> {
  const clipped = e.last_ms - e.first_ms > DRILL_MAX_SPAN_MS;
  const from_ms = e.first_ms - DRILL_MARGIN_MS;
  const to_ms = (clipped ? e.first_ms + DRILL_MAX_SPAN_MS : e.last_ms) + DRILL_MARGIN_MS;
  // an invalid-coinbase row's key is our best block: its templates are labelled 'best', not 'this'
  const parent = e.kind === 'invalid_coinbase' ? '' : e.parent;
  const rows = await getDrillRows(
    { parent, height: e.height, pools: e.pools.map(p => p.pool), from_ms, to_ms }, excludePools);
  return {
    from_ms, to_ms, truncated: rows.truncated, clipped,
    templates: rows.templates.map(toUnknownParentTemplate),
    blocks: rows.blocks.map(b => ({ hash: b.block_hash, height: b.height, arrival_ms: Number(b.arrival_ms), best: b.best })),
  };
}

/** Attach the facts (getEpisodeFacts rows, in the drafts' order) and the kind: 'stale' when recorded, else inferred. */
export function finishEpisodes(drafts: EpisodeDraft[], facts: EpisodeFactsSql[]): Episode[] {
  return drafts.map((d, i) => {
    const f = facts[i];
    const nbitsMain = modeOf(d.nbitsCounts);
    const prev = f?.bits_prev == null ? null : Number(f.bits_prev);
    const at = f?.bits_at == null ? null : Number(f.bits_at);
    const tip = f?.tip ?? null;
    const powOk = parentPowOk(d.parent, nbitsMain, prev);
    const pf = { height: d.height, tip, nbits: nbitsMain, bitcoinBitsPrev: prev, bitcoinBitsAt: at, powOk };
    const { nbitsCounts, ...episode } = d;
    const nbitsSorted = [...nbitsCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([k]) => hex32(k));
    return {
      ...episode,
      facts: {
        tip_at_first: tip, tip_at_last: f?.tip_last ?? null, tip_offset: tipOffset(d.height, tip), nbits: nbitsSorted,
        bitcoin_bits: prev === null ? null : hex32(prev), bitcoin_bits_at: at === null ? null : hex32(at),
        bitcoin_difficulty: bitcoinDifficulty(pf), pow_ok: powOk, pow_bits: hex32(prev ?? nbitsMain),
        in_stale_blocks: Boolean(f?.in_stale),
        stale_block: f?.in_stale && f.stale_height != null
          ? { height: Number(f.stale_height), header_source: f.stale_header_source ?? null, miner: f.stale_miner ?? null }
          : null,
      },
      kind: f?.in_stale ? 'stale' : parentKind(pf),
      invalid_coinbase: null,
    };
  });
}
