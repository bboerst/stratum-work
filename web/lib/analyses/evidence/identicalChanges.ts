import { getChangeColorTokens, TemplateChangeType } from '@/utils/templateChangeDetection';
import type { TemplateChangeResult } from '@/utils/templateChangeDetection';
import { bits } from '../stats';
import { pairKey, type EvidenceChannel, type Observation } from './types';

const EXCLUDED = new Set<string>([TemplateChangeType.PREV_HASH, TemplateChangeType.HEIGHT, TemplateChangeType.CLEAN_JOBS]);

/** Content key of a change, ignoring tip-switch fields (prevHash, height, clean jobs). Empty when nothing else changed. */
export function changeKey(c: TemplateChangeResult | undefined): string {
  if (!c?.hasChanges) return '';
  return getChangeColorTokens(c).filter(t => !EXCLUDED.has(t.type)).map(t => t.contentKey).join('|');
}

interface ChangeEvent { key: string; pool: string; t: number }

export const identicalChanges: EvidenceChannel = {
  id: 'identicalChanges',
  observe({ timelines }, p) {
    const events: ChangeEvent[] = [];
    const times: [string, number[]][] = [];
    timelines.forEach((es, pool) => {
      times.push([pool, es.map(e => e.template.receivedAtMs)]);
      for (const e of es) {
        const key = changeKey(e.template.change);
        if (key) events.push({ key, pool, t: e.template.receivedAtMs });
      }
    });
    events.sort((a, b) => a.t - b.t);
    const active = (t: number) =>
      times.filter(([, ts]) => ts.some(x => x <= t && x >= t - p.staleMs)).map(([pl]) => pl).sort();
    const byKey = new Map<string, ChangeEvent[]>();
    for (const e of events) {
      const arr = byKey.get(e.key) ?? [];
      arr.push(e);
      byKey.set(e.key, arr);
    }
    const observations: Observation[] = [];
    const comparable = new Map<string, number>();
    byKey.forEach((evs, key) => {
      let i = 0;
      while (i < evs.length) {
        const t0 = evs[i].t, members = new Set<string>();
        let j = i;
        while (j < evs.length && evs[j].t - t0 <= p.changeWindowMs) { members.add(evs[j].pool); j++; }
        i = j;
        const act = active(t0 + p.changeWindowMs);
        const n = act.length, k = members.size;
        for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
          if (members.has(act[a]) || members.has(act[b])) {
            const pk = pairKey(act[a], act[b]);
            comparable.set(pk, (comparable.get(pk) ?? 0) + 1);
          }
        }
        // Single-pool clusters stay as 0-bit observations so the evidence card can list a pool's unique changes.
        observations.push({ pools: Array.from(members).sort(), bits: k >= 2 ? bits(k, n) : 0, atMs: t0, detail: { key } });
      }
    });
    return { observations, comparable };
  },
};
