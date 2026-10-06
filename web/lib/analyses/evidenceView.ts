import { getChangeContentKey } from '@/utils/templateChangeDetection';
import { changeKey } from './evidence/identicalChanges';
import { CHANNEL_IDS } from './evidence/aggregate';
import { switchTimes } from './evidence/tipSwitch';
import { pairKey, type ChannelId } from './evidence/types';
import type { Overview } from './overview';

/** Pools shown by the evidence card; `contrast` is a non-member shown for comparison. */
export interface EvidenceSelection { members: string[]; contrast: string | null }
export interface ChannelSummary { bits: number; insufficient: boolean; events: number }
export interface MerkleStrip { pool: string; branches: string[]; atMs: number | null }
export interface ChangeRow { pool: string; changes: { atMs: number; key: string; common: boolean }[] }
export interface TipRow { prevHash: string; height: number; offsets: { pool: string; ms: number }[] }
export interface PayoutRows {
  sharedAddresses: string[];
  commitments: { protocol: string; content: string; pools: string[] }[];
  mismatches: { pool: string; identity: string }[];
}

const weightOf = (o: Overview, p: string) => o.families.find(f => f.members.includes(p))?.share?.share ?? 0;

function contrastFor(o: Overview, members: string[]): string | null {
  return o.pools.filter(p => !members.includes(p)).sort((a, b) => weightOf(o, b) - weightOf(o, a) || a.localeCompare(b))[0] ?? null;
}

/** Largest multi-member family (families are ordered by weight); else the first two pools. */
export function defaultSelection(o: Overview): EvidenceSelection {
  const fam = o.families.find(f => f.members.length > 1);
  const members = fam ? fam.members.slice() : o.pools.slice(0, 2);
  return { members, contrast: contrastFor(o, members) };
}

export function selectionFromPair(o: Overview, a: string, b: string): EvidenceSelection {
  const members = [a, b].sort();
  return { members, contrast: contrastFor(o, members) };
}

/** Explicit pool list (≥ 2): members sorted, contrast = heaviest pool outside them. */
export function selectionFromPools(o: Overview, pools: string[]): EvidenceSelection {
  const members = Array.from(new Set(pools)).sort();
  return { members, contrast: contrastFor(o, members) };
}

/** Per channel: bits = mean over member pairs; events = min over member pairs; insufficient if any member pair is. */
export function channelSummaries(o: Overview, members: string[]): Record<ChannelId, ChannelSummary> {
  const out = {} as Record<ChannelId, ChannelSummary>;
  for (const c of CHANNEL_IDS) {
    let bits = 0, n = 0, events = Infinity, insufficient = false;
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const pe = o.pairs.get(pairKey(members[i], members[j]))?.channels[c];
      if (!pe) { insufficient = true; events = 0; continue; }
      bits += pe.bits; n++; events = Math.min(events, pe.events); insufficient = insufficient || pe.insufficient;
    }
    out[c] = { bits: n ? bits / n : 0, insufficient: insufficient || n === 0, events: Number.isFinite(events) ? events : 0 };
  }
  return out;
}

/** Current (newest) template's merkle branches per pool. */
export function merkleStrips(o: Overview, pools: string[]): MerkleStrip[] {
  return pools.map(pool => {
    const tl = o.timelines.get(pool) ?? [];
    const t = tl[tl.length - 1]?.template;
    return { pool, branches: t?.merkleBranches ?? [], atMs: t ? t.receivedAtMs : null };
  });
}

/**
 * Changes since `sinceMs` per pool. `common` = an identical-change observation for that key covered ≥ 50% of pools,
 * or the change only moved the tip (prevHash/height/clean jobs), which every pool does.
 */
export function changeRows(o: Overview, pools: string[], sinceMs: number): ChangeRow[] {
  const need = Math.max(2, o.pools.length / 2);
  const commonKeys = new Set(o.observations.identicalChanges.filter(ob => ob.pools.length >= need).map(ob => (ob.detail as { key: string }).key));
  return pools.map(pool => ({
    pool,
    changes: (o.timelines.get(pool) ?? [])
      .filter(e => e.template.receivedAtMs >= sinceMs && e.template.change?.hasChanges)
      .map(e => {
        const key = changeKey(e.template.change);
        return { atMs: e.template.receivedAtMs, key: key || getChangeContentKey(e.template.change!), common: key === '' || commonKeys.has(key) };
      }),
  }));
}

/** Newest first; offsets relative to the earliest switch among the selected pools. Rows need ≥ 2 selected pools. */
export function tipRows(o: Overview, pools: string[], maxBlocks: number): TipRow[] {
  const st = switchTimes(o.timelines);
  const heightOf = new Map<string, number>();
  o.timelines.forEach(es => { for (const e of es) heightOf.set(e.template.prevHash, e.template.height); });
  const rows: TipRow[] = [];
  st.forEach((m, prevHash) => {
    const sel = pools.filter(p => m.has(p));
    if (sel.length < 2) return;
    const t0 = Math.min(...sel.map(p => m.get(p)!));
    rows.push({ prevHash, height: heightOf.get(prevHash) ?? 0, offsets: sel.map(p => ({ pool: p, ms: m.get(p)! - t0 })) });
  });
  return rows.sort((a, b) => b.height - a.height).slice(0, maxBlocks);
}

/** Shared payout addresses (≥ 2 members), commitments touching a member, and label/identity differences as data. */
export function payoutRows(o: Overview, members: string[]): PayoutRows {
  const set = new Set(members);
  const obs = o.observations.payoutsMergeMining;
  const sharedAddresses = obs
    .filter(ob => (ob.detail as { kind: string }).kind === 'address' && ob.pools.filter(p => set.has(p)).length >= 2)
    .map(ob => (ob.detail as { address: string }).address);
  const commitments = obs
    .filter(ob => (ob.detail as { kind: string }).kind === 'commitment' && ob.pools.some(p => set.has(p)))
    .map(ob => { const d = ob.detail as { protocol: string; content: string }; return { protocol: d.protocol, content: d.content, pools: ob.pools }; });
  const mismatches = members.filter(p => (o.identityOf.get(p) ?? p) !== p).map(p => ({ pool: p, identity: o.identityOf.get(p)! }));
  return { sharedAddresses, commitments, mismatches };
}

/** Symmetric total-bits matrix; diagonal NaN; null = insufficient (no pair entry, or every channel insufficient). */
export function similarityMatrix(o: Overview, pools: string[]): { pools: string[]; bits: (number | null)[][] } {
  const cell = (a: string, b: string): number | null => {
    if (a === b) return NaN;
    const pe = o.pairs.get(pairKey(a, b));
    if (!pe || CHANNEL_IDS.every(c => pe.channels[c]?.insufficient ?? true)) return null;
    return pe.total;
  };
  return { pools, bits: pools.map(a => pools.map(b => cell(a, b))) };
}
