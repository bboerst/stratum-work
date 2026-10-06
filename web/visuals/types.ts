import type { FC } from 'react';
import type { Scope } from '@/lib/templates/types';

export type ParamField =
  | { key: string; label: string; kind: 'number'; min?: number; max?: number; step?: number }
  | { key: string; label: string; kind: 'select'; options: { value: string; label: string }[] }
  | { key: string; label: string; kind: 'pool' } // select populated from the scope's pools
  | { key: string; label: string; kind: 'pools' }; // multi-select of pools

export interface VisualDefinition<P = Record<string, unknown>> {
  id: string; title: string; description: string; scopes: Array<Scope['kind']>;
  defaultParams: P; paramsSchema: ParamField[]; Component: FC<{ scope: Scope; params: P }>;
}
