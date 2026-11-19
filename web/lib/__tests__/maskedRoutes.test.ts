/**
 * No raw extranonce1 leaves the web (#105): every route that serves templates, and the live stream, against mocked
 * databases / RabbitMQ with synthetic templates. Each check searches the whole response text for the raw values, so
 * derived fields (coinbaseRaw, ASCII text) are covered too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createMasker, resetConnectionMaskForTests } from '../connectionMask';

const KEY = 'route-test-key';
const mask = createMasker(KEY);
const NOW_MS = Date.now();
const tsHex = (ms: number) => (BigInt(ms) * BigInt(1_000_000)).toString(16);

// Distinctive synthetic values, so a match in the output can only be a leak.
const RAW = { PoolA: 'f00dfacecafe1234', PoolB: '5eed5eed' } as const;

// A minimal coinbase (version 1, one input with a 4-byte height push, one output), split around extranonce1.
const COINBASE1 = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff' + '18' + '03a08601';
const COINBASE2 = 'ffffffff0100f2052a01000000016a00000000';

function template(pool: keyof typeof RAW, extra: Record<string, unknown> = {}) {
  return {
    id: `${pool}-1`, height: 100001, pool_name: pool, coinbase1: COINBASE1, coinbase2: COINBASE2,
    merkle_branches: [], version: '20000000', prev_hash: '00'.repeat(32), timestamp: tsHex(NOW_MS - 1000),
    nbits: '17034219', ntime: '66000000', clean_jobs: true, extranonce1: RAW[pool], extranonce2_length: 4,
    lat_ms: null, lat_m: null, ...extra,
  };
}

function expectMasked(text: string, served: { pool_name: string; extranonce1: string }[]) {
  for (const raw of Object.values(RAW)) expect(text).not.toContain(raw);
  expect(served.length).toBeGreaterThan(0);
  for (const t of served) {
    const raw = RAW[t.pool_name as keyof typeof RAW];
    expect(t.extranonce1).toBe(mask(t.pool_name, raw));
    expect(t.extranonce1).toHaveLength(raw.length);
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('EXTRANONCE1_MASK_KEY', KEY);
  vi.stubEnv('POOL_BLACKLIST', '');
  resetConnectionMaskForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../db/blocks');
  vi.doUnmock('../db/mining-notify');
  vi.doUnmock('../rabbitmq');
  vi.doUnmock('../db/unknown-parents');
  resetConnectionMaskForTests();
});

const templates = () => [template('PoolA'), template('PoolB')];

describe('served templates carry masked extranonce1', () => {
  it('/api/mining-notify', async () => {
    vi.doMock('../db/mining-notify', () => ({ getMiningNotifyByHeight: vi.fn(async () => templates()) }));
    const { GET } = await import('../../app/api/mining-notify/route');
    const text = await (await GET(new NextRequest('http://test/api/mining-notify?height=100001'))).text();
    expectMasked(text, JSON.parse(text));
  });

  it('/api/realtime-prefill', async () => {
    vi.doMock('../db/blocks', () => ({
      enableHistoricalData: true,
      getHighestBlock: vi.fn(async () => ({ height: 100000, timestamp: Math.floor((NOW_MS - 60_000) / 1000) })),
    }));
    vi.doMock('../db/mining-notify', () => ({ fetchMiningNotifyByHeight: vi.fn(async () => templates()) }));
    const { GET } = await import('../../app/api/realtime-prefill/route');
    const text = await (await GET()).text();
    expectMasked(text, JSON.parse(text).templates);
  });

  it('/api/analysis-data (including coinbaseRaw and the ASCII text)', async () => {
    vi.doMock('../db/blocks', () => ({ getBlockByHeight: vi.fn(async () => null), getInterestingBlocks: vi.fn(async () => []), getHighestBlock: vi.fn(async () => ({ height: 100000 })) }));
    vi.doMock('../db/mining-notify', () => ({ getAllMiningNotifyAtHeight: vi.fn(async () => templates()) }));
    const { GET } = await import('../../app/api/analysis-data/route');
    const text = await (await GET(new NextRequest('http://test/api/analysis-data?height=100001'))).text();
    const served = JSON.parse(text).results[0].mining_notifications;
    expectMasked(text, served);
    // The coinbase is rebuilt from the pseudonym: same length as the real one.
    const a = served.find((t: { pool_name: string }) => t.pool_name === 'PoolA');
    expect(a.coinbaseRaw).toBe(COINBASE1 + a.extranonce1 + '00'.repeat(4) + COINBASE2);
  });

  it('/api/unknown-parents drill-in (Postgres rows: bytea extranonce1, decoded coinbase fields)', async () => {
    vi.doMock('../db/blocks', () => ({ enableHistoricalData: true }));
    const parent = '00'.repeat(32);
    const pgRow = (pool: keyof typeof RAW, job: string) => ({
      source_id: 1, source_name: pool, received_us: String(NOW_MS * 1000), height: 6_976_415, job_id: job,
      prev_hash: Buffer.alloc(32), coinbase1: Buffer.from(COINBASE1, 'hex'), coinbase2: Buffer.from(COINBASE2, 'hex'),
      merkle_branches: Buffer.alloc(0), version: 536870912, nbits: 386000000, ntime: 1_711_276_032, clean_jobs: true,
      extranonce1: Buffer.from(RAW[pool], 'hex'), extranonce2_length: 4, copies: 1, conns: [1], parent_label: 'this',
    });
    vi.doMock('../db/unknown-parents', async importOriginal => ({
      ...(await importOriginal<object>()),
      getEpisodePoolRows: vi.fn(async () => Object.keys(RAW).map(pool => ({ parent, pool, n: '1', first_ms: String(NOW_MS),
        last_ms: String(NOW_MS), auxpow: '0', conns: [1], heights: { 6976415: 1 }, nbits: { 386000000: 1 } }))),
      getEpisodeFacts: vi.fn(async () => [{ i: 1, tip: null, bits_prev: null, bits_at: null, in_stale: false }]),
      getDrillRows: vi.fn(async () => ({ truncated: false, blocks: [],
        templates: (Object.keys(RAW) as (keyof typeof RAW)[]).map(pool => pgRow(pool, 'j1')) })),
    }));
    const { GET } = await import('../../app/api/unknown-parents/route');
    const text = await (await GET(new Request(`http://test/api/unknown-parents?parent=${parent}`))).text();
    expectMasked(text, JSON.parse(text).templates);
  });

  it('/api/stream (direct and throttle-held templates)', async () => {
    let onMessage: ((msg: { content: Buffer } | null) => void) | undefined;
    const channel = {
      assertQueue: vi.fn(async () => ({ queue: 'q' })),
      bindQueue: vi.fn(async () => {}),
      consume: vi.fn(async (_q: string, cb: typeof onMessage) => { onMessage = cb; return { consumerTag: 't' }; }),
      ack: vi.fn(), cancel: vi.fn(async () => {}), deleteQueue: vi.fn(async () => {}), close: vi.fn(async () => {}),
    };
    vi.doMock('../rabbitmq', () => ({
      RABBITMQ_EXCHANGES: ['x'],
      createRabbitmqChannel: vi.fn(async () => ({ channel, connection: { close: vi.fn(async () => {}) } })),
    }));
    // A burst of 1 so the second PoolA template is held by the throttle and flushed by its timer.
    vi.stubEnv('STREAM_POOL_BURST', '1');
    vi.stubEnv('STREAM_POOL_RATE', '5');
    const { GET } = await import('../../app/api/stream/route');
    const abort = new AbortController();
    const response = await GET(new NextRequest('http://test/api/stream', { signal: abort.signal }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value); // connection message; the consumer is set up by now
    expect(onMessage).toBeDefined();

    for (const t of [template('PoolA', { job_id: '1' }), template('PoolA', { job_id: '2' }), template('PoolB')]) {
      onMessage!({ content: Buffer.from(JSON.stringify(t)) });
    }
    onMessage!({ content: Buffer.from(`{"broken": "${RAW.PoolA}", "extranonce1":`) }); // unparseable: dropped
    while ((text.match(/"pool_name"/g) ?? []).length < 3) text += decoder.decode((await reader.read()).value);
    abort.abort();

    const served = text.split('\n\n').filter(l => l.startsWith('data: '))
      .map(l => JSON.parse(l.slice(6))).filter(m => m.extranonce1 !== undefined);
    expect(served.map(m => m.job_id ?? 'B')).toEqual(expect.arrayContaining(['1', '2']));
    expectMasked(text, served);
  });
});
