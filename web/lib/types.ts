/**
 * Shared type definitions for the application
 */

/**
 * Represents mining data received from the data stream
 */
export interface MiningData {
  pool_name: string;
  timestamp: string;
  height: number;
  prev_hash: string;    // raw previous block hash (hex)
  version: string;      // version (e.g. "20000000")
  coinbase1: string;
  coinbase2: string;
  clean_jobs: boolean | string;
  first_transaction: string; // computed from merkle_branches
  fee_rate: number | string; // possibly empty on arrival
  merkle_branches: string[];
  merkle_branch_colors?: string[];
  extranonce1: string;
  extranonce2_length: number;
  coinbase_outputs?: { address: string; value: number }[];
  nbits?: string;
  ntime?: string;
} 