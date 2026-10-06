import type { BlockData, Template } from '@/lib/templates/types';
import { wilson } from './stats';

export interface ShareRow { name: string; blocks: number; share: number; lo: number; hi: number }
export interface HashrateShares { window: number; total: number; identities: ShareRow[]; notObserved: ShareRow; unavailable: boolean }

export function blockIdentityName(b: BlockData): string | null {
  const n = b.mining_pool?.name;
  return n && n !== 'Unknown' ? n : null;
}

export function poolIdentityMap(templates: readonly Template[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const t of templates) {
    const m = counts.get(t.pool) ?? new Map<string, number>();
    counts.set(t.pool, m);
    if (t.identity.method !== 'none') m.set(t.identity.name, (m.get(t.identity.name) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const pool of Array.from(counts.keys()).sort()) {
    const best = Array.from(counts.get(pool)!).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    out.set(pool, best ? best[0] : pool);
  }
  return out;
}

function row(name: string, k: number, n: number): ShareRow {
  const w = wilson(k, n);
  return { name, blocks: k, share: w.p, lo: w.lo, hi: w.hi };
}

export function hashrateShares(blocks: readonly BlockData[], observedNames: ReadonlySet<string>, window = 1008): HashrateShares {
  const recent = blocks.filter(b => b.height >= 1).sort((a, b) => b.height - a.height).slice(0, window);
  const n = recent.length;
  const by = new Map<string, number>();
  let other = 0;
  for (const b of recent) {
    const nm = blockIdentityName(b);
    if (nm && observedNames.has(nm)) by.set(nm, (by.get(nm) ?? 0) + 1);
    else other++;
  }
  const identities = Array.from(by)
    .map(([nm, k]) => row(nm, k, n))
    .sort((a, b) => b.blocks - a.blocks || a.name.localeCompare(b.name));
  return { window, total: n, identities, notObserved: row('Not observed', other, n), unavailable: n === 0 };
}

export function groupShare(shares: HashrateShares, names: readonly string[]): ShareRow {
  const set = new Set(names);
  const k = shares.identities.filter(r => set.has(r.name)).reduce((a, r) => a + r.blocks, 0);
  return row(names.join(' + '), k, shares.total);
}
