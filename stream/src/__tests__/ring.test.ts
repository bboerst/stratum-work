import { describe, expect, it } from 'vitest';
import { RingBuffer } from '../ring.js';
const m = (rx: number) => ({ mid: String(rx), rx, kind: 'template' as const, body: '', json: {} });

describe('RingBuffer', () => {
  it('returns items strictly after rx in order', () => {
    const r = new RingBuffer(60_000);
    [1, 2, 3].forEach(x => r.push(m(x)));
    expect(r.since(1).map(x => x.rx)).toEqual([2, 3]);
  });
  it('evicts by age', () => {
    const r = new RingBuffer(10);
    r.push(m(1)); r.push(m(50));
    r.evict(55);
    expect(r.size()).toBe(1);
    expect(r.oldestRx()).toBe(50);
  });
  it('keeps order when rx arrives slightly out of order', () => {
    const r = new RingBuffer(60_000);
    r.push(m(5)); r.push(m(3));
    expect(r.since(0).map(x => x.rx)).toEqual([3, 5]);
  });
});
