/**
 * /api/unknown-parents: episodes assembled from the per-(parent, pool) rows and their facts (kind inferred by
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
  DRILL_MARGIN_MS, getDrillRows, getEpisodeFacts, getEpisodePoolRows,
  type DrillTemplateRow, type EpisodeFactsSql, type EpisodePoolSql, type ParentLabel,
} from './db/unknown-parents';
import { bitcoinDifficulty, connectionLabel, parentKind, parentPowOk, tipOffset, type ParentKind } from './parentKind';
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
  tip_offset: number | null;     // height - 1 - tip_at_first
  nbits: string[];               // the templates' nbits (hex), most common first
  bitcoin_bits: string | null;   // Bitcoin's bits at height - 1 (hex), null when no block is stored there
  bitcoin_bits_at: string | null;  // ... at height (consulted at a retarget height)
  bitcoin_difficulty: boolean | null;  // the templates' nbits are Bitcoin's there (null: nothing to compare with)
  pow_ok: boolean;               // the parent meets the target of pow_bits
  pow_bits: string;              // the bits the PoW was checked against: Bitcoin's at height - 1, else the templates'
  in_stale_blocks: boolean;      // the parent is a recorded stale block
}

export interface Episode {
  parent: string;                // the unknown parent, display-order hex
  height: number;                // the templates' height (the most common one), so the parent is at height - 1
  heights: number[];             // every height its templates gave, ascending
  pools: EpisodePool[];          // by first template
  first_ms: number;
  last_ms: number;
  duration_ms: number;
  templates: number;             // de-duplicated (exact copies across a pool's connections count once)
  auxpow_templates: number;
  auxpow_share: number;          // 0..1
  facts: EpisodeFacts;
  kind: ParentKind;              // INFERRED from the facts (lib/parentKind.ts)
}

/** An episode before its facts are read. */
export type EpisodeDraft = Omit<Episode, 'facts' | 'kind'> & { nbitsCounts: Map<number, number> };

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
    let templates = 0, aux = 0, first = Infinity, last = -Infinity;
    const pools: (EpisodePool & { first: number })[] = [];
    for (const r of rs) {
      add(heights, r.heights);
      add(nbits, r.nbits);
      const n = Number(r.n), f = Number(r.first_ms), l = Number(r.last_ms);
      templates += n;
      aux += Number(r.auxpow);
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
      auxpow_templates: aux, auxpow_share: templates ? aux / templates : 0, nbitsCounts: nbits,
    });
  }
  return out.sort((a, b) => a.first_ms - b.first_ms || (a.parent < b.parent ? -1 : 1));
}

/** The window's episodes: one scan of templates (aggregated per parent and pool), then the facts per episode. */
export async function getEpisodes(excludePools: string[]): Promise<Episode[]> {
  const drafts = draftEpisodes(await getEpisodePoolRows(excludePools));
  const facts = await getEpisodeFacts(drafts.map(d => ({ parent: d.parent, height: d.height, first_ms: d.first_ms })));
  return finishEpisodes(drafts, facts);
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
  blocks: DrillBlock[];          // every block we know at height - 1 and height
}

/** One episode's drill-in: its pools' templates at height - 1 .. height + 1 around its receive times, and the blocks. */
export async function getDrill(e: Episode, excludePools: string[]): Promise<Drill> {
  const from_ms = e.first_ms - DRILL_MARGIN_MS, to_ms = e.last_ms + DRILL_MARGIN_MS;
  const rows = await getDrillRows(
    { parent: e.parent, height: e.height, pools: e.pools.map(p => p.pool), from_ms, to_ms }, excludePools);
  return {
    from_ms, to_ms, truncated: rows.truncated,
    templates: rows.templates.map(toUnknownParentTemplate),
    blocks: rows.blocks.map(b => ({ hash: b.block_hash, height: b.height, arrival_ms: Number(b.arrival_ms), best: b.best })),
  };
}

/** Attach the facts (getEpisodeFacts rows, in the drafts' order) and infer the kind. */
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
        tip_at_first: tip, tip_offset: tipOffset(d.height, tip), nbits: nbitsSorted,
        bitcoin_bits: prev === null ? null : hex32(prev), bitcoin_bits_at: at === null ? null : hex32(at),
        bitcoin_difficulty: bitcoinDifficulty(pf), pow_ok: powOk, pow_bits: hex32(prev ?? nbitsMain),
        in_stale_blocks: Boolean(f?.in_stale),
      },
      kind: parentKind(pf),
    };
  });
}
