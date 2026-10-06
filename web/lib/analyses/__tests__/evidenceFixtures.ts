import type { PoolTimelineEntry, Template } from '@/lib/templates/types';

export function entry(pool: string, atMs: number, over: Partial<Template> = {}): PoolTimelineEntry {
  const t = {
    mid: `${pool}@${atMs}`, pool, connectionId: pool, site: 's', mode: 'observe', receivedAtMs: atMs, latencyMs: null,
    height: 1, prevHash: 'P1', version: '20000000', cleanJobs: false, merkleBranches: ['a', 'b', 'c'], txCountRange: [4, 8],
    coinbaseOutputs: [], payoutAddresses: [], coinbaseTag: '', coinbaseScriptHex: '', totalOutputSats: 0, feesSats: 0,
    mergeMiningCommitments: {}, identity: { id: null, name: pool, method: 'none' }, raw: {} as never,
    ...over,
  } as Template;
  t.contentKey = over.contentKey ?? `${t.prevHash}|${t.merkleBranches.join(',')}|${JSON.stringify(t.mergeMiningCommitments)}`;
  return { template: t, arrivals: [{ connectionId: pool, site: 's', mode: 'observe', receivedAtMs: atMs, offsetMs: 0 }] };
}

export function timelines(...entries: PoolTimelineEntry[]): Map<string, PoolTimelineEntry[]> {
  const m = new Map<string, PoolTimelineEntry[]>();
  for (const e of entries.sort((a, b) => a.template.receivedAtMs - b.template.receivedAtMs)) {
    const arr = m.get(e.template.pool) ?? [];
    arr.push(e);
    m.set(e.template.pool, arr);
  }
  return m;
}

/** Change result carrying one merkle change with the given branches. */
export function merkleChange(branches: string[]) {
  return { hasChanges: true, changeTypes: ['M'], changeDetails: { merkleBranches: { old: [], new: branches } } } as never;
}
