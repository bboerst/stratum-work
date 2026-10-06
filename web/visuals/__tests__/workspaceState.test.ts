import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE, keyWorkspace, keyedWsReducer, wsReducer } from '../workspaceState';
const it1 = { v: 'a', s: { kind: 'live' as const }, p: {} }, it2 = { v: 'b', s: { kind: 'live' as const }, p: {} };

describe('wsReducer', () => {
  it('add, move, remove, params', () => {
    let s = wsReducer([], { type: 'add', item: it1 });
    s = wsReducer(s, { type: 'add', item: it2 });
    s = wsReducer(s, { type: 'move', index: 1, dir: -1 });
    expect(s.map(i => i.v)).toEqual(['b', 'a']);
    expect(wsReducer(s, { type: 'move', index: 0, dir: -1 })).toBe(s); // no-op at edge returns same array
    s = wsReducer(s, { type: 'params', index: 1, p: { x: 1 } });
    expect(s[1].p).toEqual({ x: 1 });
    expect(wsReducer(s, { type: 'remove', index: 0 }).map(i => i.v)).toEqual(['a']);
  });

  it('out-of-range indices return the input unchanged; scope and replace are immutable', () => {
    const s = [it1, it2];
    expect(wsReducer(s, { type: 'remove', index: 5 })).toBe(s);
    expect(wsReducer(s, { type: 'move', index: 1, dir: 1 })).toBe(s);
    expect(wsReducer(s, { type: 'params', index: -1, p: {} })).toBe(s);
    const t = wsReducer(s, { type: 'scope', index: 0, s: { kind: 'height', height: 900000 } });
    expect(t[0].s).toEqual({ kind: 'height', height: 900000 });
    expect(s[0].s).toEqual({ kind: 'live' });
    const r = wsReducer(s, { type: 'replace', items: [it2] });
    expect(r.map(i => i.v)).toEqual(['b']);
  });

  it('DEFAULT_WORKSPACE is evidence card, pair grid, tip-switch wavefront on live scope', () => {
    expect(DEFAULT_WORKSPACE.map(i => i.v)).toEqual(['evidence-card', 'pair-similarity-grid', 'tip-switch-wavefront']);
    for (const i of DEFAULT_WORKSPACE) expect(i.s).toEqual({ kind: 'live' });
    expect(DEFAULT_WORKSPACE[2].p).toEqual({ blocks: 12 });
  });

  it('keyed reducer keeps a stable id per item across move/remove/add', () => {
    let k = keyWorkspace([it1, it2, it1]);
    expect(k.ids).toEqual([0, 1, 2]);
    k = keyedWsReducer(k, { type: 'move', index: 0, dir: 1 });
    expect(k.ids).toEqual([1, 0, 2]);
    expect(k.items.map(i => i.v)).toEqual(['b', 'a', 'a']);
    k = keyedWsReducer(k, { type: 'remove', index: 0 });
    expect(k.ids).toEqual([0, 2]);
    k = keyedWsReducer(k, { type: 'add', item: it2 });
    expect(k.ids).toEqual([0, 2, 3]);
    const same = keyedWsReducer(k, { type: 'remove', index: 9 });
    expect(same).toBe(k);
    k = keyedWsReducer(k, { type: 'replace', items: [it1] });
    expect(k.ids).toEqual([4]);
    k = keyedWsReducer(k, { type: 'params', index: 0, p: { x: 1 } });
    expect(k.ids).toEqual([4]);
  });
});
