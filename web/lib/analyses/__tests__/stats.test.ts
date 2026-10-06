import { describe, expect, it } from 'vitest';
import { bits, effectiveNumber, fewestControllingMajority, wilson } from '../stats';

describe('wilson', () => {
  it('matches the textbook 95% interval for 10/100', () => {
    const r = wilson(10, 100);
    expect(r.p).toBeCloseTo(0.1, 10);
    expect(r.lo).toBeCloseTo(0.0552, 3);
    expect(r.hi).toBeCloseTo(0.1744, 3);
  });
  it('is [0, upper] at k=0 and never leaves [0,1]', () => {
    const r = wilson(0, 50);
    expect(r.lo).toBe(0);
    expect(r.hi).toBeGreaterThan(0);
    const s = wilson(50, 50);
    expect(s.hi).toBeLessThanOrEqual(1);
  });
  it('returns zeros for n=0', () => expect(wilson(0, 0)).toEqual({ p: 0, lo: 0, hi: 0 }));
});

describe('bits', () => {
  it('is -log2(k/n)', () => { expect(bits(1, 8)).toBeCloseTo(3); expect(bits(8, 8)).toBe(0); });
  it('is 0 for degenerate input', () => { expect(bits(0, 5)).toBe(0); expect(bits(1, 0)).toBe(0); });
});

describe('concentration', () => {
  it('effective number = 1/sum(s^2)', () => expect(effectiveNumber([0.5, 0.25, 0.25])).toBeCloseTo(1 / 0.375));
  it('fewest controlling > 50%', () => {
    expect(fewestControllingMajority([0.3, 0.25, 0.2, 0.15, 0.1])).toBe(2);
    expect(fewestControllingMajority([0.5, 0.5])).toBe(2);
    expect(fewestControllingMajority([])).toBe(0);
  });
});
