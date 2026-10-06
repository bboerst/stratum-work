import { describe, expect, it } from 'vitest';
import { StreamDataType } from '@/lib/types';
import { decodeTemplate } from '../decode';
import { toLegacyStreamData } from '../legacyAdapter';
import { makeRaw, tsHex } from './fixtures';

const none = () => ({ id: null, name: 'Unknown', method: 'none' as const });
const t = (over: Parameters<typeof makeRaw>[0]) => decodeTemplate(makeRaw(over), String(Math.random()), none);
const jobs = (data: { data: unknown }[]) => data.map(d => (d.data as { job_id: string }).job_id);

// Deviation from the brief: the legacy `useDataStream` array is oldest-first (push + slice(-max)), and
// consumers rely on that (Blocks.tsx reads `[length - 1]` as the latest update), so the adapter keeps that order.
describe('toLegacyStreamData', () => {
  it('keeps the newest template per (pool, height), oldest first, observe only', () => {
    const ts = [
      t({ pool_name: 'A', height: 1, timestamp: tsHex(1000), job_id: 'a1' }),
      t({ pool_name: 'A', height: 1, timestamp: tsHex(2000), job_id: 'a2' }),
      t({ pool_name: 'B', height: 1, timestamp: tsHex(1500), job_id: 'b1' }),
      t({ pool_name: 'A', height: 1, timestamp: tsHex(3000), job_id: 'w', mode: 'work', connection_id: 'A/work' }),
    ];
    const { data, latestMessagesByPool } = toLegacyStreamData(ts, []);
    expect(jobs(data)).toEqual(['b1', 'a2']);
    expect(data[0].type).toBe(StreamDataType.STRATUM_V1);
    expect(data[0].id).toBe(`B-${tsHex(1500)}`);
    expect(latestMessagesByPool.A.job_id).toBe('a2');
    expect(latestMessagesByPool.B.job_id).toBe('b1');
  });

  it('includes stream blocks and caps at maxItems, keeping the newest', () => {
    const ts = Array.from({ length: 60 }, (_, i) => t({ pool_name: `P${i}`, timestamp: tsHex(1000 + i) }));
    const { data } = toLegacyStreamData(ts, [{ block: { hash: 'h', height: 9, timestamp: new Date(5000).toISOString() } as never, rxMs: 5000 }], 50);
    expect(data).toHaveLength(50);
    expect(data[data.length - 1].type).toBe(StreamDataType.BLOCK);
    expect((data[0].data as { pool_name: string }).pool_name).toBe('P11');
  });

  it('dedupes blocks by hash', () => {
    const b = { block: { hash: 'h', height: 9, timestamp: new Date(5000).toISOString() } as never, rxMs: 5000 };
    const { data } = toLegacyStreamData([], [b, b]);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('h');
  });

  it('uses the earliest arrival of identical content across a pool\'s observe connections', () => {
    const ts = [
      t({ pool_name: 'A', height: 1, timestamp: tsHex(1000), job_id: 'x1', connection_id: 'A/1' }),
      t({ pool_name: 'A', height: 1, timestamp: tsHex(1100), job_id: 'x2', connection_id: 'A/2' }),
    ];
    const { data, latestMessagesByPool } = toLegacyStreamData(ts, []);
    expect(jobs(data)).toEqual(['x1']);
    expect(latestMessagesByPool.A.job_id).toBe('x1');
  });

  it('replaces with new content from any connection', () => {
    const ts = [
      t({ pool_name: 'A', height: 1, timestamp: tsHex(1000), job_id: 'x1', connection_id: 'A/1' }),
      t({ pool_name: 'A', height: 1, timestamp: tsHex(1100), job_id: 'y2', connection_id: 'A/2', version: '20002000' }),
    ];
    expect(jobs(toLegacyStreamData(ts, []).data)).toEqual(['y2']);
  });

  it('orders blocks by arrival, not header time, so a fresh block survives the cap', () => {
    const ts = Array.from({ length: 60 }, (_, i) => t({ pool_name: `P${i}`, timestamp: tsHex(1_000_000 + i) }));
    // Header time trails the newest templates by minutes; arrival is newest.
    const header = new Date(1_000_000 - 10 * 60_000).toISOString().replace('Z', '');
    const { data } = toLegacyStreamData(ts, [{ block: { hash: 'late', height: 9, timestamp: header } as never, rxMs: 1_000_100 }], 50);
    expect(data).toHaveLength(50);
    expect(data[data.length - 1].id).toBe('late');
  });
});
