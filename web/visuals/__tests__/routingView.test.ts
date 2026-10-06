import { expect, it } from 'vitest';
import { routingBars } from '../routingView';

it('one bar per target plus remainder', () => {
  const bars = routingBars({ type: 'routing', site: 'us', timestamp: 't', total_ths: 12, targets: [{ id: 'ocean', pool: 'OCEAN', target_ths: 5, delivered_ths: 4.8, available: true }], remainder: { id: 'datum', delivered_ths: 7.2, fallback_active: true }, workers: [] });
  expect(bars).toEqual([
    { id: 'ocean', label: 'OCEAN', delivered: 4.8, target: 5, available: true, isRemainder: false },
    { id: 'datum', label: 'remainder → DATUM (fallback)', delivered: 7.2, target: null, available: true, isRemainder: true },
  ]);
});

it('remainder label has no fallback suffix when fallback is inactive; unavailable targets are kept', () => {
  const bars = routingBars({ type: 'routing', site: 'us', timestamp: 't', total_ths: 3, targets: [{ id: 'f2', pool: 'F2Pool', target_ths: 2, delivered_ths: 0, available: false }], remainder: { id: 'datum', delivered_ths: 3, fallback_active: false }, workers: [] });
  expect(bars.map(b => [b.label, b.available])).toEqual([['F2Pool', false], ['remainder → DATUM', true]]);
});
