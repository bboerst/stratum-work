/**
 * Template providers ("Who builds the templates" on the home page; docs/methodology.md, "Template providers"),
 * derived at read time from the backend's per-height counts (template_set_feeds, template_set_pairs; read in
 * lib/db/template-providers.ts). Pure functions, unit-tested in lib/__tests__/templateProviders.test.ts.
 *
 * Per difficulty epoch (2,016 blocks):
 *   node     (feed, pool paid). An unidentified payer (pool null) is a node of its own, named by its feed.
 *   edge     two nodes share a template provider when the transaction sets both received are at least SHARE_MIN (80%)
 *            of the smaller node's sets, both having at least SETS_MIN (5). Sets are counted per height, so the same
 *            set at two heights is two units (the backend's counts add up exactly).
 *   group    the connected components of the edges: one template provider each. A node can't join two separate
 *            providers: at least 80% of its sets on each would need sets both providers received, so they share one.
 *   feed     a feed's provider (Forks: providers per episode) is the group of its node with the most sets, when that
 *            node has at least SETS_MIN; otherwise unknown. A group lists only the feeds it is the provider of.
 * Blocks (our best chain, exact by height):
 *   miner    the coinbase names a DATUM template creator that isn't one of the pool's own (ownCreatorPrefixes), or
 *            carries a DATUM gateway's default tag (creator UNNAMED_CREATOR): a miner-built template, its own kind,
 *            split by creator.
 *   group    otherwise the block's pool (blocks.pool_id) goes to the group of the node paying that pool with the most
 *            sets in the block's epoch (then templates, then node key).
 *   other    "not on our feeds" when no node pays the block's pool; "unidentified" when the block's pool is.
 * Columns are the epochs with counted heights, plus the tip's epoch while its first heights aren't counted yet; pies are
 * the last 144 / 2,016 / 12,096 / 52,416 blocks and all blocks from the first counted epoch, each block counted with
 * its own epoch's groups. A block above the last counted epoch (a new epoch's first blocks, before their windows close)
 * uses the last counted epoch's groups. Share visuals default to the last 2,016 blocks (DEFAULT_PIE_BLOCKS;
 * docs/methodology.md, "Share windows"): the legend is ordered by that pie.
 *
 * Colours: the 8 lead pools with the most blocks over all columns get the palette, in that order; a group's colour is
 * that of the first of its pools (most blocks first) that has one, other groups are grey. In the pies a group is
 * merged across epochs by that identity, so one provider is one slice. Never a payout script or address: nodes are
 * named by feed and pool only.
 */

export const EPOCH_BLOCKS = 2016;
export const SHARE_MIN = 0.8;
export const SETS_MIN = 5;
export const PIE_RANGES: readonly { blocks: number | null; label: string }[] = [
  { blocks: 144, label: "144 blocks" }, { blocks: 2016, label: "2,016 blocks" }, { blocks: 12096, label: "12,096 blocks" },
  { blocks: 52416, label: "52,416 blocks" }, { blocks: null, label: "All" },
];
/** The default share window: the legend's order, and the pie a page shows first (docs/methodology.md, "Share windows"). */
export const DEFAULT_PIE_BLOCKS = 2016;
export const PALETTE = ["#f59e0b", "#3b82f6", "#8b5cf6", "#ef4444", "#10b981", "#06b6d4", "#f472b6", "#84cc16"];
export const GREY = "#5d5c57";
export const OTHER_COLOUR = "#2a2a28";
export const MINER_COLOUR = "#facc15";
export const CREATORS_MAX = 40;
export const NOT_ON_FEEDS = "not on our feeds";
export const UNIDENTIFIED = "unidentified";
/** The creator of a miner-built block whose coinbase carries a DATUM gateway's default tag (no name of its own). */
export const UNNAMED_CREATOR = "unnamed (default tag)";

// --- inputs ---------------------------------------------------------------------------------------------------------
export interface NodeRow { epoch: number; feed: string; pool_id: number | null; sets: number; templates: number }
export interface PairRow { epoch: number; feed_a: string; pool_a: number | null; feed_b: string; pool_b: number | null; shared: number }
export interface BlockRow {
  height: number;
  pool_id: number | null;
  pool: string | null;               // the block's pool name (blocks.mining_pool)
  creator: string | null;            // mining_pool.datum_template_creator, or UNNAMED_CREATOR for a gateway default
  time_ms: number;
}
export interface ProviderInputs {
  nodes: NodeRow[];
  pairs: PairRow[];
  counted: { epoch: number; heights: number }[];   // epochs with counted heights
  blocks: BlockRow[];                                // best chain, height ascending
  poolNames: Map<number, string>;                    // pools.id -> name
  ownCreatorPrefixes?: readonly string[];
}

// --- output (the home page loader's shape: web/lib/templateGroups.ts on the home page branch) -----------------------
export type GroupKind = "producer" | "miner" | "other";
export interface TemplateGroup {
  name: string; n: number; colour: string; hatched: boolean; pools: string[]; payers: string[]; feeds: string[];
  kind: GroupKind; creators: [string, number][]; via: [string, number][];
}
export interface GroupColumn { label: string; title: string; tot: number; groups: TemplateGroup[] }
export interface GroupPie { label: string; tot: number; groups: TemplateGroup[] }
export interface TemplateProviders {
  columns: GroupColumn[];
  pies: GroupPie[];
  legend: { name: string; colour: string }[];
  tip_height: number | null;
  from_height: number | null;
  heights_counted: number;
}

// --- grouping -------------------------------------------------------------------------------------------------------
export type NodeKey = string;
export const nodeKey = (feed: string, pool: number | null): NodeKey => `${feed}\u0000${pool ?? ""}`;

export interface EpochGroups {
  groupOf: Map<NodeKey, number>;                     // node -> group index
  groups: { members: NodeKey[]; feeds: string[]; payers: number[] }[];
  ownerOf: Map<number, number>;                      // pool id -> group index
  feedOf: Map<string, number>;                       // feed -> group index (feedProvider: its node with the most sets)
}

/** One epoch's template providers from its nodes and pairs (rules above). */
export function groupEpoch(nodes: readonly Omit<NodeRow, "epoch">[], pairs: readonly Omit<PairRow, "epoch">[]): EpochGroups {
  const info = new Map<NodeKey, { feed: string; pool: number | null; sets: number; templates: number }>();
  for (const n of nodes) {
    const k = nodeKey(n.feed, n.pool_id);
    const o = info.get(k) ?? { feed: n.feed, pool: n.pool_id, sets: 0, templates: 0 };
    o.sets += n.sets; o.templates += n.templates;
    info.set(k, o);
  }
  const shared = new Map<string, number>();
  for (const p of pairs) {
    const a = nodeKey(p.feed_a, p.pool_a), b = nodeKey(p.feed_b, p.pool_b);
    if (a === b) continue;
    const key = a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;
    shared.set(key, (shared.get(key) ?? 0) + p.shared);
  }
  // edges at or above the threshold
  const adj = new Map<NodeKey, Map<NodeKey, { r: number; shared: number }>>();
  for (const [key, sh] of shared) {
    const [a, b] = key.split("\u0001");
    const sa = info.get(a)?.sets ?? 0, sb = info.get(b)?.sets ?? 0;
    const small = Math.min(sa, sb);
    if (small < SETS_MIN) continue;
    const r = sh / small;
    if (r < SHARE_MIN) continue;
    if (!adj.has(a)) adj.set(a, new Map());
    if (!adj.has(b)) adj.set(b, new Map());
    adj.get(a)!.set(b, { r, shared: sh });
    adj.get(b)!.set(a, { r, shared: sh });
  }
  // every edge, joined by union-find
  const parent = new Map<NodeKey, NodeKey>();
  const find = (x: NodeKey): NodeKey => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y) !== r) { const nx = parent.get(y)!; parent.set(y, r); y = nx; }
    return r;
  };
  const keys = [...info.keys()].sort();
  for (const k of keys) parent.set(k, k);
  for (const [a, bs] of adj) {
    for (const b of bs.keys()) {
      if (!parent.has(b)) parent.set(b, b);
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra);
    }
  }
  const index = new Map<NodeKey, number>(), groups: EpochGroups["groups"] = [], groupOf = new Map<NodeKey, number>();
  for (const k of keys) {
    const root = find(k);
    if (!index.has(root)) { index.set(root, groups.length); groups.push({ members: [], feeds: [], payers: [] }); }
    const gi = index.get(root)!;
    groupOf.set(k, gi);
    groups[gi].members.push(k);
  }
  for (const g of groups) {
    g.payers = [...new Set(g.members.map(m => info.get(m)!.pool).filter((p): p is number => p !== null))].sort((x, y) => x - y);
  }
  // a pool's blocks go to the group of its node with the most sets (then templates, then key); a feed's provider is
  // the group of its own node with the most sets, by the same order, when that node has at least SETS_MIN (below it a
  // node can't link to any other, so its group says nothing: the feed's provider is unknown)
  const ownerOf = new Map<number, number>(), feedOf = new Map<string, number>();
  const bestPool = new Map<number, { sets: number; templates: number; key: NodeKey }>();
  const bestFeed = new Map<string, { sets: number; templates: number; key: NodeKey }>();
  const better = (n: { sets: number; templates: number }, k: NodeKey, b: { sets: number; templates: number; key: NodeKey } | undefined) =>
    !b || n.sets > b.sets || (n.sets === b.sets && (n.templates > b.templates || (n.templates === b.templates && k > b.key)));
  for (const k of keys) {
    const n = info.get(k)!;
    if (better(n, k, bestFeed.get(n.feed))) bestFeed.set(n.feed, { sets: n.sets, templates: n.templates, key: k });
    if (n.pool === null) continue;
    if (better(n, k, bestPool.get(n.pool))) {
      bestPool.set(n.pool, { sets: n.sets, templates: n.templates, key: k });
      ownerOf.set(n.pool, groupOf.get(k)!);
    }
  }
  for (const [feed, b] of bestFeed) if (b.sets >= SETS_MIN) feedOf.set(feed, groupOf.get(b.key)!);
  // a group's feeds: the feeds it is the provider of (feedOf), not every feed with some node in it, so a feed's small
  // node paying another pool doesn't list the feed under that pool's provider
  for (const [feed, gi] of feedOf) groups[gi].feeds.push(feed);
  for (const g of groups) g.feeds.sort();
  return { groupOf, groups, ownerOf, feedOf };
}

/** Each counted epoch's groups (groupEpoch), from the per-epoch node and pair rows. */
export function groupEpochs(nodes: readonly NodeRow[], pairs: readonly PairRow[], counted: readonly { epoch: number; heights: number }[]): Map<number, EpochGroups> {
  const nodesBy = new Map<number, NodeRow[]>(), pairsBy = new Map<number, PairRow[]>();
  for (const n of nodes) { if (!nodesBy.has(n.epoch)) nodesBy.set(n.epoch, []); nodesBy.get(n.epoch)!.push(n); }
  for (const p of pairs) { if (!pairsBy.has(p.epoch)) pairsBy.set(p.epoch, []); pairsBy.get(p.epoch)!.push(p); }
  const out = new Map<number, EpochGroups>();
  for (const c of [...counted].filter(c => c.heights > 0).sort((a, b) => a.epoch - b.epoch)) {
    out.set(c.epoch, groupEpoch(nodesBy.get(c.epoch) ?? [], pairsBy.get(c.epoch) ?? []));
  }
  return out;
}

// --- feeds of one episode -------------------------------------------------------------------------------------------
export interface FeedProviders {
  providers: number | null;          // distinct template providers among the feeds; null: the epoch isn't counted
  provider_groups: string[][];       // the feeds per provider (largest first, then in the feeds' order); feeds whose
                                     // provider is unknown in that epoch are in none
}

/**
 * The template providers of a set of feeds (an episode's pools), with one epoch's groups. No groups (the epoch has no
 * counted heights) gives null: never another epoch's groups. A feed with no node of at least SETS_MIN sets in the epoch
 * has an unknown provider and is left out (not counted as a provider of its own). Only the given feeds are listed.
 */
export function feedProviders(feeds: readonly string[], groups: EpochGroups | undefined): FeedProviders {
  if (!groups) return { providers: null, provider_groups: [] };
  const by = new Map<number, string[]>();
  for (const f of new Set(feeds)) {
    const g = groups.feedOf.get(f);
    if (g === undefined) continue;
    if (!by.has(g)) by.set(g, []);
    by.get(g)!.push(f);
  }
  const provider_groups = [...by.values()].map((fs, i) => ({ fs, i })).sort((a, b) => b.fs.length - a.fs.length || a.i - b.i).map(x => x.fs);
  return { providers: provider_groups.length, provider_groups };
}

// --- attribution ----------------------------------------------------------------------------------------------------
type Counter = Map<string, number>;
const inc = (m: Counter, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const mostCommon = (m: Counter): [string, number][] => [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

interface Bucket {
  kind: GroupKind;
  n: number;
  pools: Counter;            // blocks by pool name
  payers: Set<string>;
  feeds: Set<string>;
  creators: Counter;
  via: Counter;
  lead?: string;             // pies: the identity pool, listed first
}
const bucket = (kind: GroupKind): Bucket => ({ kind, n: 0, pools: new Map(), payers: new Set(), feeds: new Set(), creators: new Map(), via: new Map() });

function isOwnCreator(creator: string, prefixes: readonly string[]): boolean {
  return prefixes.some(p => p.length > 0 && creator.startsWith(p));
}

/** Template providers: columns per epoch, pies per range, legend (rules above). */
export function deriveTemplateProviders(input: ProviderInputs): TemplateProviders | null {
  const prefixes = input.ownCreatorPrefixes ?? [];
  const counted = [...input.counted].filter(c => c.heights > 0).sort((a, b) => a.epoch - b.epoch);
  if (counted.length === 0) return null;
  const grouping = groupEpochs(input.nodes, input.pairs, counted);
  const lastCounted = counted[counted.length - 1].epoch;
  const firstHeight = counted[0].epoch * EPOCH_BLOCKS;

  const name = (id: number) => input.poolNames.get(id) ?? `pool ${id}`;
  const blocks = input.blocks.filter(b => b.height >= firstHeight).sort((a, b) => a.height - b.height);
  const tip = blocks.length ? blocks[blocks.length - 1].height : null;
  const epochOf = (h: number) => {
    const e = Math.floor(h / EPOCH_BLOCKS);
    return grouping.has(e) ? e : e > lastCounted ? lastCounted : null;
  };
  const poolLabel = (b: BlockRow) => (b.pool_id !== null ? input.poolNames.get(b.pool_id) ?? b.pool ?? name(b.pool_id) : b.pool ?? UNIDENTIFIED);

  /** Which bucket a block goes to, keyed for aggregation. `lead` = the pie identity (null in columns). */
  type Place = { key: string; kind: GroupKind; epoch?: number; group?: number };
  const place = (b: BlockRow): Place | null => {
    if (b.creator && !isOwnCreator(b.creator, prefixes)) return { key: "m", kind: "miner" };
    if (b.pool_id === null) return { key: `x:${UNIDENTIFIED}`, kind: "other" };
    const e = epochOf(b.height);
    if (e === null) return null;
    const gi = grouping.get(e)!.ownerOf.get(b.pool_id);
    if (gi === undefined) return { key: `x:${NOT_ON_FEEDS}`, kind: "other" };
    return { key: `g:${e}:${gi}`, kind: "producer", epoch: e, group: gi };
  };
  const addTo = (bk: Bucket, b: BlockRow, p: Place) => {
    bk.n++;
    if (p.kind === "miner") { inc(bk.creators, b.creator!); inc(bk.via, poolLabel(b)); return; }
    if (p.kind === "other") return;
    inc(bk.pools, poolLabel(b));
    const g = grouping.get(p.epoch!)!.groups[p.group!];
    for (const id of g.payers) bk.payers.add(name(id));
    for (const f of g.feeds) bk.feeds.add(f);
  };

  // columns: per counted epoch, plus the tip's epoch while it isn't counted yet (its blocks use the last counted
  // epoch's groups, as in the pies)
  const colBuckets: { label: string; title: string; buckets: Map<string, Bucket>; tot: number }[] = [];
  const timeOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const fmt = (h: number) => h.toLocaleString("en-US");
  const makeColumn = (rows: BlockRow[], label: string, title: string) => {
    const buckets = new Map<string, Bucket>();
    let tot = 0;
    for (const b of rows) {
      const p = place(b);
      if (!p) continue;
      tot++;
      if (!buckets.has(p.key)) buckets.set(p.key, bucket(p.kind));
      addTo(buckets.get(p.key)!, b, p);
    }
    colBuckets.push({ label, title, buckets, tot });
  };
  const columnEpochs = counted.map(c => c.epoch);
  if (tip !== null && Math.floor(tip / EPOCH_BLOCKS) > lastCounted) columnEpochs.push(Math.floor(tip / EPOCH_BLOCKS));
  for (const epoch of columnEpochs) {
    const lo = epoch * EPOCH_BLOCKS, hi = lo + EPOCH_BLOCKS - 1;
    const rows = blocks.filter(b => b.height >= lo && b.height <= hi);
    if (rows.length === 0) continue;
    const last = rows[rows.length - 1];
    const title = `blocks ${fmt(lo)}–${fmt(hi)}${last.height < hi ? ` (to ${fmt(last.height)} so far)` : ""}, ${timeOf(rows[0].time_ms)} to ${timeOf(last.time_ms)}`;
    makeColumn(rows, fmt(lo), title);
  }

  // colours: the lead pools (most blocks in each column's producer groups), top 8 over all columns
  const leadOf = (bk: Bucket) => mostCommon(bk.pools)[0]?.[0];
  const totBy: Counter = new Map();
  for (const c of colBuckets) for (const bk of c.buckets.values()) if (bk.kind === "producer") { const l = leadOf(bk); if (l) inc(totBy, l, bk.n); }
  const leads = new Map<string, string>();
  for (const [p] of mostCommon(totBy).slice(0, PALETTE.length)) leads.set(p, PALETTE[leads.size]);
  const identOf = (pools: string[]) => pools.find(p => leads.has(p)) ?? pools[0];

  const out = (bk: Bucket, otherName?: string): TemplateGroup => {
    if (bk.kind === "miner") {
      return { name: "Miner-built", n: bk.n, colour: MINER_COLOUR, hatched: false, pools: ["Miner-built templates"], payers: [],
        feeds: [], kind: "miner", creators: mostCommon(bk.creators).slice(0, CREATORS_MAX), via: mostCommon(bk.via) };
    }
    if (bk.kind === "other") {
      return { name: otherName!, n: bk.n, colour: OTHER_COLOUR, hatched: false, pools: [otherName!], payers: [], feeds: [],
        kind: "other", creators: [], via: [] };
    }
    let pools = mostCommon(bk.pools).map(([p]) => p);
    if (bk.lead && pools.includes(bk.lead)) pools = [bk.lead, ...pools.filter(p => p !== bk.lead)];
    const payers = [...bk.payers].sort();
    const k = identOf(pools);
    const extra = payers.length - 1;
    return { name: pools[0] + (extra > 0 ? ` +${extra}` : ""), n: bk.n, colour: leads.get(k) ?? GREY, hatched: payers.length > 1,
      pools, payers, feeds: [...bk.feeds].sort(), kind: "producer", creators: [], via: [] };
  };
  const finish = (buckets: Map<string, Bucket>, otherLast: boolean): TemplateGroup[] => {
    const gs = [...buckets].map(([key, bk]) => out(bk, key.startsWith("x:") ? key.slice(2) : undefined));
    return gs.sort((a, b) => (otherLast ? (a.kind === "other" ? 1 : 0) - (b.kind === "other" ? 1 : 0) : 0) || b.n - a.n);
  };
  const columns = colBuckets.map(c => ({ label: c.label, title: c.title, tot: c.tot, groups: finish(c.buckets, true) }));

  // pies: each block with its own epoch's groups, aggregated across epochs by each group's identity: the first of its
  // pools (most blocks first, over all its blocks) that has a colour, else its lead pool. So a provider is one slice
  // with its columns' colour, and a pool's provider keeps its slice from epoch to epoch.
  const groupPools = new Map<string, Counter>();
  for (const b of blocks) {
    const p = place(b);
    if (p?.kind !== "producer") continue;
    const k = `${p.epoch}:${p.group}`;
    if (!groupPools.has(k)) groupPools.set(k, new Map());
    inc(groupPools.get(k)!, poolLabel(b));
  }
  const identity = new Map([...groupPools].map(([k, c]) => [k, identOf(mostCommon(c).map(([p]) => p))]));
  const pies: GroupPie[] = PIE_RANGES.map(({ blocks: n, label }) => {
    const buckets = new Map<string, Bucket>();
    let tot = 0;
    for (const b of blocks) {
      if (n !== null && tip !== null && b.height <= tip - n) continue;
      const p = place(b);
      if (!p) continue;
      tot++;
      let key = p.key;
      let lead: string | undefined;
      if (p.kind === "producer") {
        lead = identity.get(`${p.epoch}:${p.group}`)!;
        key = `g:${lead}`;
      }
      if (!buckets.has(key)) buckets.set(key, { ...bucket(p.kind), lead });
      addTo(buckets.get(key)!, b, p);
    }
    return { label, tot, groups: finish(buckets, false) };
  });

  // legend: coloured leads, miner-built, others; by share of the default (2,016-block) pie
  const share: Counter = new Map();
  for (const g of pies[PIE_RANGES.findIndex(r => r.blocks === DEFAULT_PIE_BLOCKS)].groups) inc(share, g.kind === "miner" ? "\u0000miner" : g.kind === "other" ? "\u0000other" : identOf(g.pools), g.n);
  const items: { name: string; colour: string; s: number }[] = [
    ...[...leads].map(([k, c]) => ({ name: k, colour: c, s: share.get(k) ?? 0 })),
    { name: "miner-built templates", colour: MINER_COLOUR, s: share.get("\u0000miner") ?? 0 },
    { name: "others", colour: GREY, s: -1 },
  ];
  const legend = items.map((x, i) => ({ ...x, i })).sort((a, b) => b.s - a.s || a.i - b.i).map(({ name, colour }) => ({ name, colour }));

  return {
    columns, pies, legend, tip_height: tip, from_height: blocks.length ? blocks[0].height : null,
    heights_counted: counted.reduce((s, c) => s + c.heights, 0),
  };
}
