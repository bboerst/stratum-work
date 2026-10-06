import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { insertRouting, insertTemplates } from '../db.js';
import { messageToTemplateRow } from '../serialize.js';
import { toRawMessage } from '../message.js';
import { StreamState } from '../server.js';
import { warmUp } from '../warmup.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('warmUp', () => {
  it('loads recent templates, routing and blocks into the rings with rx from the row timestamp', async () => {
    const db = new pg.Pool({ connectionString: url });
    const pool = `WarmUp-${process.pid}-${Date.now()}`;
    const tsMs = Date.now() - 60_000;
    const hexNs = (ms: number) => (BigInt(ms) * 1_000_000n).toString(16);
    const doc = { timestamp: hexNs(tsMs), pool_name: pool, height: 1, job_id: 'j', prev_hash: 'p', coinbase1: 'a', coinbase2: 'b', merkle_branches: [], version: 'v', nbits: 'n', ntime: 't', clean_jobs: false, extranonce1: 'e', extranonce2_length: 4 };
    const tplMsg = toRawMessage(Buffer.from(JSON.stringify(doc)), tsMs)!;
    const routingMsg = toRawMessage(Buffer.from(JSON.stringify({ type: 'routing', site: pool, timestamp: hexNs(tsMs + 1000) })), 0)!;
    const height = 2_000_000_000 - (process.pid % 1000);
    const blockTs = Math.floor(Date.now() / 1000) - 30;
    try {
      await insertTemplates(db, [messageToTemplateRow(tplMsg)]);
      await insertRouting(db, [routingMsg]);
      await db.query(`INSERT INTO blocks (height, block_hash, timestamp) VALUES ($1, $2, $3)`, [height, `hash-${pool}`, blockTs]);

      const state = new StreamState({ historyMinutes: 60, blacklist: () => false });
      await warmUp(db, state, Date.now() - 60 * 60_000);
      const all = state.ring.since(-1).map(i => ({ ...i, json: JSON.parse(i.body) }));

      const t = all.find(m => m.kind === 'template' && m.json.pool_name === pool)!;
      expect(t.rx).toBe(tsMs);
      expect(t.mid).toBe(tplMsg.mid);
      expect(t.json).toEqual(doc);

      const r = all.find(m => m.kind === 'routing' && m.json.site === pool)!;
      expect(r.rx).toBe(tsMs + 1000);
      expect(r.mid).toBe(routingMsg.mid);

      const b = all.find(m => m.kind === 'block' && m.json.id === `hash-${pool}`)!;
      expect(b.rx).toBe(blockTs * 1000);
      expect(state.legacyRing.since(-1).some(m => m.mid === b.mid)).toBe(true);
    } finally {
      await db.query(`DELETE FROM templates WHERE pool = $1`, [pool]);
      await db.query(`DELETE FROM routing WHERE site = $1`, [pool]);
      await db.query(`DELETE FROM blocks WHERE height = $1`, [height]);
      await db.end();
    }
  });
});
