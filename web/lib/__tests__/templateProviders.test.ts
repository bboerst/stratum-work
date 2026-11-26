/**
 * Template providers (lib/templateProviders.ts) from synthetic counts: the 80% threshold and the 5-set minimum, the
 * links (every pair at or above the bar, so a provider is never split by which partner a node overlaps most), connected components, a
 * pool's blocks going to the group of its node with the most sets, miner-built blocks (a pool's own template creators
 * excepted), "not on our feeds" and "unidentified", pies exact by height with each block's own epoch's groups,
 * colours and legend, and the output against the home page loader's shape rules. Empty templates are never counted
 * by the backend (backend/tests/test_template_sets.py), so nothing here sees them.
 */
import { describe, expect, it } from 'vitest';
import {
  blockProviders, deriveTemplateProviders, feedProviders, groupEpoch, groupEpochs, nodeKey, EPOCH_BLOCKS, GREY, MINER_COLOUR, OTHER_COLOUR, PALETTE,
  type BlockRow, type NodeRow, type PairRow, type ProviderInputs, type TemplateGroup,
} from '../templateProviders';

const node = (feed: string, pool_id: number | null, sets: number, templates = sets, epoch = 0): NodeRow =>
  ({ epoch, feed, pool_id, sets, templates });
const pair = (a: [string, number | null], b: [string, number | null], shared: number, epoch = 0): PairRow =>
  ({ epoch, feed_a: a[0], pool_a: a[1], feed_b: b[0], pool_b: b[1], shared });
const groupsOf = (g: ReturnType<typeof groupEpoch>) => g.groups.map(x => x.members.map(m => m.replace('\u0000', '|')).sort()).sort();

describe('groupEpoch', () => {
  it('links two nodes at 80% of the smaller node\'s sets, not below', () => {
    const nodes = [node('feed-1', 1, 10), node('feed-2', 2, 20)];
    expect(groupsOf(groupEpoch(nodes, [pair(['feed-1', 1], ['feed-2', 2], 8)]))).toEqual([['feed-1|1', 'feed-2|2']]);
    expect(groupsOf(groupEpoch(nodes, [pair(['feed-1', 1], ['feed-2', 2], 7)]))).toEqual([['feed-1|1'], ['feed-2|2']]);
  });

  it('needs at least 5 sets on both nodes', () => {
    const nodes = [node('feed-1', 1, 4), node('feed-2', 2, 4)];
    expect(groupsOf(groupEpoch(nodes, [pair(['feed-1', 1], ['feed-2', 2], 4)]))).toEqual([['feed-1|1'], ['feed-2|2']]);
    const five = [node('feed-1', 1, 5), node('feed-2', 2, 5)];
    expect(groupsOf(groupEpoch(five, [pair(['feed-1', 1], ['feed-2', 2], 4)]))).toEqual([['feed-1|1', 'feed-2|2']]);
  });

  it('links every pair at or above the bar, so one provider isn\'t split by each node\'s closest partner', () => {
    // one provider of four feeds, all at r = 1.0 (production, epoch 445): p1 and q1 overlap each other most, p2 and q2
    // too, and p1 / p2 a little less; the four are one group
    const nodes = [node('p1', 1, 100), node('q1', 2, 100), node('p2', 3, 100), node('q2', 4, 100)];
    const pairs = [pair(['p1', 1], ['q1', 2], 100), pair(['p2', 3], ['q2', 4], 100), pair(['p1', 1], ['p2', 3], 99)];
    expect(groupsOf(groupEpoch(nodes, pairs))).toEqual([['p1|1', 'p2|3', 'q1|2', 'q2|4']]);
  });

  it('a feed that alternates between two providers joins neither: each holds only part of its sets', () => {
    // c gets half its sets from A and half from B: r 0.5 with each, below the bar
    const nodes = [node('a1', 1, 100), node('a2', 2, 100), node('b1', 3, 100), node('b2', 4, 100), node('c', 5, 20)];
    const pairs = [pair(['a1', 1], ['a2', 2], 100), pair(['b1', 3], ['b2', 4], 100),
      pair(['a1', 1], ['c', 5], 10), pair(['b1', 3], ['c', 5], 10)];
    expect(groupsOf(groupEpoch(nodes, pairs))).toEqual([['a1|1', 'a2|2'], ['b1|3', 'b2|4'], ['c|5']]);
  });

  it('groups are connected components of those links', () => {
    // p -> q, r -> q, s -> r: one provider of four
    const nodes = [node('p', 1, 10), node('q', 2, 10), node('r', 3, 10), node('s', 4, 10)];
    const g = groupEpoch(nodes, [pair(['p', 1], ['q', 2], 10), pair(['q', 2], ['r', 3], 10), pair(['r', 3], ['s', 4], 10)]);
    expect(groupsOf(g)).toEqual([['p|1', 'q|2', 'r|3', 's|4']]);
    expect(g.groups[0].payers).toEqual([1, 2, 3, 4]);
  });

  it('an unidentified payer is a node of its own and never a payer', () => {
    const g = groupEpoch([node('feed-1', 1, 10), node('feed-1', null, 10)], [pair(['feed-1', null], ['feed-1', 1], 10)]);
    expect(groupsOf(g)).toEqual([['feed-1|', 'feed-1|1']]);
    expect(g.groups[0].payers).toEqual([1]);
    expect(g.groups[0].feeds).toEqual(['feed-1']);
  });

  it('a group lists only the feeds it is the provider of, not a feed\'s small node in it', () => {
    // feed L mostly pays pool 2 (its own provider); 17 of its sets pay pool 1 and are pool 1's: that node joins A's group
    const g = groupEpoch([node('A', 1, 100), node('L', 2, 100), node('L', 1, 17)], [pair(['A', 1], ['L', 1], 17)]);
    expect(groupsOf(g)).toEqual([['A|1', 'L|1'], ['L|2']]);
    expect(g.groups[g.groupOf.get(nodeKey('A', 1))!].feeds).toEqual(['A']);
    expect(g.groups[g.groupOf.get(nodeKey('L', 2))!].feeds).toEqual(['L']);
    expect(g.groups[g.groupOf.get(nodeKey('A', 1))!].payers).toEqual([1]);
  });

  it('a pool\'s blocks go to its node with the most sets', () => {
    // pool 1 is paid on feed-1 (provider of its own) and, a little, on feed-2 (with pool 2)
    const g = groupEpoch([node('feed-1', 1, 50), node('feed-2', 1, 10), node('feed-2', 2, 40)],
      [pair(['feed-2', 1], ['feed-2', 2], 10)]);
    expect(g.ownerOf.get(1)).toBe(g.groupOf.get(nodeKey('feed-1', 1)));
    expect(g.ownerOf.get(2)).toBe(g.groupOf.get(nodeKey('feed-2', 2)));
  });
});

const NAMES = new Map([[1, 'Pool A'], [2, 'Pool B'], [3, 'Pool C'], [4, 'Pool D'], [9, 'Pool Z']]);
let hb = 0;
const blk = (height: number, pool_id: number | null, creator: string | null = null): BlockRow =>
  ({ height, pool_id, pool: pool_id === null ? 'Unknown' : NAMES.get(pool_id) ?? null, creator, time_ms: 1_700_000_000_000 + (hb++) * 600_000 });

/** Two epochs: in E0, pools A and B share one provider (feed-a, feed-b); C alone; in E1, A and B apart. */
const E0 = 450, E1 = 451;
const inputs = (blocks: BlockRow[], o: Partial<ProviderInputs> = {}): ProviderInputs => ({
  counted: [{ epoch: E0, heights: 2016 }, { epoch: E1, heights: 100 }],
  nodes: [node('feed-a', 1, 100, 200, E0), node('feed-b', 2, 100, 100, E0), node('feed-c', 3, 50, 50, E0),
    node('feed-a', 1, 100, 100, E1), node('feed-b', 2, 100, 100, E1), node('feed-c', 3, 50, 50, E1)],
  pairs: [pair(['feed-a', 1], ['feed-b', 2], 95, E0), pair(['feed-a', 1], ['feed-b', 2], 10, E1)],
  blocks, poolNames: NAMES, ...o,
});
const h0 = E0 * EPOCH_BLOCKS, h1 = E1 * EPOCH_BLOCKS;
const byName = (gs: TemplateGroup[]) => Object.fromEntries(gs.map(g => [g.name, g]));

describe('deriveTemplateProviders', () => {
  it('returns null with nothing counted', () => {
    expect(deriveTemplateProviders({ ...inputs([]), counted: [] })).toBeNull();
  });

  it('columns per counted epoch plus now; groups, payers, hatching, other kinds', () => {
    const blocks = [blk(h0 + 1, 1), blk(h0 + 2, 2), blk(h0 + 3, 1), blk(h0 + 4, 3), blk(h0 + 5, 9), blk(h0 + 6, null),
      blk(h1 + 1, 1), blk(h1 + 2, 2)];
    const r = deriveTemplateProviders(inputs(blocks))!;
    expect(r.columns.map(c => c.label)).toEqual(['907,200', '909,216', 'now']);
    expect(r.columns[0].title).toMatch(/^blocks 907,200–909,215 \(to 907,206 so far\), \d{4}-\d\d-\d\d to /);
    const c0 = byName(r.columns[0].groups);
    expect(c0['Pool A +1']).toMatchObject({ n: 3, pools: ['Pool A', 'Pool B'], payers: ['Pool A', 'Pool B'], feeds: ['feed-a', 'feed-b'], hatched: true, kind: 'producer' });
    expect(c0['Pool C']).toMatchObject({ n: 1, hatched: false, feeds: ['feed-c'] });
    expect(c0['not on our feeds']).toMatchObject({ n: 1, kind: 'other', colour: OTHER_COLOUR, feeds: [], payers: [] });
    expect(c0['unidentified']).toMatchObject({ n: 1, kind: 'other' });
    expect(r.columns[0].tot).toBe(6);
    expect(r.columns[0].groups.slice(-2).every(g => g.kind === 'other')).toBe(true);   // other last
    const c1 = byName(r.columns[1].groups);
    expect(Object.keys(c1).sort()).toEqual(['Pool A', 'Pool B']);                     // apart in E1
    expect(r.tip_height).toBe(h1 + 2);
    expect(r.heights_counted).toBe(2116);
  });

  it('miner-built blocks are their own kind, a pool\'s own template creators excepted', () => {
    const blocks = [blk(h0 + 1, 3, 'miner-x'), blk(h0 + 2, 3, 'miner-x'), blk(h0 + 3, 3, 'miner-y'), blk(h0 + 4, 3, 'OWN-1')];
    const r = deriveTemplateProviders(inputs(blocks, { ownCreatorPrefixes: ['OWN'] }))!;
    const all = byName(r.pies[4].groups);
    expect(all['Miner-built']).toMatchObject({ n: 3, kind: 'miner', colour: MINER_COLOUR, creators: [['miner-x', 2], ['miner-y', 1]], via: [['Pool C', 3]] });
    expect(all['Pool C'].n).toBe(1);
    const none = byName(deriveTemplateProviders(inputs(blocks))!.pies[4].groups);
    expect(none['Miner-built'].n).toBe(4);                                            // no prefixes: every creator
  });

  it('pies are exact by height and count each block with its own epoch\'s groups', () => {
    // 150 blocks: 140 at the end of E0 (A and B together), 10 in E1 (apart)
    const blocks = [...Array.from({ length: 140 }, (_, i) => blk(h1 - 140 + i, i % 2 ? 1 : 2)),
      ...Array.from({ length: 10 }, (_, i) => blk(h1 + i, 2))];
    const r = deriveTemplateProviders(inputs(blocks))!;
    expect(r.pies.map(p => p.label)).toEqual(['144 blocks', '2,016 blocks', '12,096 blocks', '52,416 blocks', 'All']);
    const p144 = r.pies[0];
    expect(p144.tot).toBe(144);
    const g = byName(p144.groups);
    // E0's shared group is one slice (its identity: Pool A, tied with B and first by name), E1's Pool B another
    expect(g['Pool A +1']).toMatchObject({ n: 134, pools: ['Pool A', 'Pool B'], hatched: true });   // 134 of E0's 140
    expect(g['Pool B']).toMatchObject({ n: 10, hatched: false, payers: ['Pool B'] });
    expect(g['Pool A +1'].colour).toBe(PALETTE[0]);
    expect(g['Pool B'].colour).toBe(PALETTE[1]);
    expect(r.pies[4].tot).toBe(150);
    expect(r.pies[0].groups.reduce((s, x) => s + x.n, 0)).toBe(144);
  });

  it('a block above the last counted epoch uses its groups; uncounted epochs below are left out', () => {
    const counted = [{ epoch: E0, heights: 10 }];
    const blocks = [blk(h0 - 5, 1), blk(h0 + 1, 1), blk(h1 + 3, 2)];
    const r = deriveTemplateProviders(inputs(blocks, { counted }))!;
    expect(r.from_height).toBe(h0 + 1);
    expect(r.pies[4].tot).toBe(2);
    expect(r.pies[4].groups.map(g => [g.name, g.n])).toEqual([['Pool A +1', 2]]);
    expect(r.columns.map(c => c.label)).toEqual(['907,200', 'now']);
  });

  it('colours the top 8 lead pools, the rest grey; legend by the 144-block share', () => {
    // ten pools, each alone on its own feed, pool k with k blocks
    const ids = Array.from({ length: 10 }, (_, i) => 101 + i);
    const names = new Map(ids.map(id => [id, `P${id}`]));
    const blocks = ids.flatMap((id, i) => Array.from({ length: i + 1 }, () => ({ ...blk(h0, id), pool: `P${id}` })))
      .map((b, i) => ({ ...b, height: h0 + i }));
    const r = deriveTemplateProviders({
      counted: [{ epoch: E0, heights: 2016 }], pairs: [], blocks, poolNames: names,
      nodes: ids.map(id => node(`feed-${id}`, id, 10, 10, E0)),
    })!;
    const col = byName(r.columns[0].groups);
    expect(col['P110'].colour).toBe(PALETTE[0]);
    expect(col['P103'].colour).toBe(PALETTE[7]);
    expect(col['P102'].colour).toBe(GREY);
    expect(r.legend.map(l => l.name)).toEqual(['P110', 'P109', 'P108', 'P107', 'P106', 'P105', 'P104', 'P103', 'miner-built templates', 'others']);
  });

  it('matches the home page loader\'s shape rules', () => {
    const blocks = [blk(h0 + 1, 1), blk(h0 + 2, 3, 'miner-x'), blk(h0 + 3, 9), blk(h1 + 1, 2)];
    const r = JSON.parse(JSON.stringify(deriveTemplateProviders(inputs(blocks))));
    checkShape(r);
  });
});

/** The loader's checks (parseTemplateGroups on the home page branch: web/lib/templateGroups.ts), restated. */
function checkShape(raw: Record<string, unknown>) {
  const isStr = (v: unknown) => typeof v === 'string';
  const isCount = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const strs = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(isStr));
  const pairs = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(x => Array.isArray(x) && x.length === 2 && isStr(x[0]) && isCount(x[1])));
  const group = (g: Record<string, unknown>) => {
    expect(['producer', 'miner', 'other']).toContain(g.kind);
    expect(isStr(g.name) && isCount(g.n) && isStr(g.colour)).toBe(true);
    expect(typeof g.hatched).toBe('boolean');
    expect(strs(g.pools) && strs(g.payers) && strs(g.feeds) && pairs(g.creators) && pairs(g.via)).toBe(true);
  };
  for (const key of ['columns', 'pies'] as const) {
    expect(Array.isArray(raw[key])).toBe(true);
    for (const c of raw[key] as Record<string, unknown>[]) {
      expect(isStr(c.label) && isCount(c.tot)).toBe(true);
      if (key === 'columns') expect(isStr(c.title)).toBe(true);
      expect(Array.isArray(c.groups)).toBe(true);
      (c.groups as Record<string, unknown>[]).forEach(group);
    }
  }
  for (const l of raw.legend as Record<string, unknown>[]) expect(isStr(l.name) && isStr(l.colour)).toBe(true);
  const labels = (raw.pies as { label: string }[]).map(p => p.label);
  expect(labels).toEqual(['144 blocks', '2,016 blocks', '12,096 blocks', '52,416 blocks', 'All']);
}

describe('feedProviders (Forks: template providers per episode)', () => {
  // providers: A = feed-a + feed-b, B = feed-c; feed-d alternates payers: its node paying pool 9 has the most sets and
  // is on B; feed-s has too few sets to link (unknown); feed-z isn't in the epoch at all (unknown)
  const nodes = [node('feed-a', 1, 50), node('feed-b', 2, 45), node('feed-c', 3, 40), node('feed-d', 1, 6), node('feed-d', 9, 30),
    node('feed-s', 4, 4)];
  const pairs = [pair(['feed-a', 1], ['feed-b', 2], 45), pair(['feed-c', 3], ['feed-d', 9], 30), pair(['feed-a', 1], ['feed-d', 1], 6)];
  const g = groupEpoch(nodes, pairs);

  it('groups the feeds by provider, largest first, then in the feeds\' order; counts the providers', () => {
    expect(feedProviders(['feed-c', 'feed-a', 'feed-b'], g)).toEqual({ providers: 2, provider_groups: [['feed-a', 'feed-b'], ['feed-c']] });
    expect(feedProviders(['feed-c', 'feed-a'], g)).toEqual({ providers: 2, provider_groups: [['feed-c'], ['feed-a']] });
    expect(feedProviders(['feed-a', 'feed-a'], g)).toEqual({ providers: 1, provider_groups: [['feed-a']] });
  });

  it('takes a feed\'s provider from its node with the most sets', () => {
    expect(feedProviders(['feed-d', 'feed-c'], g)).toEqual({ providers: 1, provider_groups: [['feed-d', 'feed-c']] });
  });

  it('leaves a feed below the set minimum, or not in the epoch, unknown (in no group, not a provider)', () => {
    expect(feedProviders(['feed-a', 'feed-s', 'feed-z'], g)).toEqual({ providers: 1, provider_groups: [['feed-a']] });
    expect(feedProviders(['feed-s', 'feed-z'], g)).toEqual({ providers: 0, provider_groups: [] });
  });

  it('is null without the epoch\'s groups (never another epoch\'s)', () => {
    expect(feedProviders(['feed-a'], undefined)).toEqual({ providers: null, provider_groups: [] });
    const by = groupEpochs([node('feed-a', 1, 10, 10, 3)], [], [{ epoch: 3, heights: 10 }, { epoch: 4, heights: 0 }]);
    expect([...by.keys()]).toEqual([3]);
    expect(feedProviders(['feed-a'], by.get(4))).toEqual({ providers: null, provider_groups: [] });
    expect(feedProviders(['feed-a'], by.get(3))).toEqual({ providers: 1, provider_groups: [['feed-a']] });
  });

  it('groups each epoch with its own rows', () => {
    const by = groupEpochs(
      [node('feed-a', 1, 10, 10, 0), node('feed-b', 2, 10, 10, 0), node('feed-a', 1, 10, 10, 1), node('feed-b', 2, 10, 10, 1)],
      [pair(['feed-a', 1], ['feed-b', 2], 10, 0), pair(['feed-a', 1], ['feed-b', 2], 2, 1)],
      [{ epoch: 0, heights: 2016 }, { epoch: 1, heights: 2016 }]);
    expect(feedProviders(['feed-a', 'feed-b'], by.get(0)).providers).toBe(1);
    expect(feedProviders(['feed-a', 'feed-b'], by.get(1)).providers).toBe(2);
  });
});

describe('blockProviders (one placement rule with the pies)', () => {
  it('every block keyed to its "All" pie group, with the same counts and names', () => {
    const blocks = [blk(h0 + 1, 1), blk(h0 + 2, 2), blk(h0 + 3, 1), blk(h0 + 4, 3), blk(h0 + 5, 9), blk(h0 + 6, null),
      blk(h1 + 1, 1), blk(h1 + 2, 2), blk(h1 + 3, 3, 'miner-x')];
    const bp = blockProviders(inputs(blocks))!;
    const all = deriveTemplateProviders(inputs(blocks))!.pies[4].groups;
    expect(bp.keyOf.size).toBe(blocks.length);
    const counts = new Map<string, number>();
    for (const k of bp.keyOf.values()) counts.set(bp.groups.get(k)!.name, (counts.get(bp.groups.get(k)!.name) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual(Object.fromEntries(all.map(g => [g.name, g.n])));
    // Pool A and Pool B share a provider in E0 but not in E1: each block with its own epoch's group
    expect(bp.groups.get(bp.keyOf.get(h0 + 2)!)!.name).toBe(bp.groups.get(bp.keyOf.get(h0 + 1)!)!.name);
    expect(bp.keyOf.get(h1 + 2)).not.toBe(bp.keyOf.get(h1 + 1));
    expect(bp.groups.get(bp.keyOf.get(h1 + 3)!)!.kind).toBe('miner');
    expect(bp.groups.get(bp.keyOf.get(h0 + 5)!)!.name).toBe('not on our feeds');
  });
  it('null with nothing counted; blocks before the first counted epoch are not placed', () => {
    expect(blockProviders({ ...inputs([]), counted: [] })).toBeNull();
    expect(blockProviders(inputs([blk(h0 - 5, 1), blk(h0 + 1, 1)]))!.keyOf.has(h0 - 5)).toBe(false);
  });
});
