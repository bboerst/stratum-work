/**
 * Forks short links (lib/forksPath.ts): path parsing, the selection order at one height, the range a link resolves in
 * (smallest range that has it), the short path the page writes (it resolves back to the same episode), old ?parent=
 * links, and the link-preview title and description. Synthetic episodes only.
 */
import { describe, expect, it } from 'vitest';
import {
  SELECTION_ORDER, episodeDescription, episodeTitle, parseForksPath, rankAtHeight, resolvePath, selectEpisode,
  pagePath, shortPath, shortPathForParent, type ShareEpisode, type ShareKind, type ShareRange,
} from '../forksPath';

let n = 0;
const ep = (kind: ShareKind, height: number, o: Partial<ShareEpisode> = {}): ShareEpisode => {
  n++;
  return {
    parent: `${'00'.repeat(20)}${n.toString(16).padStart(24, '0')}`, height, kind,
    pools: [{ pool: 'Pool A' }], templates: 10, first_ms: 1_000 + n, duration_ms: 72_000, ...o,
  };
};

describe('parseForksPath', () => {
  it('reads a height, a kind slug and a parent suffix', () => {
    expect(parseForksPath(['976175'])).toEqual({ height: 976175, kind: null, suffix: null });
    expect(parseForksPath(['976175', 'race'])).toEqual({ height: 976175, kind: 'stale', suffix: null });
    expect(parseForksPath(['976175', 'unrecorded'])).toEqual({ height: 976175, kind: 'bitcoin_block', suffix: null });
    expect(parseForksPath(['976175', 'other-chain'])).toEqual({ height: 976175, kind: 'other_chain', suffix: null });
    expect(parseForksPath(['976175', 'invalid-parent'])).toEqual({ height: 976175, kind: 'invalid_parent', suffix: null });
    expect(parseForksPath(['976175', 'invalid-coinbase'])).toEqual({ height: 976175, kind: 'invalid_coinbase', suffix: null });
    expect(parseForksPath(['976175', 'undetermined'])).toEqual({ height: 976175, kind: 'undetermined', suffix: null });
    expect(parseForksPath(['976175', 'other-chain-0a1b2c3d'])).toEqual({ height: 976175, kind: 'other_chain', suffix: '0a1b2c3d' });
    expect(parseForksPath(['976175', 'Race'])).toEqual({ height: 976175, kind: 'stale', suffix: null });
    // another chain's heights can be anything, 0 included
    expect(parseForksPath(['0'])).toEqual({ height: 0, kind: null, suffix: null });
    expect(parseForksPath(['6976415', 'other-chain'])).toEqual({ height: 6976415, kind: 'other_chain', suffix: null });
  });
  it('rejects anything else', () => {
    for (const s of [[], ['01'], ['-5'], ['1e6'], ['abc'], ['12345678901'], ['5', 'stale'], ['5', 'race-xyz'],
      ['5', 'race-0a1b2c3'], ['5', 'race', 'x'], ['5', '']]) {
      expect(parseForksPath(s), s.join('/')).toBeNull();
    }
  });
});

describe('selection at one height', () => {
  it('orders invalid coinbase > invalid parent > race > unrecorded block > other chain > undetermined', () => {
    expect(SELECTION_ORDER).toEqual(['invalid_coinbase', 'invalid_parent', 'stale', 'bitcoin_block', 'never_appeared', 'other_chain', 'undetermined']);
    const eps = [ep('undetermined', 7), ep('other_chain', 7), ep('bitcoin_block', 7), ep('stale', 7), ep('invalid_parent', 7), ep('stale', 8)];
    expect(rankAtHeight(eps, 7).map(e => e.kind)).toEqual(['invalid_parent', 'stale', 'bitcoin_block', 'other_chain', 'undetermined']);
    expect(selectEpisode([...eps, ep('invalid_coinbase', 7)], { height: 7, kind: null, suffix: null })?.episode.kind).toBe('invalid_coinbase');
  });
  it('breaks ties within a kind by pools, then templates, then first seen, then parent', () => {
    const few = ep('other_chain', 9, { pools: [{ pool: 'A' }] });
    const many = ep('other_chain', 9, { pools: [{ pool: 'A' }, { pool: 'B' }] });
    const moreTemplates = ep('other_chain', 9, { pools: [{ pool: 'A' }], templates: 99 });
    const earlier = ep('other_chain', 9, { pools: [{ pool: 'A' }], first_ms: 1 });
    expect(rankAtHeight([few, earlier, moreTemplates, many], 9)).toEqual([many, moreTemplates, earlier, few]);
  });
  it('selects a kind exactly, falls back to the most notable when the kind is not there', () => {
    const race = ep('stale', 5), other = ep('other_chain', 5);
    expect(selectEpisode([race, other], { height: 5, kind: 'other_chain', suffix: null })).toEqual({ episode: other, exact: true });
    expect(selectEpisode([race, other], { height: 5, kind: 'bitcoin_block', suffix: null })).toEqual({ episode: race, exact: false });
    expect(selectEpisode([race, other], { height: 6, kind: null, suffix: null })).toBeNull();
  });
  it('selects by parent suffix', () => {
    const a = ep('other_chain', 5, { pools: [{ pool: 'A' }, { pool: 'B' }] }), b = ep('other_chain', 5);
    expect(selectEpisode([a, b], { height: 5, kind: 'other_chain', suffix: b.parent.slice(-8) })?.episode).toBe(b);
  });
});

describe('shortPath', () => {
  it('is the bare height for the most notable episode, the kind for the next, a suffix for a second of one kind', () => {
    const race = ep('stale', 976175, { pools: [{ pool: 'A' }, { pool: 'B' }] }), other = ep('other_chain', 976175);
    const other2 = ep('other_chain', 976175, { templates: 1 });
    const all = [ep('stale', 1), race, other, other2];
    expect(shortPath(race, all)).toBe('/forks/976175');
    expect(shortPath(other, all)).toBe('/forks/976175/other-chain');
    expect(shortPath(other2, all)).toBe(`/forks/976175/other-chain-${other2.parent.slice(-8)}`);
    expect(shortPath(ep('bitcoin_block', 3), [])).toBe('/forks/3');
    // each resolves back to its episode
    for (const e of [race, other, other2]) {
      expect(selectEpisode(all, parseForksPath(shortPath(e, all).split('/').slice(2))!)?.episode).toBe(e);
    }
  });
});

describe('resolving across ranges', () => {
  const recent = ep('stale', 976000), older = ep('stale', 950000), oldOther = ep('other_chain', 976000);
  const ranges: Record<ShareRange, ShareEpisode[]> = { '6e': [recent], '26e': [recent, older], all: [recent, older, oldOther] };
  const calls: ShareRange[] = [];
  const load = async (r: ShareRange) => { calls.push(r); return ranges[r]; };

  it('uses the smallest range that has the episode', async () => {
    calls.length = 0;
    expect(await resolvePath({ height: 976000, kind: null, suffix: null }, load)).toMatchObject({ range: '6e', episode: recent, exact: true });
    expect(calls).toEqual(['6e']);
    expect(await resolvePath({ height: 950000, kind: null, suffix: null }, load)).toMatchObject({ range: '26e', episode: older });
    // a kind only a larger range has: found there, not the smaller range's other kind
    expect(await resolvePath({ height: 976000, kind: 'other_chain', suffix: null }, load)).toMatchObject({ range: 'all', episode: oldOther, exact: true });
  });
  it('falls back to the first range with the height, and is null without one', async () => {
    expect(await resolvePath({ height: 950000, kind: 'invalid_parent', suffix: null }, load)).toMatchObject({ range: '26e', episode: older, exact: false });
    expect(await resolvePath({ height: 1, kind: null, suffix: null }, load)).toBeNull();
    expect(await resolvePath({ height: 1, kind: null, suffix: null }, async () => null)).toBeNull();
  });
  it('turns an old ?parent= link into the short path that selects it', async () => {
    expect(await shortPathForParent(recent.parent, load)).toBe('/forks/976000');
    expect(await shortPathForParent(oldOther.parent, load)).toBe('/forks/976000/other-chain');
    expect(await shortPathForParent(older.parent, load, 'all')).toBe('/forks/950000');
    expect(await shortPathForParent('ff'.repeat(32), load)).toBeNull();
  });
});

describe('link-preview text', () => {
  it('names the kind, height and pools', () => {
    const e = ep('stale', 976175, { pools: Array.from({ length: 7 }, (_, i) => ({ pool: `P${i}` })), templates: 1234, duration_ms: 72_000 });
    expect(episodeTitle(e)).toBe('Race at 976,175 · 7 pools · stratum.work');
    expect(episodeDescription(e)).toBe('Height 976,175: 7 pools built on a stale block we recorded for 72s (1,234 templates).');
    expect(episodeTitle(ep('bitcoin_block', 5))).toBe('Unrecorded block at 5 · 1 pool · stratum.work');
    expect(episodeDescription(ep('other_chain', 5, { duration_ms: 600_000, templates: 1 })))
      .toBe("Height 5: 1 pool built on another chain's block for 10m (1 template).");
    expect(episodeDescription(ep('invalid_coinbase', 5, { templates: 3 })))
      .toBe('Height 5: 1 pool sent templates whose coinbase pays more than the block can (3 templates).');
  });
});

describe('pagePath (the address the page writes)', () => {
  it('reopens the same episode on reload whichever range the page shows', async () => {
    // 6e has A alone at h; all also has B, which ranks first there: B's bare path would reload to A
    const A = ep('stale', 500), B = ep('invalid_parent', 500), C = ep('other_chain', 500), D = ep('other_chain', 501);
    const ranges: Record<ShareRange, ShareEpisode[]> = { '6e': [A, D], '26e': [A, D], all: [A, B, C, D] };
    const load = async (r: ShareRange) => ranges[r];
    for (const range of ['6e', '26e', 'all'] as ShareRange[]) {
      for (const e of ranges[range]) {
        const path = pagePath(e, ranges[range], range);
        const r = await resolvePath(parseForksPath(path.split('/').slice(2))!, load);
        expect(r?.episode, `${range} ${path}`).toBe(e);
      }
    }
    expect(pagePath(A, ranges['6e'], '6e')).toBe('/forks/500');
    expect(pagePath(D, ranges.all, 'all')).toBe('/forks/501');   // alone at its height
    expect(pagePath(B, ranges.all, 'all')).toBe(`/forks/500/invalid-parent-${B.parent.slice(-8)}`);
    // the bare path the page would have written without this rule opens A, not B
    expect((await resolvePath(parseForksPath(['500'])!, load))?.episode).toBe(A);
  });
});
