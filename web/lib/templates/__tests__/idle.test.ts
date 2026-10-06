import { describe, expect, it } from 'vitest';
import { runIdleChunks } from '../idle';

const range = (n: number) => Array.from(Array(n).keys());

describe('runIdleChunks', () => {
  it('processes every item in order across several idle callbacks', async () => {
    const seen: number[] = []; let calls = 0;
    let budget = 0;
    const idle = (cb: (d: { timeRemaining(): number }) => void) => { calls++; budget = 3; setTimeout(() => cb({ timeRemaining: () => (budget-- > 0 ? 5 : 0) }), 0); };
    await runIdleChunks(range(10), b => seen.push(...b), { idle, sliceMs: 8 });
    expect(seen).toEqual(range(10));
    expect(calls).toBeGreaterThan(1);
  });
  it('resolves immediately for empty input', async () => { await runIdleChunks([], () => { throw new Error('no'); }); });
});
