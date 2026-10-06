import type { CoinbaseOutputDetail } from '@/utils/bitcoinUtils';
import { processTemplateData } from '@/utils/templateDataProcessor';
import { parseMessageTimestampMs } from '@/utils/templateChangeDetection';
import type { Identity, RawTemplate, Template } from './types';

export const LEGACY_SITE = 'us-ash-legacy';

const MM_PROTOCOLS: Record<string, string> = {
  'RSK Block': 'RSK', CoreDAO: 'CoreDAO', 'Hathor Network': 'Hathor', Syscoin: 'Syscoin', ExSat: 'ExSat',
  'Stacks Block Commit': 'Stacks',
};

export function subsidySats(height: number): number {
  const halvings = Math.floor(height / 210_000);
  return halvings >= 64 ? 0 : Math.floor(5_000_000_000 / 2 ** halvings);
}

export function txCountRange(branchCount: number): [number, number] {
  return branchCount <= 0 ? [0, 0] : [2 ** (branchCount - 1), 2 ** branchCount];
}

export function mergeMiningCommitments(outputs: CoinbaseOutputDetail[], auxPowHash?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of outputs) {
    const key = o.decodedData ? MM_PROTOCOLS[o.decodedData.protocol] : undefined;
    if (key) out[key] = o.decodedData!.dataHex;
  }
  if (auxPowHash) out.AuxPOW = auxPowHash;
  return out;
}

export function templateContentKey(r: RawTemplate): string {
  return [r.prev_hash, r.coinbase1, r.coinbase2, (r.merkle_branches ?? []).join(','), r.version, r.nbits ?? '',
    String(r.clean_jobs === true || r.clean_jobs === 'true'), r.height].join('\u0001');
}

/** scriptSig hex of the coinbase input (what the Python identifier decodes as text). */
function coinbaseScriptHex(coinbaseRaw: string): string {
  // version(4) + input count(1) + prev txid(32) + vout(4) = 41 bytes, then a 1-byte script length (<0xfd).
  const lenAt = 82;
  const len = parseInt(coinbaseRaw.slice(lenAt, lenAt + 2), 16);
  return Number.isFinite(len) ? coinbaseRaw.slice(lenAt + 2, lenAt + 2 + len * 2) : '';
}

export function templateMid(raw: RawTemplate): string {
  return raw._mid ?? `${raw.connection_id ?? raw.pool_name}|${raw.timestamp}|${raw.job_id}`;
}

export function decodeTemplate(raw: RawTemplate, mid: string, identify: (scriptHex: string, addresses: string[]) => Identity): Template {
  const p = processTemplateData(raw);
  const outputs = p.coinbaseOutputs ?? [];
  const total = outputs.reduce((a, o) => a + (o.value ?? 0), 0);
  const payoutAddresses = [...new Set(outputs.filter(o => o.type === 'address' && o.address).map(o => o.address!))];
  const scriptHex = p.coinbaseRaw ? coinbaseScriptHex(p.coinbaseRaw) : '';
  const branches = raw.merkle_branches ?? [];
  return {
    mid, pool: raw.pool_name, connectionId: raw.connection_id ?? raw.pool_name, site: raw.site ?? LEGACY_SITE,
    mode: raw.mode === 'work' ? 'work' : 'observe', account: raw.account,
    receivedAtMs: parseMessageTimestampMs(raw.timestamp), latencyMs: typeof raw.lat_ms === 'number' ? raw.lat_ms : null,
    height: raw.height, prevHash: raw.prev_hash, version: raw.version, nbits: raw.nbits, ntime: raw.ntime,
    cleanJobs: raw.clean_jobs === true || raw.clean_jobs === 'true', merkleBranches: branches,
    txCountRange: txCountRange(branches.length), coinbaseOutputs: outputs, payoutAddresses,
    coinbaseTag: p.coinbaseScriptASCII ?? '', coinbaseScriptHex: scriptHex, totalOutputSats: total,
    feesSats: Math.max(0, total - subsidySats(raw.height)),
    mergeMiningCommitments: mergeMiningCommitments(outputs, p.auxPowHash),
    identity: identify(scriptHex, payoutAddresses), contentKey: templateContentKey(raw), raw,
  };
}
