import type { BlockData, StratumV1Data } from '@/lib/types';
import type { CoinbaseOutputDetail } from '@/utils/bitcoinUtils';
import type { TemplateChangeResult } from '@/utils/templateChangeDetection';

export type Mode = 'observe' | 'work';
export type Scope = { kind: 'live' } | { kind: 'height'; height: number } | { kind: 'range'; fromMs: number; toMs: number };
export interface PoolDef { id: string; name: string; slug?: string; link?: string; tags: string[]; regexes: string[]; addresses: string[] }
export interface Identity { id: string | null; name: string; method: 'address' | 'tag' | 'none'; datumTemplateCreator?: string }
export type RawTemplate = StratumV1Data & { connection_id?: string; site?: string; mode?: Mode; account?: string; _mid?: string };
export interface Template {
  mid: string; pool: string; connectionId: string; site: string; mode: Mode; account?: string;
  receivedAtMs: number; latencyMs: number | null; height: number; prevHash: string; version: string;
  nbits?: string; ntime?: string; cleanJobs: boolean; merkleBranches: string[];
  txCountRange: [number, number]; coinbaseOutputs: CoinbaseOutputDetail[]; payoutAddresses: string[];
  coinbaseTag: string; coinbaseScriptHex: string; totalOutputSats: number; feesSats: number;
  mergeMiningCommitments: Record<string, string>; identity: Identity; change?: TemplateChangeResult;
  contentKey: string; raw: RawTemplate;
}
export interface RoutingTarget { id: string; pool: string; target_ths: number; delivered_ths: number; available: boolean }
export interface RoutingStatus {
  type: 'routing'; timestamp: string; site: string; total_ths: number; targets: RoutingTarget[];
  remainder: { id: string; delivered_ths: number; fallback_active: boolean };
  workers: { name: string; ths: number; since: string }[];
}
export interface ConnectionArrival { connectionId: string; site: string; mode: Mode; receivedAtMs: number; offsetMs: number }
export interface PoolTimelineEntry { template: Template; arrivals: ConnectionArrival[] }
export type { BlockData };
