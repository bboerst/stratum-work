/**
 * Shared type definitions for the application
 */

/**
 * Represents Stratum V1 data received from the data stream
 */
export interface StratumV1Data {
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

/**
 * Represents Bitcoin block data
 */
export interface BlockData {
  hash: string;
  height: number;
  timestamp: string;
  size: number;
  weight: number;
  version: number;
  merkle_root: string;
  nonce: number;
  bits: string;
  difficulty: number;
  transaction_count: number;
  prev_block_hash: string;
}

/**
 * Enum of supported data stream types
 */
export enum StreamDataType {
  STRATUM_V1 = 'stratum_v1',
  BLOCK = 'block'
}

/**
 * Base interface for all stream data with common fields
 */
export interface BaseStreamData {
  type: StreamDataType;
  id: string;
  timestamp: string;
}

/**
 * Union type for all possible stream data types
 */
export type StreamData = 
  | (BaseStreamData & { type: StreamDataType.STRATUM_V1, data: StratumV1Data })
  | (BaseStreamData & { type: StreamDataType.BLOCK, data: BlockData }); 