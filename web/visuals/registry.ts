import { candidateBlocksVisual } from './CandidateBlocks';
import { groupingComparisonVisual } from './GroupingComparison';
import { evidenceCardVisual } from './EvidenceCard';
import { pairSimilarityGridVisual } from './PairSimilarityGrid';
import { tipSwitchWavefrontVisual } from './TipSwitchWavefront';
import { mergeMiningMapVisual } from './MergeMiningMap';
import { emptyBlockWindowVisual } from './EmptyBlockWindow';
import { jobCadenceClockVisual } from './JobCadenceClock';
import { routingPanelVisual } from './RoutingPanel';
import { observeVsWorkVisual } from './ObserveVsWork';
import { decodeLayoutWith } from './layout';
import type { VisualDefinition } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous param types per visual
export const VISUALS: VisualDefinition<any>[] = [
  candidateBlocksVisual, groupingComparisonVisual, evidenceCardVisual, pairSimilarityGridVisual,
  tipSwitchWavefrontVisual, mergeMiningMapVisual, emptyBlockWindowVisual, jobCadenceClockVisual,
  routingPanelVisual, observeVsWorkVisual,
];
export const getVisual = (id: string) => VISUALS.find(v => v.id === id);
export const decodeLayout = (s: string | null) => decodeLayoutWith(s, getVisual);
