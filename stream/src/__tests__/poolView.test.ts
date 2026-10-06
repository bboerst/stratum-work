import { describe, expect, it } from 'vitest';
import { PoolViewReducer } from '../poolView.js';
import { toRawMessage } from '../message.js';

const tpl = (over: Record<string, unknown>, rx: number) =>
  toRawMessage(Buffer.from(JSON.stringify({ pool_name: 'A', prev_hash: 'p1', coinbase1: 'c1', coinbase2: 'c2', merkle_branches: [], version: 'v', nbits: 'n', clean_jobs: false, height: 1, job_id: 'j', ntime: 't', ...over })), rx)!;

describe('PoolViewReducer', () => {
  it('emits the first arrival and records later ones', () => {
    const r = new PoolViewReducer();
    const a = tpl({ connection_id: 's1/A/observe' }, 1);
    const b = tpl({ connection_id: 's2/A/observe', job_id: 'other', ntime: 'x' }, 2);
    expect(r.accept(a).emit).toBe(true);
    const res = r.accept(b);
    expect(res.emit).toBe(false);
    expect(res.arrival).toEqual({ mid: b.mid, connectionId: 's2/A/observe', rx: 2, firstMid: a.mid });
  });
  it('emits distinct content', () => {
    const r = new PoolViewReducer();
    expect(r.accept(tpl({}, 1)).emit).toBe(true);
    expect(r.accept(tpl({ prev_hash: 'p2' }, 2)).emit).toBe(true);
  });
  it('scopes keys per pool', () => {
    const r = new PoolViewReducer();
    expect(r.accept(tpl({}, 1)).emit).toBe(true);
    expect(r.accept(tpl({ pool_name: 'B' }, 2)).emit).toBe(true);
  });
  it('forgets keys after the window', () => {
    const r = new PoolViewReducer(1000);
    expect(r.accept(tpl({}, 1)).emit).toBe(true);
    expect(r.accept(tpl({}, 5000)).emit).toBe(true);
  });
});
