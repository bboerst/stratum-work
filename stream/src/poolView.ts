import type { RawMessage } from './message.js';
import { templateContentKey } from './contentKey.js';

interface Seen { firstMid: string; rx: number }

export class PoolViewReducer {
  private seen = new Map<string, Seen>();
  private lastSweep = 0;
  constructor(private windowMs = 10 * 60_000) {}

  accept(msg: RawMessage): { emit: boolean; arrival?: { mid: string; connectionId: string; rx: number; firstMid: string } } {
    if (msg.kind !== 'template') return { emit: true };
    this.sweep(msg.rx);
    const key = `${msg.pool}\u0000${templateContentKey(msg.json)}`;
    const prior = this.seen.get(key);
    if (prior && msg.rx - prior.rx <= this.windowMs) {
      return { emit: false, arrival: { mid: msg.mid, connectionId: msg.connectionId!, rx: msg.rx, firstMid: prior.firstMid } };
    }
    this.seen.set(key, { firstMid: msg.mid, rx: msg.rx });
    return { emit: true };
  }

  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.seen) if (now - v.rx > this.windowMs) this.seen.delete(k);
  }
}
