import { describe, expect, it } from 'vitest';
import { decodeTemplate, mergeMiningCommitments, subsidySats, templateContentKey, templateMid, txCountRange } from '../decode';
import { ADDR, makeRaw, tsHex } from './fixtures';

const none = () => ({ id: null, name: 'Unknown', method: 'none' as const });

describe('decode helpers', () => {
  it('subsidy halves every 210,000 blocks', () => {
    expect(subsidySats(0)).toBe(5_000_000_000);
    expect(subsidySats(840_000)).toBe(312_500_000);
    expect(subsidySats(64 * 210_000)).toBe(0);
  });
  it('txCountRange from branch depth', () => {
    expect(txCountRange(0)).toEqual([0, 0]);
    expect(txCountRange(1)).toEqual([1, 2]);
    expect(txCountRange(12)).toEqual([2048, 4096]);
  });
  it('merge-mining commitments keyed by protocol', () => {
    const out = mergeMiningCommitments([
      { type: 'nulldata', value: 0, decodedData: { protocol: 'RSK Block', details: { rskBlockHash: 'ff' }, dataHex: 'x' } },
      { type: 'nulldata', value: 0, decodedData: { protocol: 'WitnessCommitment', dataHex: 'aa' } },
    ], 'beef');
    expect(out).toEqual({ RSK: 'x', AuxPOW: 'beef' }); // content = the OP_RETURN payload hex
  });
  it('content key ignores timestamp, job id and extranonce1', () => {
    const a = makeRaw({ job_id: 'x', extranonce1: '00' });
    const b = makeRaw({ job_id: 'y', extranonce1: '11' });
    expect(templateContentKey(a)).toBe(templateContentKey(b));
    expect(templateContentKey(makeRaw({ merkle_branches: [] }))).not.toBe(templateContentKey(a));
  });
});

describe('decodeTemplate', () => {
  it('derives fees, payouts, tx range and legacy connection defaults', () => {
    const t = decodeTemplate(makeRaw({ timestamp: tsHex(1_700_000_123_456), lat_ms: 12 }), 'm1', none);
    expect(t.mid).toBe('m1');
    expect(t.connectionId).toBe('PoolA');
    expect(t.site).toBe('us-ash-legacy');
    expect(t.mode).toBe('observe');
    expect(t.receivedAtMs).toBe(1_700_000_123_456);
    expect(t.latencyMs).toBe(12);
    expect(t.totalOutputSats).toBe(312_600_000);
    expect(t.feesSats).toBe(100_000);
    expect(t.payoutAddresses).toEqual([ADDR]);
    expect(t.txCountRange).toEqual([4, 8]);
    expect(t.coinbaseTag).toContain('/test/');
    expect(t.identity.method).toBe('none');
  });
  it('keeps explicit connection metadata', () => {
    const t = decodeTemplate(makeRaw({ connection_id: 'eu/PoolA/work', site: 'eu-hel', mode: 'work', account: 'w1' }), 'm2', none);
    expect([t.connectionId, t.site, t.mode, t.account]).toEqual(['eu/PoolA/work', 'eu-hel', 'work', 'w1']);
  });
});

describe('templateMid', () => {
  it('is stable per connection message and distinguishes connections', () => {
    const r = makeRaw({ timestamp: 'abc', job_id: 'j' });
    expect(templateMid(r)).toBe('PoolA|abc|j');
    expect(templateMid({ ...r, connection_id: 'eu/PoolA/observe' })).toBe('eu/PoolA/observe|abc|j');
    expect(templateMid({ ...r, _mid: 'x' })).toBe('x');
  });
});
