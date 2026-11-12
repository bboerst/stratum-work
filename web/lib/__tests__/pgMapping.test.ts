import { describe, expect, it } from 'vitest';
import {
  blockRowToBlock, blockRowToInterestingItem, firstSeenRowToItem, poolRowToPool, splitBranches, templateId,
  templateRowToMiningNotify, timestampHexFromMicros, u32Hex, type BlockRow, type TemplateRow,
} from '../db/pg-mapping';
import { dbBackend } from '../db/backend';
import { pgConfigFromEnv, pgSslFromEnv } from '../db/pg';

const b = (hex: string) => Buffer.from(hex, 'hex');
const BRANCH_A = 'aa'.repeat(31) + '01';
const BRANCH_B = '00'.repeat(32);

function templateRow(overrides: Partial<TemplateRow> = {}): TemplateRow {
  return {
    source_id: 3,
    source_name: 'PoolA',
    received_us: '1794491650123456',
    height: 975560,
    job_id: '2687119',
    prev_hash: b('90b62fac1e09306615f1d97dbea75b7ad1d6ab17000111df0000000000000000'),
    coinbase1: b('0100000001'),
    coinbase2: b('ffffffff00'),
    merkle_branches: b(BRANCH_A + BRANCH_B),
    version: '536870912',   // node-postgres returns bigint as a string
    nbits: '386000300',
    ntime: '1794491243',
    clean_jobs: true,
    extranonce1: b('0000c485'),
    extranonce2_length: 8,
    latency_ms: 24.336,
    latency_method: 'tcp',
    ...overrides,
  };
}

describe('hex encodings', () => {
  it('formats u32s as 8 lower-case hex digits, zero-padded', () => {
    expect(u32Hex('536870912')).toBe('20000000');
    expect(u32Hex(1)).toBe('00000001');
    expect(u32Hex('4294967295')).toBe('ffffffff');
    expect(() => u32Hex('4294967296')).toThrow();
    expect(() => u32Hex(-1)).toThrow();
  });

  it('splits concatenated merkle branches into 64-char hex strings, in order', () => {
    expect(splitBranches(b(BRANCH_A + BRANCH_B))).toEqual([BRANCH_A, BRANCH_B]);
    expect(splitBranches(Buffer.alloc(0))).toEqual([]);
    expect(() => splitBranches(Buffer.alloc(33))).toThrow();
  });

  it('turns µs into the collector timestamp format: hex nanoseconds, no padding', () => {
    // 1794491650123456 µs = 1794491650123456000 ns
    expect(timestampHexFromMicros('1794491650123456')).toBe((BigInt('1794491650123456000')).toString(16));
    expect(timestampHexFromMicros('1794491650123456')).toBe('18e750a5ee035e00');
    expect(timestampHexFromMicros(1)).toBe('3e8');
  });
});

describe('templateRowToMiningNotify', () => {
  it('rebuilds the MongoDB document shape', () => {
    const doc = templateRowToMiningNotify(templateRow());
    expect(doc).toEqual({
      id: '3-1794491650123456-2687119',
      height: 975560,
      pool_name: 'PoolA',
      chain_family: null,
      coinbase1: '0100000001',
      coinbase2: 'ffffffff00',
      merkle_branches: [BRANCH_A, BRANCH_B],
      version: '20000000',
      prev_hash: '90b62fac1e09306615f1d97dbea75b7ad1d6ab17000111df0000000000000000',
      timestamp: '18e750a5ee035e00',
      nbits: '1701e5ac',
      ntime: '6af5c36b',
      clean_jobs: true,
      extranonce1: '0000c485',
      extranonce2_length: 8,
      lat_ms: 24.336,
      lat_m: 'tcp',
    });
    // Same key order as Prisma's MiningNotify model
    expect(Object.keys(doc)).toEqual(['id', 'height', 'pool_name', 'chain_family', 'coinbase1', 'coinbase2',
      'merkle_branches', 'version', 'prev_hash', 'timestamp', 'nbits', 'ntime', 'clean_jobs', 'extranonce1',
      'extranonce2_length', 'lat_ms', 'lat_m']);
  });

  it('uses null for missing latency and the chain for templates_other rows', () => {
    const doc = templateRowToMiningNotify(templateRow({ latency_ms: null, latency_method: undefined, chain: 'bch' }));
    expect(doc.lat_ms).toBeNull();
    expect(doc.lat_m).toBeNull();
    expect(doc.chain_family).toBe('bch');
  });

  it('builds a stable id from the de-duplication key', () => {
    expect(templateId({ source_id: 7, received_us: '42', job_id: 'a-b' })).toBe('7-42-a-b');
  });
});

function blockRow(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    block_hash: b('000000000000000000000f4248771a27b166478bcf8e40354f035205ff238860'),
    height: 975560,
    block_time_s: '1794491650',
    coinbase_script_sig: b('03c8e20e'),
    mining_pool: { id: 111, link: 'https://example.com', name: 'Pool', slug: 'pool', match_type: 'address',
      identification_method: 'address' },
    analysis: { pool_identification: { method: 'address' } },
    tx_count: null, size: null, weight: null, version: null, merkle_root: null, bits: null, nonce: null,
    difficulty: null,
    ...overrides,
  };
}

describe('blockRowToBlock', () => {
  it('matches the MongoDB block shape, with the hash as id', () => {
    const block = blockRowToBlock(blockRow());
    expect(block).toEqual({
      block_hash: '000000000000000000000f4248771a27b166478bcf8e40354f035205ff238860',
      analysis: { pool_identification: { method: 'address' } },
      coinbase_script_sig: '03c8e20e',
      height: 975560,
      mining_pool: { id: 111, name: 'Pool', tag: undefined, datum_template_creator: undefined,
        link: 'https://example.com', slug: 'pool', match_type: 'address', identification_method: 'address' },
      timestamp: 1794491650,
      id: '000000000000000000000f4248771a27b166478bcf8e40354f035205ff238860',
    });
    expect(Object.keys(block)).toEqual(['block_hash', 'analysis', 'coinbase_script_sig', 'height', 'mining_pool',
      'timestamp', 'id']);
    expect(typeof block.timestamp).toBe('number');
  });

  it('omits mining_pool when the backend stored none ({}), and header fields that are unset', () => {
    const block = blockRowToBlock(blockRow({ mining_pool: {} }));
    expect('mining_pool' in JSON.parse(JSON.stringify(block))).toBe(false);
    expect(block.transactions).toBeUndefined();
  });

  it('emits header fields when present', () => {
    const block = blockRowToBlock(blockRow({ tx_count: 3000, version: '536870912', bits: '386000300', nonce: '4294967295',
      merkle_root: b('ab'.repeat(32)), size: 1, weight: 4, difficulty: 1.5 }));
    expect(block).toMatchObject({ transactions: 3000, version: 536870912, bits: '1701e5ac', nonce: 4294967295,
      merkle_root: 'ab'.repeat(32), size: 1, weight: 4, difficulty: 1.5 });
  });
});

describe('other rows', () => {
  it('R3 item keeps the raw mining_pool', () => {
    const item = blockRowToInterestingItem(blockRow({ analysis: { foo: 1 } }));
    expect(item).toEqual({ block_hash: blockRowToBlock(blockRow()).block_hash, analysis: { foo: 1 }, height: 975560,
      mining_pool: blockRow().mining_pool });
  });

  it('R4 first-seen item', () => {
    expect(firstSeenRowToItem({ pool_name: 'PoolA', received_us: '1000', latency_ms: null }))
      .toEqual({ firstSeenTimestamp: 'f4240', firstSeenLatencyMs: null, poolName: 'PoolA' });
  });

  it('R7 pool uses the mining-pools id as a string', () => {
    expect(poolRowToPool({ id: 1, name: 'BlockFills', tag: null, addresses: ['1abc'] }))
      .toEqual({ id: '1', name: 'BlockFills', tag: null, addresses: ['1abc'] });
  });
});

describe('configuration', () => {
  it('DB_BACKEND defaults to mongodb and rejects unknown values', () => {
    expect(dbBackend({})).toBe('mongodb');
    expect(dbBackend({ DB_BACKEND: ' Postgres ' })).toBe('postgres');
    expect(() => dbBackend({ DB_BACKEND: 'mysql' })).toThrow(/DB_BACKEND/);
  });

  it('builds the pool config from separate fields', () => {
    const c = pgConfigFromEnv({ PG_HOST: 'db', PG_PORT: '6432', PG_DATABASE: 'd', PG_USER: 'u', PG_PASSWORD: 'p' });
    expect(c).toMatchObject({ host: 'db', port: 6432, database: 'd', user: 'u', password: 'p', ssl: false, max: 5 });
    expect(pgConfigFromEnv({})).toMatchObject({ host: 'postgres', port: 5432, database: 'stratum', user: 'web' });
    expect(pgConfigFromEnv({}).password).toBeUndefined();
  });

  it('maps PG_SSLMODE like libpq and rejects prefer/allow', () => {
    expect(pgSslFromEnv({})).toBe(false);
    expect(pgSslFromEnv({ PG_SSLMODE: 'require' })).toEqual({ rejectUnauthorized: false });
    expect(pgSslFromEnv({ PG_SSLMODE: 'verify-full' })).toEqual({ rejectUnauthorized: true });
    expect(pgSslFromEnv({ PG_SSLMODE: 'verify-full', PG_SSLROOTCERT: '/ca.pem' }, () => 'CA'))
      .toEqual({ ca: 'CA', rejectUnauthorized: true });
    const verifyCa = pgSslFromEnv({ PG_SSLMODE: 'verify-ca' }) as { rejectUnauthorized: boolean; checkServerIdentity: () => unknown };
    expect(verifyCa.rejectUnauthorized).toBe(true);
    expect(verifyCa.checkServerIdentity()).toBeUndefined();
    expect(() => pgSslFromEnv({ PG_SSLMODE: 'prefer' })).toThrow(/PG_SSLMODE/);
  });
});
