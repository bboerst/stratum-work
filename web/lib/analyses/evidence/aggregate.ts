import { identicalChanges } from './identicalChanges';
import { payoutsMergeMining } from './payoutsMergeMining';
import { tipSwitch } from './tipSwitch';
import { txSelection } from './txSelection';
import {
  DEFAULT_PARAMS, pairKey,
  type ChannelId, type ChannelParams, type EvidenceChannel, type EvidenceInput, type Observation, type PairEvidence,
} from './types';

export const CHANNEL_IDS: ChannelId[] = ['txSelection', 'identicalChanges', 'tipSwitch', 'payoutsMergeMining'];
export const CHANNELS: EvidenceChannel[] = [txSelection, identicalChanges, tipSwitch, payoutsMergeMining];

export function runEvidence(input: EvidenceInput, params: Partial<ChannelParams> = {}, channels: EvidenceChannel[] = CHANNELS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const pools = Array.from(input.timelines.keys()).sort();
  const pairs = new Map<string, PairEvidence>();
  for (let i = 0; i < pools.length; i++) for (let j = i + 1; j < pools.length; j++) {
    const rec = {} as PairEvidence['channels'];
    for (const c of CHANNEL_IDS) rec[c] = { bits: 0, events: 0, insufficient: true };
    pairs.set(pairKey(pools[i], pools[j]), { a: pools[i], b: pools[j], total: 0, channels: rec });
  }
  const observations = {} as Record<ChannelId, Observation[]>;
  for (const c of CHANNEL_IDS) observations[c] = [];
  for (const ch of channels) {
    const r = ch.observe(input, p);
    observations[ch.id] = r.observations;
    for (const o of r.observations) {
      if (o.bits <= 0) continue;
      for (let i = 0; i < o.pools.length; i++) for (let j = i + 1; j < o.pools.length; j++) {
        const pe = pairs.get(pairKey(o.pools[i], o.pools[j]));
        if (pe) pe.channels[ch.id].bits += o.bits;
      }
    }
    r.comparable.forEach((n, k) => {
      const pe = pairs.get(k);
      if (pe) { pe.channels[ch.id].events = n; pe.channels[ch.id].insufficient = n < p.minEvents; }
    });
  }
  pairs.forEach(pe => {
    pe.total = CHANNEL_IDS.reduce((a, c) => a + (pe.channels[c].insufficient ? 0 : pe.channels[c].bits), 0);
  });
  return { pairs, observations };
}

export const pairsFor = (pairs: Map<string, PairEvidence>, a: string, b: string) => pairs.get(pairKey(a, b));
