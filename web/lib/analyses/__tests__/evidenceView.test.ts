import { describe, expect, it } from 'vitest';
import { computeOverview, DEFAULT_OVERVIEW, type Overview } from '../overview';
import { CHANNEL_IDS } from '../evidence/aggregate';
import { pairKey, type PairEvidence } from '../evidence/types';
import { TemplateChangeType, type TemplateChangeResult } from '@/utils/templateChangeDetection';
import { changeRows, channelSummaries, defaultSelection, merkleStrips, payoutRows, selectionFromPair, selectionFromPools, similarityMatrix } from '../evidenceView';
import { storeWithClones, NOW } from './overviewFixture';

const o = computeOverview(storeWithClones(), DEFAULT_OVERVIEW, NOW);

describe('evidenceView', () => {
  it('defaults to the largest multi-member family with a contrast pool', () => {
    const s = defaultSelection(o);
    expect(s.members).toEqual(['A', 'B']);
    expect(s.contrast).toBe('C'); // heaviest non-member (C holds 20 blocks)
  });
  it('selectionFromPair keeps order-independent members', () => expect(selectionFromPair(o, 'B', 'A').members).toEqual(['A', 'B']));
  it('selectionFromPools sorts members and picks a non-member contrast', () => {
    const s = selectionFromPools(o, ['D', 'A', 'B']);
    expect(s.members).toEqual(['A', 'B', 'D']);
    expect(s.contrast).toBe('C');
  });
  it('channel summaries: tx selection strong and sufficient for clones', () => {
    const c = channelSummaries(o, ['A', 'B']);
    expect(c.txSelection.insufficient).toBe(false);
    expect(c.txSelection.bits).toBeGreaterThan(16);
  });
  it('channel summaries with no member pairs are insufficient, never zero-sufficient', () => {
    const c = channelSummaries(o, ['A']);
    expect(c.txSelection.insufficient).toBe(true);
    expect(c.tipSwitch.insufficient).toBe(true);
  });
  it('merkle strips show each pool current branches', () => {
    const [a, b] = merkleStrips(o, ['A', 'B']);
    expect(a.branches).toEqual(b.branches);
  });
  it('similarity matrix is symmetric with NaN diagonal', () => {
    const m = similarityMatrix(o, ['A', 'B', 'C']);
    expect(m.bits[0][1]).toBe(m.bits[1][0]);
    expect(Number.isNaN(m.bits[2][2])).toBe(true);
  });
  it('payout rows report label/identity mismatches as data', () => {
    expect(payoutRows(o, ['A', 'B']).mismatches).toEqual([]);
  });
  it('similarity matrix: unobserved or all-insufficient pairs are null, not zero', () => {
    const insufficient = Object.fromEntries(CHANNEL_IDS.map(c => [c, { bits: 0, events: 1, insufficient: true }])) as PairEvidence['channels'];
    const pairs = new Map(o.pairs);
    pairs.set(pairKey('C', 'D'), { a: 'C', b: 'D', total: 0, channels: insufficient });
    const m = similarityMatrix({ ...o, pairs } as Overview, ['A', 'B', 'C', 'D', 'Z']);
    expect(m.bits[2][3]).toBeNull();
    expect(m.bits[3][2]).toBeNull();
    expect(m.bits[0][4]).toBeNull(); // Z has no pair entry
    expect(typeof m.bits[0][1]).toBe('number');
  });
  it('changeRows: tip-only changes (prevHash/height) are common (faded)', () => {
    const last = o.timelines.get('A')!.slice(-1)[0];
    const tip: TemplateChangeResult = {
      hasChanges: true,
      changeTypes: [TemplateChangeType.PREV_HASH, TemplateChangeType.HEIGHT],
      changeDetails: { prevHash: { old: 'p0', new: 'p1' }, height: { old: 1, new: 2 } },
    };
    const entry = { ...last, template: { ...last.template, receivedAtMs: NOW - 1000, change: tip } };
    const fake = { ...o, timelines: new Map([['A', [entry]]]) } as Overview;
    const [row] = changeRows(fake, ['A'], NOW - 60_000);
    expect(row.changes).toHaveLength(1);
    expect(row.changes[0].common).toBe(true);
  });
});
