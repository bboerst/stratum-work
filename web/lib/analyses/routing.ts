import type { RoutingStatus } from '@/lib/templates/types';

/** Last status per site (input order = arrival order), sorted by site. */
export function latestRoutingBySite(rs: RoutingStatus[]): RoutingStatus[] {
  const bySite = new Map<string, RoutingStatus>();
  for (const r of rs) bySite.set(r.site, r);
  return Array.from(bySite.values()).sort((a, b) => a.site.localeCompare(b.site));
}

/** Totals across sites; workers merged by name (ths summed, earliest since), sorted by ths desc. */
export function donatedTotals(rs: RoutingStatus[]): {
  totalThs: number;
  bySite: { site: string; ths: number }[];
  workers: { name: string; ths: number; since: string }[];
} {
  const workers = new Map<string, { name: string; ths: number; since: string }>();
  for (const r of rs) {
    for (const w of r.workers) {
      const cur = workers.get(w.name);
      workers.set(w.name, cur
        ? { name: w.name, ths: cur.ths + w.ths, since: cur.since < w.since ? cur.since : w.since }
        : { name: w.name, ths: w.ths, since: w.since });
    }
  }
  return {
    totalThs: rs.reduce((a, r) => a + r.total_ths, 0),
    bySite: rs.map(r => ({ site: r.site, ths: r.total_ths })),
    workers: Array.from(workers.values()).sort((a, b) => b.ths - a.ths || a.name.localeCompare(b.name)),
  };
}
