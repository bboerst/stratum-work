import type { StratumV1Data } from '@/lib/types';
import type { SortedRow } from '@/types/tableTypes';

/**
 * A table row back to the template it was built from, for the timing chart on a height page (HistoricalDataContext).
 * The receive time, own receive time and connection must survive: change detection orders and compares by them.
 */
export function sortedRowToStratum(row: SortedRow): StratumV1Data {
  return {
    pool_name: row.pool_name,
    timestamp: row.raw_timestamp ?? row.timestamp,
    received_timestamp: row.received_timestamp,
    source_id: row.source_id,
    site: row.site,
    replica: row.replica,
    lat_ms: row.lat_ms,
    lat_m: row.lat_m,
    job_id: row.job_id,
    height: row.height,
    prev_hash: row.prev_hash,
    version: row.version,
    coinbase1: row.coinbase1,
    coinbase2: row.coinbase2,
    merkle_branches: row.merkle_branches,
    nbits: row.nbits || '',
    ntime: row.ntime || '',
    clean_jobs: row.clean_jobs,
    extranonce1: row.extranonce1,
    extranonce2_length: row.extranonce2_length,
    coinbase_outputs: row.coinbase_outputs
      .filter(output => output.address !== undefined)
      .map(output => ({ address: output.address!, value: output.value })),
    first_transaction: row.first_transaction,
    fee_rate: row.fee_rate,
    merkle_branch_colors: row.merkle_branch_colors,
  };
}
