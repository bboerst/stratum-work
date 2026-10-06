import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { insertTemplates } from '../db.js';
import { messageToTemplateRow } from '../serialize.js';
import { toRawMessage } from '../message.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('insertTemplates', () => {
  it('is idempotent on mid', async () => {
    const pool = new pg.Pool({ connectionString: url });
    const doc = { _id: 'x', timestamp: (BigInt(Date.now()) * 1_000_000n).toString(16), pool_name: 'T', height: 1, job_id: 'j', prev_hash: 'p', coinbase1: 'a', coinbase2: 'b', merkle_branches: [], version: 'v', nbits: 'n', ntime: 't', clean_jobs: false, extranonce1: 'e', extranonce2_length: 4 };
    const row = messageToTemplateRow(toRawMessage(Buffer.from(JSON.stringify(doc)), Date.now())!);
    expect(await insertTemplates(pool, [row])).toBe(1);
    expect(await insertTemplates(pool, [row])).toBe(0);
    await pool.end();
  });
});
