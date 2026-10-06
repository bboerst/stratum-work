import { createHash } from 'node:crypto';
export function templateContentKey(j: Record<string, any>): string {
  const parts = [j.prev_hash, j.coinbase1, j.coinbase2, j.merkle_branches, j.version, j.nbits, j.clean_jobs, j.height];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
