/**
 * /api/tx and /api/tx/<txid> against a mocked lookup (#198): input validation, the batch cap, cache headers, the
 * per-txid server cache, and MongoDB mode answering without a database. The real queries: pgTx.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TxInfo } from '../db/tx';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);

const answer = (txid: string): TxInfo =>
  txid === A ? { txid, found: true, status: 'in_mempool', effective_fee_rate: 12.5 }
    : txid === B ? { txid, found: true, status: 'mined', effective_fee_rate: 3 }
      : { txid, found: false, status: 'not_seen' };

async function loadRoutes({ historical = true, backend = 'postgres' } = {}) {
  vi.resetModules();
  vi.stubEnv('DB_BACKEND', backend);
  const getTxs = vi.fn(async (txids: string[]) => txids.map(answer));
  vi.doMock('../db/blocks', () => ({ enableHistoricalData: historical }));
  vi.doMock('../db/tx', async importOriginal => ({ ...(await importOriginal<object>()), getTxs }));
  const batch = await import('../../app/api/tx/route');
  const single = await import('../../app/api/tx/[txid]/route');
  return {
    getTxs,
    batch: (qs: string) => batch.GET(new Request(`http://localhost/api/tx${qs}`)),
    single: (txid: string) => single.GET(new Request(`http://localhost/api/tx/${txid}`), { params: Promise.resolve({ txid }) }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../db/blocks');
  vi.doUnmock('../db/tx');
});

describe('GET /api/tx', () => {
  it('answers each txid in request order, deduplicated and lower-cased', async () => {
    const { batch, getTxs } = await loadRoutes();
    const resp = await batch(`?txids=${A},${C.toUpperCase()},${A}`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.supported).toBe(true);
    expect(body.txs.map((t: TxInfo) => [t.txid, t.status])).toEqual([[A, 'in_mempool'], [C, 'not_seen']]);
    expect(getTxs).toHaveBeenCalledWith([A, C], undefined);
  });

  it('caches for the shortest-lived answer', async () => {
    const { batch } = await loadRoutes();
    expect((await batch(`?txids=${B}`)).headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect((await batch(`?txids=${A},${B}`)).headers.get('Cache-Control')).toBe('public, max-age=30');
    expect((await batch(`?txids=${A},${B},${C}`)).headers.get('Cache-Control')).toBe('public, max-age=10');
  });

  it('reads each txid from the database once while its answer is fresh', async () => {
    const { batch, getTxs } = await loadRoutes();
    await batch(`?txids=${A},${B}`);
    await batch(`?txids=${B},${C}`);
    expect(getTxs.mock.calls).toEqual([[[A, B], undefined], [[C], undefined]]);
  });

  it('rejects bad input and more than 100 txids', async () => {
    const { batch, getTxs } = await loadRoutes();
    for (const qs of ['', '?txids=', '?txids=xyz', `?txids=${A.slice(2)}`, `?txids=${A}00`, `?txids=${A},g${A.slice(1)}`]) {
      const resp = await batch(qs);
      expect(resp.status, qs).toBe(400);
      expect(resp.headers.get('Cache-Control')).toBe('no-store');
    }
    const many = Array.from({ length: 101 }, (_, i) => i.toString(16).padStart(64, '0')).join(',');
    expect((await batch(`?txids=${many}`)).status).toBe(400);
    const hundred = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(64, '0')).join(',');
    expect((await batch(`?txids=${hundred}`)).status).toBe(200);
    expect(getTxs).toHaveBeenCalledTimes(1);
  });

  it('passes `at` (rounded up to the hour) to the lookup and caches per time', async () => {
    const { batch, getTxs } = await loadRoutes();
    const t = Date.UTC(2026, 0, 1, 10, 20);
    await batch(`?txids=${A}&at=${t}`);
    await batch(`?txids=${A}&at=${t + 60_000}`);   // same hour: cached
    await batch(`?txids=${A}`);                     // now: another entry
    expect(getTxs.mock.calls).toEqual([[[A], Date.UTC(2026, 0, 1, 11)], [[A], undefined]]);
    for (const at of ['x', '1.5', '1000', '-1']) expect((await batch(`?txids=${A}&at=${at}`)).status, at).toBe(400);
  });

  it('answers 500 without caching when the database fails', async () => {
    const { batch, getTxs } = await loadRoutes();
    getTxs.mockRejectedValueOnce(new Error('connection refused'));
    const resp = await batch(`?txids=${A}`);
    expect(resp.status).toBe(500);
    expect(resp.headers.get('Cache-Control')).toBe('no-store');
    expect((await batch(`?txids=${A}`)).status).toBe(200);
  });

  it('touches no database in MongoDB mode or with history disabled', async () => {
    for (const opts of [{ backend: 'mongodb' }, { historical: false }]) {
      const { batch, single, getTxs } = await loadRoutes(opts);
      const body = await (await batch(`?txids=${A}`)).json();
      expect(body.supported).toBe(false);
      expect(body.txs).toEqual([]);
      expect((await (await single(A)).json()).tx).toBeNull();
      expect(getTxs).not.toHaveBeenCalled();
    }
  });
});

describe('GET /api/tx/<txid>', () => {
  it('answers one transaction', async () => {
    const { single } = await loadRoutes();
    const resp = await single(B);
    expect(resp.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect((await resp.json()).tx).toMatchObject({ txid: B, found: true, status: 'mined' });
  });

  it('rejects bad input', async () => {
    const { single } = await loadRoutes();
    expect((await single('nope')).status).toBe(400);
    expect((await single(`${A},${B}`)).status).toBe(400);
  });
});
