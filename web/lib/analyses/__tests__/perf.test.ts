import { describe, expect, it } from 'vitest';
import { TemplateStore } from '@/lib/templates/store';
import { computeOverview, DEFAULT_OVERVIEW } from '../overview';
import { makeRealisticRaws } from './perfFixture';

// Budget: the spec targets first render < 1.5 s and no main-thread task > 50 ms. Idle chunking ingests
// 25-item batches, so a 250-item chunk ≤ 50 ms leaves a 10× margin; the overview must fit in the rest.
const NOW = 1_700_000_600_000;
// Wall-clock budgets are for local runs; shared CI runners are 1.5–3× slower, so they are skipped there.
describe.skipIf(!!process.env.CI)('performance budget', () => {
  it('10,000 templates: ingest in chunks ≤ 50 ms each, overview ≤ 1,000 ms', () => {
    const raws = makeRealisticRaws(10_000, 40, NOW);
    const store = new TemplateStore({ retentionMs: 3_600_000, now: () => NOW, schedule: () => 0 });
    let worst = 0;
    for (let i = 0; i < raws.length; i += 250) { const t = performance.now(); store.ingest(raws.slice(i, i + 250)); worst = Math.max(worst, performance.now() - t); }
    const t0 = performance.now();
    const o = computeOverview(store, DEFAULT_OVERVIEW, NOW);
    const overviewMs = performance.now() - t0;
    console.info(`perf: worst ingest chunk ${worst.toFixed(1)} ms, overview ${overviewMs.toFixed(0)} ms, families ${o.families.length}`);
    expect(store.templates()).toHaveLength(10_000);
    expect(worst).toBeLessThan(50);
    expect(overviewMs).toBeLessThan(1000);
    // The fixture has 5 disjoint clone groups; unrelated groups must not merge through accumulated noise.
    expect(o.families.filter(f => f.members.length > 1)).toHaveLength(5);
  }, 30_000);
});
