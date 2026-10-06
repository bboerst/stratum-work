import type { LayoutItem } from './layout';
import { evidenceCardVisual } from './EvidenceCard';
import { pairSimilarityGridVisual } from './PairSimilarityGrid';
import { tipSwitchWavefrontVisual } from './TipSwitchWavefront';

export type WsAction =
  | { type: 'add'; item: LayoutItem } | { type: 'remove'; index: number }
  | { type: 'move'; index: number; dir: -1 | 1 } | { type: 'params'; index: number; p: Record<string, unknown> }
  | { type: 'scope'; index: number; s: LayoutItem['s'] } | { type: 'replace'; items: LayoutItem[] };

const inRange = (items: readonly LayoutItem[], i: number) => Number.isInteger(i) && i >= 0 && i < items.length;

/** Immutable; out-of-range indices (and moves past either edge) return the input array unchanged. */
export function wsReducer(items: LayoutItem[], a: WsAction): LayoutItem[] {
  switch (a.type) {
    case 'add': return items.concat([a.item]);
    case 'replace': return a.items.slice();
    case 'remove': return inRange(items, a.index) ? items.filter((_, i) => i !== a.index) : items;
    case 'move': {
      const j = a.index + a.dir;
      if (!inRange(items, a.index) || !inRange(items, j)) return items;
      const out = items.slice();
      out[a.index] = items[j];
      out[j] = items[a.index];
      return out;
    }
    case 'params': return inRange(items, a.index) ? items.map((it, i) => (i === a.index ? { ...it, p: a.p } : it)) : items;
    case 'scope': return inRange(items, a.index) ? items.map((it, i) => (i === a.index ? { ...it, s: a.s } : it)) : items;
    default: return items;
  }
}

/** Layout plus client-only stable ids (React keys) kept in step with `items`; ids never enter the URL. */
export interface KeyedWorkspace { items: LayoutItem[]; ids: number[]; next: number }

export const keyWorkspace = (items: LayoutItem[]): KeyedWorkspace => ({ items, ids: items.map((_, i) => i), next: items.length });

export function keyedWsReducer(state: KeyedWorkspace, a: WsAction): KeyedWorkspace {
  const items = wsReducer(state.items, a);
  if (items === state.items) return state;
  switch (a.type) {
    case 'add': return { items, ids: state.ids.concat([state.next]), next: state.next + 1 };
    case 'replace': return { items, ids: items.map((_, i) => state.next + i), next: state.next + items.length };
    case 'remove': return { items, ids: state.ids.filter((_, i) => i !== a.index), next: state.next };
    case 'move': {
      const ids = state.ids.slice();
      const j = a.index + a.dir;
      ids[a.index] = state.ids[j];
      ids[j] = state.ids[a.index];
      return { items, ids, next: state.next };
    }
    default: return { items, ids: state.ids, next: state.next };
  }
}

const live = (v: { id: string; defaultParams: object }): LayoutItem => ({ v: v.id, s: { kind: 'live' }, p: { ...v.defaultParams } as Record<string, unknown> });

export const DEFAULT_WORKSPACE: LayoutItem[] = [live(evidenceCardVisual), live(pairSimilarityGridVisual), live(tipSwitchWavefrontVisual)];
