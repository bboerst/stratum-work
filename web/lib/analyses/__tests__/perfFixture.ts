import type { RawTemplate } from '@/lib/templates/types';
import { CB1, tsHex } from '@/lib/templates/__tests__/fixtures';

const WINDOW_MS = 60 * 60_000;
const TIP_MS = 10 * 60_000;
const GROUPS = 5;
const BRANCHES = 12;

/** Deterministic PRNG (mulberry32) so budgets are measured on identical input every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (n: number, bytes: number) => (n >>> 0).toString(16).padStart(8, '0').repeat(Math.ceil(bytes / 4)).slice(0, bytes * 2);

/** coinbase2: sequence, P2WPKH payout (per pool), optional RSK OP_RETURN, witness commitment, locktime. */
function coinbase2(pool: number, rsk: string | null): string {
  const payout = 'c0e5a11200000000' + '16' + '0014' + hex(0x1000 + pool, 20);
  const rskOut = rsk ? '0000000000000000' + '2b' + '6a29' + '52534b424c4f434b3a' + rsk : '';
  const witness = '0000000000000000' + '26' + '6a24aa21a9ed' + '22'.repeat(32);
  return 'ffffffff' + (rsk ? '03' : '02') + payout + rskOut + witness + '00000000';
}

/**
 * `n` templates from `pools` pools spread over the 60 min before `nowMs`: pools fall into 5 clone groups
 * that share 12-branch merkle sets, a new tip every ~10 min, a template change every ~20–40 s per group,
 * and RSK commitments in 30% of pools (one commitment per group change).
 */
export function makeRealisticRaws(n: number, pools: number, nowMs: number): RawTemplate[] {
  const r = rng(42);
  const start = nowMs - WINDOW_MS + 1000;
  const end = nowMs - 1000;
  const tips: number[] = [];
  for (let t = start + r() * 60_000; t < end; t += TIP_MS + (r() - 0.5) * 120_000) tips.push(t);
  const changes: number[][] = Array.from({ length: GROUPS }, () => {
    const out: number[] = [];
    for (let t = start; t < end; t += 20_000 + r() * 20_000) out.push(t);
    return out;
  });
  const lastBefore = (list: number[], t: number) => { let lo = 0, hi = list.length - 1, ans = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m] <= t) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; };
  // Each group sees each tip after its own 0–8 s delay (clones within ~100 ms of each other), so independent
  // groups do not switch in lockstep.
  const groupTips = Array.from({ length: GROUPS }, () => tips.map(t => t + r() * 8000));
  const poolTips = Array.from({ length: pools }, (_, p) => groupTips[p % GROUPS].map(t => t + r() * 100));
  const rskPool = (p: number) => p % 10 < 3;
  const perPool = Math.ceil(n / pools);
  const step = (end - start) / perPool;
  const out: RawTemplate[] = [];
  for (let k = 0; k < perPool && out.length < n; k++) {
    for (let p = 0; p < pools && out.length < n; p++) {
      const g = p % GROUPS;
      const at = Math.floor(start + k * step + r() * step * 0.9);
      const tip = Math.max(0, lastBefore(poolTips[p], at));
      const ch = Math.max(0, lastBefore(changes[g], at));
      const branches = Array.from({ length: BRANCHES }, (_, b) => hex(((g * 1000 + ch) * 31 + b) * 2654435761, 32));
      out.push({
        pool_name: `Pool${p}`, timestamp: tsHex(at), job_id: `p${p}k${k}`, height: 840_000 + tip,
        prev_hash: hex(0xabc000 + tip, 32), version: '20000000', coinbase1: CB1,
        coinbase2: coinbase2(p, rskPool(p) ? hex(0x5000 + g * 10_000 + ch, 32) : null),
        extranonce1: 'aabbccdd', extranonce2_length: 4, clean_jobs: at - (poolTips[p][tip] ?? 0) < step, first_transaction: '',
        fee_rate: '', merkle_branches: branches, nbits: '17034219', ntime: Math.floor(at / 1000).toString(16),
      });
    }
  }
  return out.sort((a, b) => (BigInt('0x' + a.timestamp) < BigInt('0x' + b.timestamp) ? -1 : 1));
}
