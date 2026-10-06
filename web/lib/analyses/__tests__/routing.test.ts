import { describe, expect, it } from 'vitest';
import { donatedTotals, latestRoutingBySite } from '../routing';
const r = (site: string, total: number, workers: { name: string; ths: number; since: string }[]) => ({ type: 'routing' as const, site, timestamp: 't', total_ths: total, targets: [], remainder: { id: 'datum', delivered_ths: 0, fallback_active: false }, workers });

describe('routing', () => {
  it('sums sites and merges workers by name', () => {
    const t = donatedTotals(latestRoutingBySite([r('us', 10, [{ name: 'w', ths: 4, since: '2026-01-02' }]), r('eu', 5, [{ name: 'w', ths: 1, since: '2026-01-01' }, { name: 'z', ths: 9, since: '2026-01-03' }])]));
    expect(t.totalThs).toBe(15);
    expect(t.bySite.map(s => s.site)).toEqual(['eu', 'us']);
    expect(t.workers).toEqual([{ name: 'z', ths: 9, since: '2026-01-03' }, { name: 'w', ths: 5, since: '2026-01-01' }]);
  });
});
