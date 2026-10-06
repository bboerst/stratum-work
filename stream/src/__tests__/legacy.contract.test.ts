import { describe, expect, it } from 'vitest';
import { StreamState } from '../server.js';
import { toRawMessage } from '../message.js';
// @ts-expect-error vendored JS fixture
import { createForkObserver, STRATUM_JOB_TTL_MS } from '../../test/fixtures/fork-observer.js';

const tpl = (o: Record<string, unknown>) => ({ pool_name: 'A', height: 100, prev_hash: '11111111' + '0'.repeat(56), coinbase1: 'c1', coinbase2: 'c2', merkle_branches: [], version: 'v', nbits: 'n', ntime: 't', clean_jobs: true, job_id: 'j', extranonce1: 'e', extranonce2_length: 8, timestamp: '1', ...o });

function run(docs: Record<string, unknown>[]) {
  const state = new StreamState({ historyMinutes: 60, blacklist: () => false });
  const legacy: string[] = [];
  state.subscribe(ev => { if (ev.views.legacy) legacy.push(ev.msg.body); });
  docs.forEach((d, i) => state.ingest(toRawMessage(Buffer.from(JSON.stringify(d)), i + 1)!));
  return legacy;
}

describe('legacy stream contract (fork-observer)', () => {
  it('yields one current prev_hash/height per pool, identical to feeding the raw observe stream', () => {
    const docs = [
      tpl({}),
      tpl({ connection_id: 'us-ash-1/A/work', site: 'us-ash-1', mode: 'work', prev_hash: '22222222' + '0'.repeat(56), height: 101 }),
      tpl({ pool_name: 'B', prev_hash: '22222222' + '0'.repeat(56), height: 101 }),
      { type: 'block', id: 'h', timestamp: 'x', data: { hash: 'h', height: 101 } },
      { type: 'share', pool_name: 'A', connection_id: 'us-ash-1/A/work', accepted: true, timestamp: '1' },
      { type: 'routing', site: 'us-ash-1', timestamp: '1' },
    ];
    const viaLegacy = createForkObserver();
    run(docs).forEach(d => viaLegacy.handle(d));
    const viaRawObserve = createForkObserver();
    docs.filter((d: any) => d.mode !== 'work' && d.type !== 'share' && d.type !== 'routing').forEach(d => viaRawObserve.handle(JSON.stringify(d)));
    const strip = (s: Map<string, any>) => [...s.entries()].map(([k, v]) => [k, v.prev_hash, v.height]);
    expect(strip(viaLegacy.state)).toEqual(strip(viaRawObserve.state));
    expect(viaLegacy.state.get('A').height).toBe(100);
  });
  it('never emits share, routing, or work-mode messages', () => {
    const out = run([
      tpl({ mode: 'work', connection_id: 's/A/work', site: 's' }),
      { type: 'share', pool_name: 'A', connection_id: 's/A/work', timestamp: '1' },
      { type: 'routing', site: 's', timestamp: '1' },
    ]);
    expect(out).toEqual([]);
  });
  it('emits the original body bytes unchanged', () => {
    const body = JSON.stringify(tpl({ extra_field: 1 }));
    const state = new StreamState({ historyMinutes: 60, blacklist: () => false });
    const out: string[] = [];
    state.subscribe(ev => { if (ev.views.legacy) out.push(ev.msg.body); });
    state.ingest(toRawMessage(Buffer.from(body), 1)!);
    expect(out).toEqual([body]);
  });
  it('still emits an observe template whose identical content arrived first on a work connection', () => {
    const work = tpl({ connection_id: 's/A/work', site: 's', mode: 'work', job_id: 'w' });
    const observe = tpl({ connection_id: 's/A/observe', site: 's', mode: 'observe', job_id: 'o' });
    const out = run([work, observe]);
    expect(out).toEqual([JSON.stringify(observe)]);
  });
  it('forwards identical-content templates that differ only in job_id/ntime', () => {
    const a = tpl({ job_id: '1', ntime: 't1' });
    const b = tpl({ job_id: '2', ntime: 't2' });
    expect(run([a, b])).toEqual([JSON.stringify(a), JSON.stringify(b)]);
  });
  it('follows a pool flipping between tips across observe sites', () => {
    const X = '11111111' + '0'.repeat(56), Y = '22222222' + '0'.repeat(56);
    const obs = createForkObserver();
    run([
      tpl({ connection_id: 's1/A', site: 's1', prev_hash: X, height: 101 }),
      tpl({ connection_id: 's2/A', site: 's2', prev_hash: Y, height: 101 }),
      tpl({ connection_id: 's1/A', site: 's1', prev_hash: X, height: 101 }),
    ]).forEach(d => obs.handle(d));
    expect(obs.state.get('A').prev_hash).toBe('0'.repeat(56) + '11111111');
  });
  it('keeps a pool that resends identical templates visible past the 120 s fork-observer TTL', () => {
    let t = 0;
    const obs = createForkObserver({ now: () => t });
    const state = new StreamState({ historyMinutes: 60, blacklist: () => false });
    state.subscribe(ev => { if (ev.views.legacy) obs.handle(ev.msg.body); });
    for (let i = 0; i <= 10; i++) {
      t = i * 30_000;
      state.ingest(toRawMessage(Buffer.from(JSON.stringify(tpl({ job_id: String(i) }))), t + 1)!);
      obs.expire();
      expect(obs.state.get('A')?.prev_hash).toBe('0'.repeat(56) + '11111111');
    }
    t += STRATUM_JOB_TTL_MS + 1;
    obs.expire();
    expect(obs.state.has('A')).toBe(false);
  });
  it('drops blacklisted pools', () => {
    const state = new StreamState({ historyMinutes: 60, blacklist: p => p === 'A' });
    const out: string[] = [];
    state.subscribe(ev => { if (ev.views.legacy || ev.views.all || ev.views.pool) out.push(ev.msg.body); });
    state.ingest(toRawMessage(Buffer.from(JSON.stringify(tpl({}))), 1)!);
    expect(out).toEqual([]);
  });
});
