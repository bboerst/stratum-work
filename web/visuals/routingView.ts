import type { RoutingStatus } from '@/lib/templates/types';

export interface RoutingBar { id: string; label: string; delivered: number; target: number | null; available: boolean; isRemainder: boolean }

/** One bar per routing target, then the remainder (routed to DATUM; no target). */
export function routingBars(r: RoutingStatus): RoutingBar[] {
  return [
    ...r.targets.map(t => ({ id: t.id, label: t.pool, delivered: t.delivered_ths, target: t.target_ths, available: t.available, isRemainder: false })),
    {
      id: r.remainder.id,
      label: `remainder → DATUM${r.remainder.fallback_active ? ' (fallback)' : ''}`,
      delivered: r.remainder.delivered_ths,
      target: null,
      available: true,
      isRemainder: true,
    },
  ];
}
