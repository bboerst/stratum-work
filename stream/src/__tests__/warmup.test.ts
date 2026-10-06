import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { StreamState } from '../server.js';
import { toRawMessage } from '../message.js';
import { LiveGate, safeWarmUp } from '../warmup.js';
import { registry } from '../metrics.js';

const tpl = (o: Record<string, unknown>) => Buffer.from(JSON.stringify({ pool_name: 'A', height: 1, prev_hash: 'p', coinbase1: 'a', coinbase2: 'b', merkle_branches: [], version: 'v', nbits: 'n', ntime: 't', clean_jobs: false, job_id: 'j', timestamp: '1', ...o }));
const newState = () => new StreamState({ historyMinutes: 60, blacklist: () => false });
const failures = async () => (await registry.getSingleMetric('stream_warmup_failures_total')!.get()).values[0]?.value ?? 0;

describe('safeWarmUp', () => {
  it('returns an empty set and counts a failure when the database errors', async () => {
    const before = await failures();
    const db = { query: async () => { throw new Error('connection refused'); } } as unknown as pg.Pool;
    const mids = await safeWarmUp(db, newState(), 0, 1000);
    expect(mids.size).toBe(0);
    expect(await failures()).toBe(before + 1);
  });
  it('gives up after the timeout when the database hangs', async () => {
    const db = { query: () => new Promise(() => {}) } as unknown as pg.Pool;
    const t0 = Date.now();
    const mids = await safeWarmUp(db, newState(), 0, 50);
    expect(mids.size).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('LiveGate', () => {
  it('buffers live deliveries until released, then flushes them in order with arrival rx and acks', () => {
    let t = 1000;
    const state = newState();
    const gate = new LiveGate(state, { skipWindowMs: 60_000, now: () => t });
    const acks: number[] = [];
    gate.deliver(tpl({ job_id: '1' }), () => acks.push(1));
    t = 2000;
    gate.deliver(tpl({ job_id: '2', prev_hash: 'q' }), () => acks.push(2));
    expect(state.ring.size()).toBe(0);
    expect(acks).toEqual([]);
    t = 9000;
    gate.release(new Set());
    expect(acks).toEqual([1, 2]);
    expect(state.ring.since(-1).map(i => i.rx)).toEqual([1000, 2000]);
    gate.deliver(tpl({ job_id: '3', prev_hash: 'r' }), () => acks.push(3));
    expect(acks).toEqual([1, 2, 3]);
    expect(state.ring.size()).toBe(3);
  });
  it('still flushes buffered live messages after a cold start (warm-up failed)', async () => {
    const state = newState();
    const gate = new LiveGate(state, { skipWindowMs: 60_000 });
    gate.deliver(tpl({}), () => {});
    const db = { query: async () => { throw new Error('down'); } } as unknown as pg.Pool;
    gate.release(await safeWarmUp(db, state, 0, 1000));
    expect(state.ring.size()).toBe(1);
  });
  it('skips messages already loaded by warm-up, including backlog delivered after release, within the window', () => {
    let t = 0;
    const state = newState();
    const gate = new LiveGate(state, { skipWindowMs: 60_000, now: () => t });
    const a = tpl({ job_id: 'a' }), b = tpl({ job_id: 'b', prev_hash: 'q' }), c = tpl({ job_id: 'c', prev_hash: 'r' });
    const warm = new Set([toRawMessage(a, 0)!.mid, toRawMessage(b, 0)!.mid]);
    gate.deliver(a, () => {});
    gate.release(warm);
    gate.deliver(b, () => {});
    gate.deliver(c, () => {});
    expect(state.ring.since(-1).map(i => JSON.parse(i.body).job_id)).toEqual(['c']);
    t = 61_000;
    gate.deliver(b, () => {});
    expect(state.ring.size()).toBe(2);
  });
});
