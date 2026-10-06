import type { TemplateStore } from '@/lib/templates/store';
import type { PoolTimelineEntry, Template } from '@/lib/templates/types';
import { runEvidence } from './evidence/aggregate';
import type { ChannelId, Observation, PairEvidence } from './evidence/types';
import { templateFamilies, type Family } from './families';
import { groupShare, hashrateShares, poolIdentityMap, type HashrateShares, type ShareRow } from './hashrate';
import { effectiveNumber, fewestControllingMajority } from './stats';

export interface OverviewParams { thresholdBits: number; windowBlocks: number }
export const DEFAULT_OVERVIEW: OverviewParams = { thresholdBits: 16, windowBlocks: 1008 };
export interface FamilyView extends Family {
  identities: string[]; // distinct identity names of members, sorted
  share: ShareRow | null; // Wilson over summed identity blocks; null when shares unavailable
  current: Template | null; // newest template among members (for tx range, fees, empty marker)
}
export interface Overview {
  pools: string[]; timelines: Map<string, PoolTimelineEntry[]>; identityOf: Map<string, string>;
  shares: HashrateShares; families: FamilyView[]; pairs: Map<string, PairEvidence>;
  observations: Record<ChannelId, Observation[]>; nowMs: number;
  summary: { k: number; effectiveNumber: number } | null; // over family shares; null when shares unavailable
}

export function computeOverview(store: TemplateStore, params: OverviewParams, nowMs = Date.now()): Overview {
  const snap = store.getSnapshot();
  const timelines = new Map<string, PoolTimelineEntry[]>();
  for (const pool of store.poolNames()) {
    const v = store.poolView(pool).filter(e => e.template.mode === 'observe');
    if (v.length) timelines.set(pool, v);
  }
  const pools = Array.from(timelines.keys()).sort();
  const observeTemplates = pools.reduce<Template[]>((acc, p) => { for (const e of timelines.get(p)!) acc.push(e.template); return acc; }, []);
  const identityOf = poolIdentityMap(observeTemplates);
  const shares = hashrateShares(Array.from(snap.blocks.values()), new Set(Array.from(identityOf.values())), params.windowBlocks);
  const { pairs, observations } = runEvidence({ timelines, nowMs });

  // An identity split across several observed pool labels is divided evenly so it isn't double counted.
  const perIdentityCount = new Map<string, number>();
  for (const p of pools) { const id = identityOf.get(p)!; perIdentityCount.set(id, (perIdentityCount.get(id) ?? 0) + 1); }
  const shareOf = new Map(shares.identities.map(r => [r.name, r.share] as [string, number]));
  const weights = new Map(pools.map(p => { const id = identityOf.get(p)!; return [p, (shareOf.get(id) ?? 0) / perIdentityCount.get(id)!] as [string, number]; }));

  const families = mergeByIdentity(templateFamilies(pairs, pools, weights, params.thresholdBits), identityOf, weights).map(f => {
    const identities = Array.from(new Set(f.members.map(m => identityOf.get(m)!))).sort();
    let current: Template | null = null;
    for (const m of f.members) {
      const tl = timelines.get(m)!;
      const t = tl[tl.length - 1]?.template;
      if (t && (!current || t.receivedAtMs > current.receivedAtMs)) current = t;
    }
    return { ...f, identities, share: shares.unavailable ? null : groupShare(shares, identities), current } as FamilyView;
  });
  const summary = shares.unavailable ? null : (() => {
    const s = families.map(f => f.share!.share).concat([shares.notObserved.share]);
    return { k: fewestControllingMajority(s), effectiveNumber: effectiveNumber(s) };
  })();
  return { pools, timelines, identityOf, shares, families, pairs, observations, nowMs, summary };
}

/**
 * Display merge: families whose members share an identity name become one family, so each
 * identity's blocks are counted in exactly one family (shares sum to <= 1). Unidentified pools map
 * to their own label in `poolIdentityMap`, so they only merge if that label equals another pool's
 * identity name — which would otherwise double count the same blocks.
 */
function mergeByIdentity(families: Family[], identityOf: Map<string, string>, weights: Map<string, number>): Family[] {
  const parent = families.map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const owner = new Map<string, number>();
  families.forEach((f, i) => f.members.forEach(m => {
    const id = identityOf.get(m)!;
    const o = owner.get(id);
    if (o === undefined) owner.set(id, i);
    else { const a = find(o), b = find(i); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
  }));
  const groups = new Map<number, string[]>();
  families.forEach((f, i) => { const r = find(i); groups.set(r, (groups.get(r) ?? []).concat(f.members)); });
  if (groups.size === families.length) return families;
  const w = (p: string) => weights.get(p) ?? 0;
  return Array.from(groups.values()).map(ms => {
    const members = ms.slice().sort();
    const head = members.slice().sort((a, b) => w(b) - w(a) || a.localeCompare(b))[0];
    return {
      id: members.join(','),
      label: members.length > 1 ? `${head} +${members.length - 1}` : head,
      members,
      weight: members.reduce((a, m) => a + w(m), 0),
    };
  }).sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
}

export type { HashrateShares, ShareRow };
