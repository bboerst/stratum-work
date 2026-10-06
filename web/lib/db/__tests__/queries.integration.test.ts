import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('web queries against Postgres', () => {
  const tag = randomBytes(4).toString('hex');
  const pool = `webtest-${tag}`;
  const baseHeight = 1_900_000_000 + (parseInt(tag, 16) % 50_000_000);
  const nowMs = Date.now();
  const tsNs = (ms: number) => (BigInt(ms) * BigInt(1_000_000)).toString();
  let getPool: typeof import('../pg').getPool;

  const insertTemplate = (mid: string, ms: number, over: Record<string, unknown> = {}) => {
    const r = {
      ts: new Date(ms), ts_ns: tsNs(ms), mid: Buffer.from(mid.padEnd(32, '0'), 'hex'), doc_id: null, pool, connection_id: pool,
      site: 'us-ash-legacy', mode: 'observe', height: baseHeight, prev_hash: 'p', job_id: 'j', version: 'v', nbits: 'n', ntime: 't',
      clean_jobs: false, coinbase1: 'a', coinbase2: 'b', extranonce1: 'e', extranonce2_length: 4, merkle_branches: ['m1'],
      chain_family: null, lat_ms: 1.5, lat_m: 'tcp', ...over,
    };
    const cols = Object.keys(r);
    return getPool().query(
      `INSERT INTO templates (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(r),
    );
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ getPool } = await import('../pg'));
    const db = getPool();
    for (const h of [baseHeight, baseHeight + 1, baseHeight + 2]) {
      await db.query(
        `INSERT INTO blocks (height, block_hash, timestamp, mining_pool, analysis, version, nonce, transactions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [h, `${tag}-${h}`, 1700000000 + h - baseHeight, JSON.stringify({ id: 1, name: pool }),
          h === baseHeight + 1 ? JSON.stringify({ empty_block: true, pool_identification: {} }) : JSON.stringify({ pool_identification: {} }),
          536870912, 4000000000, 10],
      );
    }
    await insertTemplate(`${tag}01`, nowMs - 2000);
    await insertTemplate(`${tag}02`, nowMs - 1000, { pool: `${pool}-b`, connection_id: `${pool}-b`, lat_ms: null });
    await insertTemplate(`${tag}03`, nowMs - 500);
    await insertTemplate(`${tag}04`, nowMs - 3000, { mode: 'work', site: 'us-ash-1', connection_id: `${pool}/work` });
    await insertTemplate(`${tag}05`, nowMs - 3000, { chain_family: 'bch' });
  });

  afterAll(async () => {
    if (!getPool) return;
    const db = getPool();
    await db.query('DELETE FROM templates WHERE pool LIKE $1', [`${pool}%`]);
    await db.query('DELETE FROM blocks WHERE block_hash LIKE $1', [`${tag}-%`]);
    await db.end();
  });

  it('getBlocks / getBlockByHeight read blocks', async () => {
    const { getBlocks, getBlockByHeight } = await import('../blocks');
    const res = await getBlocks(2, baseHeight + 2);
    expect(res.blocks.map(b => b.height)).toEqual([baseHeight + 2, baseHeight + 1]);
    expect(res.has_more).toBe(true);
    const b = await getBlockByHeight(baseHeight);
    expect(b).toMatchObject({ height: baseHeight, block_hash: `${tag}-${baseHeight}`, timestamp: 1700000000, version: 536870912, nonce: 4000000000, transactions: 10 });
    expect(b?.mining_pool).toMatchObject({ id: 1, name: pool });
  });

  it('getInterestingBlocks excludes pool_identification-only analysis', async () => {
    const { getInterestingBlocks } = await import('../blocks');
    const items = await getInterestingBlocks(200);
    const mine = items.filter(i => i.block_hash.startsWith(`${tag}-`));
    expect(mine.map(i => i.height)).toEqual([baseHeight + 1]);
  });

  it('getMiningNotifyByHeight returns observe-mode bitcoin rows in ts order', async () => {
    const { getMiningNotifyByHeight } = await import('../mining-notify');
    const docs = await getMiningNotifyByHeight(baseHeight);
    expect(docs.map(d => d.id)).toEqual([`${tag}01`, `${tag}02`, `${tag}03`].map(m => m.padEnd(32, '0')));
    expect(docs[0]).toMatchObject({ pool_name: pool, timestamp: BigInt(tsNs(nowMs - 2000)).toString(16), merkle_branches: ['m1'], lat_ms: 1.5 });
    expect(docs[0]).not.toHaveProperty('site');
  });

  it('getBlockPoolFirstSeen returns earliest per pool', async () => {
    const { getBlockPoolFirstSeen } = await import('../mining-notify');
    expect(await getBlockPoolFirstSeen(baseHeight)).toEqual([
      { poolName: pool, firstSeenTimestamp: BigInt(tsNs(nowMs - 2000)).toString(16), firstSeenLatencyMs: 1.5 },
      { poolName: `${pool}-b`, firstSeenTimestamp: BigInt(tsNs(nowMs - 1000)).toString(16), firstSeenLatencyMs: null },
    ]);
  });

  it('getTemplatesInRange includes all modes within [from, to)', async () => {
    const { getTemplatesInRange } = await import('../mining-notify');
    const docs = (await getTemplatesInRange(nowMs - 3000, nowMs - 500)).filter(d => d.pool_name.startsWith(pool));
    expect(docs).toHaveLength(4);
    expect(docs.some(d => d.mode === 'work')).toBe(true);
  });
});
