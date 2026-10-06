"use client";
import React, { useState } from 'react';
import { CandidateBlocks } from '@/visuals/CandidateBlocks';
import { GroupingComparison } from '@/visuals/GroupingComparison';
import { EvidenceCard } from '@/visuals/EvidenceCard';
import { PairSimilarityGrid } from '@/visuals/PairSimilarityGrid';
import { Methodology } from '@/visuals/Methodology';
import { StoreNotes } from '@/visuals/ui';
import { useStoreStatus } from '@/lib/templates/hooks';

const P = { thresholdBits: 16, windowBlocks: 1008 };

// The live ScopeProvider is mounted by DataStreamProvider in app/layout.tsx, so the hooks resolve here.
export default function HomeClient() {
  const status = useStoreStatus();
  const [familyId, setFamilyId] = useState<string | undefined>();
  const [pair, setPair] = useState<string[]>([]);
  const pickPair = (a: string, b: string) => setPair([a, b]);
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-2 p-4">
      <StoreNotes status={status} />
      <CandidateBlocks params={{ ...P, recentBlocks: 3 }} selectedId={familyId} onSelect={id => { setFamilyId(id); setPair([]); }} />
      <GroupingComparison params={P} />
      <EvidenceCard params={{ ...P, pools: pair, tipBlocks: 6 }} familyId={familyId} onPickPair={pickPair} />
      <PairSimilarityGrid params={{ ...P, maxPools: 16 }} onPickPair={pickPair} />
      <Methodology params={P} />
    </main>
  );
}
