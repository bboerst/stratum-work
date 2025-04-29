/**
 * Shared type definitions for the application
 */

/**
 * Represents Stratum V1 data received from the data stream
 */
export interface StratumV1Data {
  pool_name: string;
  timestamp: string;
  job_id: string;
  height: number;
  prev_hash: string;    // raw previous block hash (hex)
  version: string;      // version (e.g. "20000000")
  coinbase1: string;
  coinbase2: string;
  extranonce1: string;
  extranonce2_length: number;
  clean_jobs: boolean | string;
  first_transaction: string; // computed from merkle_branches
  fee_rate: number | string; // possibly empty on arrival
  merkle_branches: string[];
  merkle_branch_colors?: string[];
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
  mining_pool?: {
    id: number;
    name: string;
    link?: string;
    slug?: string;
    match_type?: string;
    identification_method?: 'address' | 'tag';
  };
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

// Add type definitions that were missing exports
export interface DecodedOpReturnData {
    protocol: string;
    dataHex?: string;
    details?: {
        validatorAddress?: string;
        rewardAddress?: string;
        rskBlockHash?: string;
        synchronizerAccount?: string;
        auxBlockHash?: string;
        error?: string;
        [key: string]: unknown; 
    };
}

export interface CoinbaseOutput {
    type: 'address' | 'nulldata' | 'unknown';
    address?: string;
    value: number;
    hex?: string; 
    decodedData?: DecodedOpReturnData | null;
} 