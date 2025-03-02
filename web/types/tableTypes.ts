import { StratumV1Data } from "@/lib/types";

// Enhanced row with derived fields
export interface SortedRow extends StratumV1Data {
  coinbaseRaw: string;
  coinbaseScriptASCII: string;
  coinbaseOutputValue: number;
  feeRateComputed: number | string;
  coinbase_outputs: { address: string; value: number }[];
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