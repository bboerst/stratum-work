/**
 * The shared per-epoch read of the template-set counts (lib/db/template-providers.ts, readEpochRows) against a fake
 * database: a cold read reads every epoch, then only the epochs whose fingerprint (counted heights, latest filled_at)
 * changed (the current epoch filling, a new epoch, the history walk or a re-count reaching an older one) are read
 * again, the others reused; an epoch gone from template_set_heights is dropped; another exclusion (names, or the ids
 * they name) reads everything again; concurrent callers share one refresh; a failure serves the last good rows and
 * the next read retries; with none yet it throws. Both consumers (getTemplateProviderInputs, getEpochGroupInputs) read
 * from it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const E = 480, EB = 2016;
interface Db {
  heights: Map<number, string>;                      // height -> filled_at
  feeds: { height: number; feed: string; pool_id: number | null; sets: number; templates: number }[];
  pairs: { height: number; feed_a: string; pool_a: number | null; feed_b: string; pool_b: number | null; shared: number }[];
  pools: { id: number; name: string }[];
  fail: boolean;
  reads: [number, number][];                          // the [from, to) height ranges of the node reads
  fingerprints: number;
}
let db: Db;
let clock = 0;
const fill = (h: number, feed = 'f1', sets = 10) => {
  db.heights.set(h, `t${String(++clock).padStart(6, '0')}`);
  db.feeds = db.feeds.filter(r => r.height !== h);
  db.feeds.push({ height: h, feed, pool_id: 1, sets, templates: sets });
  db.pairs = db.pairs.filter(r => r.height !== h);
  db.pairs.push({ height: h, feed_a: feed, pool_a: 1, feed_b: 'f2', pool_b: 2, shared: 1 });
};

function fakePool() {
  const sum = <T extends { height: number }>(rows: T[], key: (r: T) => string, val: (r: T) => number[]) => {
    const m = new Map<string, { r: T; v: number[] }>();
    for (const r of rows) {
      const k = `${Math.floor(r.height / EB)}|${key(r)}`;
      const o = m.get(k);
      if (o) val(r).forEach((x, i) => { o.v[i] += x; }); else m.set(k, { r, v: val(r) });
    }
    return [...m.values()];
  };
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (db.fail) throw new Error('timeout');
      if (sql.includes('FROM template_set_heights') && !sql.includes('template_set_feeds')) {
        db.fingerprints++;
        const by = new Map<number, { heights: number; filled: string }>();
        for (const [h, t] of db.heights) {
          const e = Math.floor(h / EB), o = by.get(e) ?? { heights: 0, filled: '' };
          o.heights++; if (t > o.filled) o.filled = t;
          by.set(e, o);
        }
        return { rows: [...by].sort((a, b) => a[0] - b[0]).map(([epoch, o]) => ({ epoch, heights: String(o.heights), filled: o.filled })) };
      }
      if (sql.startsWith('SELECT id FROM pools WHERE name')) {
        const names = params[0] as string[];
        return { rows: db.pools.filter(p => names.includes(p.name)).map(p => ({ id: p.id })) };
      }
      if (sql.includes('FROM blocks_best')) return { rows: [] };
      if (sql.startsWith('SELECT id, name FROM pools')) return { rows: db.pools };
      const [excluded, from, to] = params as [string[], number, number];
      const xp = db.pools.filter(p => excluded.includes(p.name)).map(p => p.id);
      const okPool = (p: number | null) => p === null || !xp.includes(p);
      if (sql.includes('FROM template_set_feeds')) {
        db.reads.push([from, to]);
        const rows = db.feeds.filter(r => r.height >= from && r.height < to && !excluded.includes(r.feed) && okPool(r.pool_id));
        return { rows: sum(rows, r => `${r.feed}|${r.pool_id}`, r => [r.sets, r.templates]).map(({ r, v }) =>
          ({ epoch: Math.floor(r.height / EB), feed: r.feed, pool_id: r.pool_id, sets: String(v[0]), templates: String(v[1]) })) };
      }
      if (sql.includes('FROM template_set_pairs')) {
        const rows = db.pairs.filter(r => r.height >= from && r.height < to && !excluded.includes(r.feed_a)
          && !excluded.includes(r.feed_b) && okPool(r.pool_a) && okPool(r.pool_b));
        return { rows: sum(rows, r => `${r.feed_a}|${r.pool_a}|${r.feed_b}|${r.pool_b}`, r => [r.shared]).map(({ r, v }) =>
          ({ epoch: Math.floor(r.height / EB), feed_a: r.feed_a, pool_a: r.pool_a, feed_b: r.feed_b, pool_b: r.pool_b, shared: String(v[0]) })) };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

async function load() {
  vi.resetModules();
  const pool = fakePool();
  vi.doMock('../db/pg', () => ({ getPgPool: () => pool }));
  return import('../db/template-providers');
}

/** What the epoch read returns, as plain data (the rows sorted). */
const view = (m: Map<number, { heights: number; nodes: unknown[]; pairs: unknown[] }>) =>
  [...m].map(([e, r]) => [e, r.heights, r.nodes.map(x => JSON.stringify(x)).sort(), r.pairs.map(x => JSON.stringify(x)).sort()]);

beforeEach(() => {
  delete (globalThis as { __templateSetEpochs?: unknown }).__templateSetEpochs;
  db = { heights: new Map(), feeds: [], pairs: [], pools: [{ id: 1, name: 'Pool A' }, { id: 2, name: 'Pool B' }, { id: 3, name: 'Hidden' }],
    fail: false, reads: [], fingerprints: 0 };
  for (let e = E; e < E + 3; e++) for (let i = 0; i < 3; i++) fill(e * EB + i);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock('../db/pg');
  vi.restoreAllMocks();
});

describe('readEpochRows', () => {
  it('reads every epoch cold, in one range read, then reuses the ones whose fingerprint is unchanged', async () => {
    const m = await load();
    const cold = await m.readEpochRows([]);
    expect([...cold.keys()]).toEqual([E, E + 1, E + 2]);
    expect(db.reads).toEqual([[E * EB, (E + 3) * EB]]);
    expect(cold.get(E)!.nodes).toEqual([{ epoch: E, feed: 'f1', pool_id: 1, sets: 30, templates: 30 }]);
    db.reads = [];
    const again = await m.readEpochRows([]);
    expect(db.reads).toEqual([]);                                   // fingerprints checked, nothing re-read
    expect(db.fingerprints).toBe(2);
    expect(view(again)).toEqual(view(cold));
  });

  it('re-reads the current epoch when a height is filled, and only it', async () => {
    const m = await load();
    const cold = await m.readEpochRows([]);
    db.reads = [];
    fill((E + 2) * EB + 3);
    const next = await m.readEpochRows([]);
    expect(db.reads).toEqual([[(E + 2) * EB, (E + 3) * EB]]);
    expect(next.get(E + 2)!.heights).toBe(4);
    expect(next.get(E + 2)!.nodes[0].sets).toBe(40);
    expect(next.get(E)!.nodes).toBe(cold.get(E)!.nodes);            // the same rows, not read again
    expect(next.get(E + 1)!.pairs).toBe(cold.get(E + 1)!.pairs);
  });

  it('reads a newly counted epoch (and a backfilled older one) alone', async () => {
    const m = await load();
    await m.readEpochRows([]);
    db.reads = [];
    fill((E + 3) * EB);
    fill((E - 1) * EB + 5);
    const next = await m.readEpochRows([]);
    expect(db.reads).toEqual([[(E - 1) * EB, E * EB], [(E + 3) * EB, (E + 4) * EB]]);
    expect([...next.keys()]).toEqual([E - 1, E, E + 1, E + 2, E + 3]);
  });

  it('re-reads a past epoch re-counted with the same heights (a new filled_at), and drops an epoch no longer counted', async () => {
    const m = await load();
    await m.readEpochRows([]);
    db.reads = [];
    fill(E * EB + 1, 'f1', 99);                                     // re-count: same heights, new rows
    for (const h of [...db.heights.keys()]) if (Math.floor(h / EB) === E + 1) db.heights.delete(h);
    const next = await m.readEpochRows([]);
    expect(db.reads).toEqual([[E * EB, (E + 1) * EB]]);
    expect(next.get(E)!.nodes[0].sets).toBe(10 + 99 + 10);
    expect([...next.keys()]).toEqual([E, E + 2]);
  });

  it('equals a cold read after any sequence of changes', async () => {
    const m = await load();
    await m.readEpochRows(['f9']);
    fill((E + 2) * EB + 7); fill((E + 3) * EB + 1); fill(E * EB, 'f3');
    const warm = await m.readEpochRows(['f9']);
    delete (globalThis as { __templateSetEpochs?: unknown }).__templateSetEpochs;
    expect(view(warm)).toEqual(view(await m.readEpochRows(['f9'])));
  });

  it('reads everything again for another exclusion, and when the excluded names name other pools', async () => {
    const m = await load();
    await m.readEpochRows(['Hidden']);
    db.reads = [];
    const other = await m.readEpochRows(['Pool A']);
    expect(db.reads).toEqual([[E * EB, (E + 3) * EB]]);
    expect(other.get(E)!.nodes).toEqual([]);                        // pool 1's nodes dropped
    db.reads = [];
    db.pools[0].name = 'Pool A (renamed)';                          // the same names now exclude no pool
    const renamed = await m.readEpochRows(['Pool A']);
    expect(db.reads).toEqual([[E * EB, (E + 3) * EB]]);
    expect(renamed.get(E)!.nodes).toHaveLength(1);
  });

  it('drops excluded feeds and pools from what both consumers get', async () => {
    const m = await load();
    fill(E * EB + 10, 'feed-hidden');
    db.pairs.push({ height: E * EB + 11, feed_a: 'f1', pool_a: 1, feed_b: 'f5', pool_b: 3, shared: 4 });   // pays Hidden
    const inputs = await m.getTemplateProviderInputs(['feed-hidden', 'Hidden']);
    const epoch = await m.getEpochGroupInputs([E, E + 7], ['feed-hidden', 'Hidden']);
    for (const out of [inputs, epoch]) {
      expect(JSON.stringify(out.nodes) + JSON.stringify(out.pairs)).not.toMatch(/feed-hidden|"pool_b":3/);
    }
    expect(epoch.counted).toEqual([{ epoch: E, heights: 4 }]);   // E + 7 isn't counted
    expect(inputs.counted.map(c => c.epoch)).toEqual([E, E + 1, E + 2]);
  });

  it('shares one refresh between concurrent callers', async () => {
    const m = await load();
    const [a, b, c] = await Promise.all([m.readEpochRows([]), m.getEpochGroupInputs([E], []), m.getTemplateProviderInputs([])]);
    expect(db.fingerprints).toBe(1);
    expect(db.reads).toHaveLength(1);
    expect(b.nodes).toEqual(a.get(E)!.nodes);
    expect(c.counted).toHaveLength(3);
  });

  it('keeps the last good rows when a refresh fails, and retries on the next read', async () => {
    const m = await load();
    const good = await m.readEpochRows([]);
    fill((E + 2) * EB + 9);
    db.fail = true;
    expect(view(await m.readEpochRows([]))).toEqual(view(good));
    expect(console.error).toHaveBeenCalled();
    db.fail = false;
    db.reads = [];
    const next = await m.readEpochRows([]);
    expect(db.reads).toEqual([[(E + 2) * EB, (E + 3) * EB]]);
    expect(next.get(E + 2)!.heights).toBe(4);
  });

  it('throws when the first read fails (nothing good to serve), and for names it has no rows for', async () => {
    const m = await load();
    db.fail = true;
    await expect(m.readEpochRows([])).rejects.toThrow('timeout');
    db.fail = false;
    await m.readEpochRows([]);
    db.fail = true;
    await expect(m.readEpochRows(['Hidden'])).rejects.toThrow('timeout');
  });
});
