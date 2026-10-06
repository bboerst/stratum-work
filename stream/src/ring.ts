import type { RawMessage } from './message.js';

export class RingBuffer<T extends { rx: number } = RawMessage> {
  private items: T[] = [];
  constructor(private maxAgeMs: number) {}
  push(msg: T) {
    const a = this.items;
    if (a.length === 0 || a[a.length - 1].rx <= msg.rx) { a.push(msg); return; }
    let i = a.length - 1;
    while (i >= 0 && a[i].rx > msg.rx) i--;
    a.splice(i + 1, 0, msg);
  }
  since(rx: number): T[] {
    let lo = 0, hi = this.items.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.items[mid].rx <= rx) lo = mid + 1; else hi = mid; }
    return this.items.slice(lo);
  }
  evict(now: number) {
    const cutoff = now - this.maxAgeMs;
    let n = 0;
    while (n < this.items.length && this.items[n].rx < cutoff) n++;
    if (n) this.items.splice(0, n);
  }
  oldestRx() { return this.items[0]?.rx; }
  newestRx() { return this.items[this.items.length - 1]?.rx; }
  size() { return this.items.length; }
}
