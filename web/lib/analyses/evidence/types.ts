import type { PoolTimelineEntry } from '@/lib/templates/types';

export type ChannelId = 'txSelection' | 'identicalChanges' | 'tipSwitch' | 'payoutsMergeMining';
export interface EvidenceInput { timelines: ReadonlyMap<string, readonly PoolTimelineEntry[]>; nowMs: number }
export interface ChannelParams {
  sampleMs: number; minBranches: number; postTipSkipMs: number; staleMs: number;
  changeWindowMs: number; mergeWindowMs: number; minEvents: number;
}
export const DEFAULT_PARAMS: ChannelParams = { sampleMs: 5000, minBranches: 3, postTipSkipMs: 10_000, staleMs: 120_000, changeWindowMs: 2000, mergeWindowMs: 5000, minEvents: 5 };
export interface Observation { pools: string[]; bits: number; atMs: number; detail: unknown }
export interface ChannelResult { observations: Observation[]; comparable: Map<string, number> } // comparable events per pairKey
export interface EvidenceChannel { id: ChannelId; observe(input: EvidenceInput, params: ChannelParams): ChannelResult }
export interface PairChannel { bits: number; events: number; insufficient: boolean }
export interface PairEvidence { a: string; b: string; total: number; channels: Record<ChannelId, PairChannel> }
export const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
