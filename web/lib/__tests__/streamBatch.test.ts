import { describe, expect, it } from 'vitest';
import { StreamBatch, appendStreamItem, appendStreamItems, mergeLatestByPool } from '../streamBatch';
import { StreamDataType, type BlockData, type StratumV1Data, type StreamData } from '../types';

function tpl(pool: string, height: number, n: number): StreamData {
  const data = { pool_name: pool, height, job_id: `${pool}-${n}`, timestamp: n.toString(16) } as StratumV1Data;
  return { type: StreamDataType.STRATUM_V1, id: `${pool}-${n}`, timestamp: data.timestamp, data };
}

function block(hash: string, height: number): StreamData {
  return { type: StreamDataType.BLOCK, id: hash, timestamp: '0', data: { hash, height } as BlockData };
}

/** The per-message update the stream hook applied before batching, verbatim in behavior. */
function legacyAppend(prev: StreamData[], newData: StreamData, maxItems: number): StreamData[] {
  let filteredData = [...prev];
  if (newData.type === StreamDataType.STRATUM_V1) {
    filteredData = filteredData.filter(item =>
      !(item.type === StreamDataType.STRATUM_V1 &&
        item.data.pool_name === (newData.data as StratumV1Data).pool_name &&
        item.data.height === (newData.data as StratumV1Data).height)
    );
  } else if (newData.type === StreamDataType.BLOCK) {
    filteredData = filteredData.filter(item =>
      !(item.type === StreamDataType.BLOCK && item.data.hash === newData.data.hash)
    );
  }
  filteredData.push(newData);
  return filteredData.slice(-maxItems);
}

/** A deterministic mixed stream: templates from 7 pools over three heights, blocks (one repeated) in between. */
function sampleStream(n: number): StreamData[] {
  const out: StreamData[] = [];
  for (let i = 0; i < n; i++) {
    const height = 100 + Math.floor(i / 40);
    if (i % 40 === 39) out.push(block(`h${height}`, height));
    else if (i % 97 === 0) out.push(block('h100', 100));
    else out.push(tpl(`P${(i * 3) % 7}`, height, i));
  }
  return out;
}

describe('appendStreamItem', () => {
  it('matches the previous per-message update on a mixed stream', () => {
    let legacy: StreamData[] = [];
    let next: StreamData[] = [];
    for (const item of sampleStream(300)) {
      legacy = legacyAppend(legacy, item, 50);
      next = appendStreamItem(next, item, 50);
      expect(next).toEqual(legacy);
    }
  });

  it("replaces a pool's template at the same height and a block with the same hash", () => {
    const a1 = tpl('A', 100, 1);
    const a2 = tpl('A', 100, 2);
    const a3 = tpl('A', 101, 3);
    expect(appendStreamItems([], [a1, a2, a3], 50)).toEqual([a2, a3]);
    const b = block('x', 100);
    const b2 = block('x', 100);
    expect(appendStreamItems([], [b, a1, b2], 50)).toEqual([a1, b2]);
  });

  it('keeps the newest maxItems', () => {
    const items = [tpl('A', 1, 1), tpl('B', 1, 2), tpl('C', 1, 3)];
    expect(appendStreamItems([], items, 2)).toEqual(items.slice(1));
  });
});

describe('appendStreamItems', () => {
  it('equals applying each message in order, for any batch split', () => {
    const stream = sampleStream(300);
    let oneByOne: StreamData[] = [];
    for (const item of stream) oneByOne = legacyAppend(oneByOne, item, 50);
    for (const size of [1, 2, 7, 30, 300]) {
      let batched: StreamData[] = [];
      for (let i = 0; i < stream.length; i += size) batched = appendStreamItems(batched, stream.slice(i, i + size), 50);
      expect(batched).toEqual(oneByOne);
    }
  });

  it('returns the previous array for an empty batch (no re-render)', () => {
    const prev = [tpl('A', 1, 1)];
    expect(appendStreamItems(prev, [], 50)).toBe(prev);
  });
});

describe('StreamBatch and mergeLatestByPool', () => {
  it("keeps each pool's newest template in the batch, as per-message updates would", () => {
    const batch = new StreamBatch();
    expect(batch.empty).toBe(true);
    const a1 = tpl('A', 100, 1);
    const b1 = tpl('B', 100, 2);
    const a2 = tpl('A', 100, 3);
    for (const item of [a1, b1, a2]) batch.add(item, item.data as StratumV1Data);
    batch.add(block('x', 100), null);
    expect(batch.empty).toBe(false);
    expect(batch.items).toHaveLength(4);

    const prev = { C: tpl('C', 99, 0).data as StratumV1Data, A: tpl('A', 99, 0).data as StratumV1Data };
    let oneByOne = prev;
    for (const item of [a1, b1, a2]) oneByOne = { ...oneByOne, [(item.data as StratumV1Data).pool_name]: item.data as StratumV1Data };
    expect(mergeLatestByPool(prev, batch.latestByPool)).toEqual(oneByOne);
  });

  it('returns the previous map when the batch has no templates (no re-render)', () => {
    const prev = { A: tpl('A', 1, 1).data as StratumV1Data };
    const batch = new StreamBatch();
    batch.add(block('x', 1), null);
    expect(mergeLatestByPool(prev, batch.latestByPool)).toBe(prev);
  });

  it('ignores templates without a pool name, as before', () => {
    const batch = new StreamBatch();
    const t = tpl('', 1, 1);
    batch.add(t, t.data as StratumV1Data);
    expect(batch.latestByPool).toEqual({});
    expect(batch.items).toEqual([t]);
  });
});
