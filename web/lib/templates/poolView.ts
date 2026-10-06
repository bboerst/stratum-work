import type { PoolTimelineEntry, Template } from './types';

export function buildPoolView(templates: readonly Template[]): PoolTimelineEntry[] {
  const sorted = [...templates].sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  const lastContent = new Map<string, string>();
  const latestByKey = new Map<string, PoolTimelineEntry>();
  const out: PoolTimelineEntry[] = [];
  for (const t of sorted) {
    if (lastContent.get(t.connectionId) === t.contentKey) continue;
    lastContent.set(t.connectionId, t.contentKey);
    const open = latestByKey.get(t.contentKey);
    if (open && !open.arrivals.some(a => a.connectionId === t.connectionId)) {
      open.arrivals.push({ connectionId: t.connectionId, site: t.site, mode: t.mode, receivedAtMs: t.receivedAtMs, offsetMs: t.receivedAtMs - open.template.receivedAtMs });
      continue;
    }
    const e: PoolTimelineEntry = { template: t, arrivals: [{ connectionId: t.connectionId, site: t.site, mode: t.mode, receivedAtMs: t.receivedAtMs, offsetMs: 0 }] };
    latestByKey.set(t.contentKey, e);
    out.push(e);
  }
  return out;
}
