/**
 * #212: MongoDB-mode block reads skip documents the backend flagged `stale: true` (a block a reorg replaced) and pick
 * deterministically when two unflagged documents share a height. $runCommandRaw is replaced by a small evaluator of
 * the `find` subset these reads use (height comparisons, `$ne`, sort, limit) over fixture documents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Doc = { _id: number; height: number; block_hash: string; timestamp: number; stale?: boolean; analysis?: object };
type Cond = number | boolean | Record<string, unknown>;

const DOCS: Doc[] = [
  { _id: 1, height: 100, block_hash: 'a100', timestamp: 1 },
  { _id: 2, height: 101, block_hash: 'loser101', timestamp: 2, stale: true, analysis: { flags: [1] } },
  { _id: 3, height: 102, block_hash: 'loser102', timestamp: 3, stale: true },   // a stale tip above the best one
  { _id: 4, height: 101, block_hash: 'winner101', timestamp: 4, analysis: { flags: [1] } },
  { _id: 5, height: 99, block_hash: 'old99', timestamp: 0, stale: true },
  { _id: 6, height: 99, block_hash: 'a99', timestamp: 0 },
];

function matches(doc: Doc, filter: Record<string, Cond>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$expr') return true;   // getInterestingBlocks' "more than pool identification" test: not modelled
    if (key === 'analysis') return doc.analysis !== undefined;
    const v = (doc as Record<string, unknown>)[key];
    if (typeof cond !== 'object' || cond === null) return v === cond;
    return Object.entries(cond).every(([op, x]) => {
      const n = v as number;
      switch (op) {
        case '$ne': return v !== x;
        case '$gt': return n > (x as number);
        case '$gte': return n >= (x as number);
        case '$lt': return n < (x as number);
        case '$lte': return n <= (x as number);
        default: throw new Error(`operator ${op} not modelled`);
      }
    });
  });
}

const commands: Record<string, unknown>[] = [];

function runCommandRaw(cmd: { find: string; filter: Record<string, Cond>; sort?: Record<string, 1 | -1>; limit?: number }) {
  commands.push(cmd);
  let docs = DOCS.filter(d => matches(d, cmd.filter));
  if (cmd.sort) {
    const keys = Object.entries(cmd.sort);
    docs = [...docs].sort((a, b) => {
      for (const [k, dir] of keys) {
        const d = ((a as unknown as Record<string, number>)[k] - (b as unknown as Record<string, number>)[k]) * dir;
        if (d) return d;
      }
      return 0;
    });
  }
  if (cmd.limit) docs = docs.slice(0, cmd.limit);
  return { ok: 1, cursor: { firstBatch: docs.map(d => ({ ...d, _id: { toString: () => String(d._id) } })) } };
}

async function load() {
  vi.resetModules();
  vi.stubEnv('DB_BACKEND', 'mongodb');
  vi.doMock('../db/prisma', () => ({ prisma: { $runCommandRaw: vi.fn(async (c: never) => runCommandRaw(c)) } }));
  return import('../db/blocks');
}

beforeEach(() => { commands.length = 0; });
afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('../db/prisma'); });

describe('MongoDB best-chain block reads', () => {
  it('block by height returns the unflagged block', async () => {
    const blocks = await load();
    expect((await blocks.getBlockByHeight(101))?.block_hash).toBe('winner101');
    expect((await blocks.getBlockByHeight(99))?.block_hash).toBe('a99');
    expect(await blocks.getBlockByHeight(102)).toBeNull();
  });

  it('two unflagged documents at one height: the newest wins, every time', async () => {
    const blocks = await load();
    DOCS.push({ _id: 7, height: 100, block_hash: 'b100', timestamp: 7 });
    try {
      expect((await blocks.getBlockByHeight(100))?.block_hash).toBe('b100');
    } finally {
      DOCS.pop();
    }
  });

  it('the tip and the lowest block skip stale documents', async () => {
    const blocks = await load();
    expect((await blocks.getHighestBlock())?.height).toBe(101);
    expect((await blocks.getHighestBlock())?.block_hash).toBe('winner101');
    expect((await blocks.getLowestBlock())?.block_hash).toBe('a99');
  });

  it('block lists (latest, before, after, around a height) skip stale documents', async () => {
    const blocks = await load();
    const hashes = (r: { blocks: { block_hash: string }[] }) => r.blocks.map(b => b.block_hash).sort();
    expect(hashes(await blocks.getBlocks(10))).toEqual(['a100', 'a99', 'winner101']);
    expect(hashes(await blocks.getBlocks(10, 101))).toEqual(['a100', 'a99', 'winner101']);
    expect(hashes(await blocks.getBlocks(10, undefined, undefined, 99))).toEqual(['a100', 'winner101']);
    expect(hashes(await blocks.getBlocks(10, undefined, 101))).toEqual(['a100', 'a99', 'winner101']);
  });

  it('interesting blocks skip stale documents', async () => {
    const blocks = await load();
    expect((await blocks.getInterestingBlocks()).map(b => b.block_hash)).toEqual(['winner101']);
  });

  it('a lookup by hash still finds a stale block', async () => {
    const blocks = await load();
    expect((await blocks.getBlockByHash('loser101'))?.block_hash).toBe('loser101');
    expect(commands.at(-1)).toMatchObject({ filter: { block_hash: 'loser101' } });
  });
});
