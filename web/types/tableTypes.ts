import { CoinbaseOutputDetail, AuxPowData } from "@/utils/bitcoinUtils";

// Enhanced row with derived fields
export interface SortedRow {
  // Fields from StratumV1Data (excluding coinbase_outputs)
  pool_name: string;
  timestamp: string; // ISO string format from collector
  job_id: string;
  height: number;
  prev_hash: string;
  version: string;
  coinbase1: string;
  coinbase2: string;
  extranonce1: string;
  extranonce2_length: number;
  clean_jobs: boolean | string;
  first_transaction: string;
  fee_rate: number | string;
  merkle_branches: string[];
  merkle_branch_colors?: string[];
  nbits?: string;
  ntime?: string;

  // Derived/added fields
  coinbaseRaw: string;
  coinbaseScriptASCII: string;
  coinbaseOutputValue: number;
  feeRateComputed: number | string; // Potentially updated fee rate
  coinbase_outputs: CoinbaseOutputDetail[]; // Use the detailed type
  auxPowData?: AuxPowData | null; // Added AuxPOW data
  coinbaseHeight?: number | null; // Added height parsed from coinbase scriptSig
  // Added other coinbase tx details
  txVersion?: number;
  inputSequence?: number;
  txLocktime?: number;
  witnessCommitmentNonce?: string | null;
}

// Sort direction type
export type SortDirection = "asc" | "desc";

// Sort configuration
export interface SortConfig {
  key: keyof SortedRow;
  direction: SortDirection;
}

// Column widths
export interface ColumnWidths {
  [key: string]: number;
}

// Main component props
export interface RealtimeTableProps {
  paused?: boolean;
  showSettings?: boolean;
  onShowSettingsChange?: (showSettings: boolean) => void;
  filterBlockHeight?: number;
} 