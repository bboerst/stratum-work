"use client";

import React, { useEffect, useState, useRef, useMemo } from "react";
import ModeToggle from "@/components/ModeToggle";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Transaction, address, networks } from "bitcoinjs-lib";
import { StratumV1Data, StreamDataType } from "@/lib/types";
import { useGlobalDataStream } from "@/lib/DataStreamContext";

/* -----------------------------------
   Type Definitions
----------------------------------- */

// Internal "enhanced" row with derived fields
interface SortedRow extends StratumV1Data {
  coinbaseRaw: string;
  coinbaseScriptASCII: string;
  coinbaseOutputValue: number;
  feeRateComputed: number | string;
  coinbase_outputs: { address: string; value: number }[];
}

/* -----------------------------------
    Caching
----------------------------------- */
// For coinbase outputs
const coinbaseOutputsCache = new Map<string, { address: string; value: number }[]>();

// For coinbase script ASCII
const coinbaseScriptAsciiCache = new Map<string, string>();

// Track each pool's current coinbaseRaw, so we know when it changes
const poolCoinbaseMap = new Map<string, string>();

// For coinbase output values
const coinbaseOutputValueCache = new Map<string, number>();

/* -----------------------------------
   Helper Functions
----------------------------------- */

// Memo caches for colors:
const coinbaseColorCache = new Map<string, string>();
const merkleColorCache = new Map<string, string>();
const timeColorCache = new Map<string, string>();

// Reverse a hex string (e.g. for prev_block_hash)
function reverseHex(hex: string): string {
  return Buffer.from(hex, "hex").reverse().toString("hex");
}

// Format the previous block hash in normal endianness
function formatPrevBlockHash(raw: string): string {
  try {
    return reverseHex(raw);
  } catch {
    return raw;
  }
}

// Reconstruct the coinbase transaction from coinbase1 + extranonce1 + "00" * extranonce2_length + coinbase2
function formatCoinbaseRaw(
  coinbase1: string,
  extranonce1: string,
  extranonce2_length: number,
  coinbase2: string
): string {
  return coinbase1 + extranonce1 + "00".repeat(extranonce2_length) + coinbase2;
}

// Extract ASCII portion of the coinbase script from the first transaction input
function formatCoinbaseScriptASCII(coinbaseRaw: string): string {
  if (coinbaseScriptAsciiCache.has(coinbaseRaw)) {
    return coinbaseScriptAsciiCache.get(coinbaseRaw)!;
  }
  try {
    const tx = Transaction.fromHex(coinbaseRaw);
    // script hex from first input
    const scriptHex = tx.ins[0].script.toString("hex");
    // remove first 8 hex characters (4 bytes)
    const trimmed = scriptHex.slice(8);
    const ascii = Buffer.from(trimmed, "hex").toString("ascii");
    // filter out non-printable chars
    const printable = ascii
      .split("")
      .filter((ch) => ch >= " " && ch <= "~")
      .join("");
    const result = printable.length > 80 ? printable.substring(0, 80) + "…" : printable;

    coinbaseScriptAsciiCache.set(coinbaseRaw, result);
    return result;
  } catch (err) {
    console.error("Error parsing coinbase script:", err);
    return "";
  }
}

function hashCode(str: string): number {
  return str.split("").reduce((sum, c) => sum + c.charCodeAt(0), 0);
}

// Compute total satoshis in the coinbase transaction
function computeCoinbaseOutputValue(coinbaseRaw: string): number {
  if (coinbaseOutputValueCache.has(coinbaseRaw)) {
    return coinbaseOutputValueCache.get(coinbaseRaw)!;
  }
  try {
    const tx = Transaction.fromHex(coinbaseRaw);
    const totalSatoshis = tx.outs.reduce((sum, output) => sum + output.value, 0);
    const value = totalSatoshis / 1e8;
    coinbaseOutputValueCache.set(coinbaseRaw, value);
    return value;
  } catch {
    console.error("Error decoding coinbase transaction");
    return NaN;
  }
}

// The "first transaction" is usually the first merkle branch
function computeFirstTransaction(merkle_branches: string[]): string {
  if (!merkle_branches || merkle_branches.length === 0) {
    return "empty block";
  }
  try {
    const firstBranch = merkle_branches[0];
    return Buffer.from(firstBranch, "hex").reverse().toString("hex");
  } catch {
    console.error("Error computing first_transaction");
    return "empty block";
  }
}

// Extract all coinbase outputs that have a recognized address
function computeCoinbaseOutputs(coinbaseRaw: string): {
  address: string;
  value: number }[] {
    if (coinbaseOutputsCache.has(coinbaseRaw)) {
      return coinbaseOutputsCache.get(coinbaseRaw)!;
  }
  try {
    const tx = Transaction.fromHex(coinbaseRaw);
    const outputs = tx.outs.reduce((acc, out) => {
      try {
        const addr = address.fromOutputScript(out.script, networks.bitcoin);
        acc.push({ address: addr, value: out.value / 1e8 });
      } catch {
        // skip if address cannot be determined (e.g., OP_RETURN)
      }
      return acc;
    }, [] as { address: string; value: number }[]);

    coinbaseOutputsCache.set(coinbaseRaw, outputs);
    return outputs;
  } catch (err) {
    console.error("Error computing coinbase outputs:", err);
    return [];
  }
}

// Create a color from a set of coinbase outputs, for highlighting
function generateColorFromOutputs(
  outputs: { address: string; value: number }[]
): string {
  if (!outputs || outputs.length === 0) return "transparent";
  const filtered = outputs.filter((o) => !o.address.includes("nulldata"));
  const text = filtered.map((o) => `${o.address}:${o.value.toFixed(8)}`).join("|");
  // Memoize result:
  if (coinbaseColorCache.has(text)) {
    return coinbaseColorCache.get(text)!;
  }
  const hue = Math.abs(hashCode(text) % 360);
  const color = `hsl(${hue}, 60%, 80%)`;
  coinbaseColorCache.set(text, color);
  return color;
}

function getMerkleColor(branch: string): string {
  if (!branch) return "transparent";
  if (merkleColorCache.has(branch)) {
    return merkleColorCache.get(branch)!;
  }
  const hash = hashCode(branch);
  const hue = Math.abs(hash % 360);
  const lightness = 60 + (hash % 25);
  const color = `hsl(${hue}, 100%, ${lightness}%)`;
  merkleColorCache.set(branch, color);
  return color;
}

// Format ntime as unix time
function formatNtime(ntimeHex: string): string {
  try {
    const unixTime = parseInt(ntimeHex, 16)
    return unixTime.toString()
  } catch {
    return "N/A";
  }
}

// Fetch the fee rate from mempool.space
// Use a global in-flight map so we don't re-request the same txid
const inFlightRequests: { [txid: string]: boolean } = {};

async function fetchFeeRate(firstTxid: string): Promise<number | string> {
  try {
    // Check CPFP endpoint first
    const cpfpUrl = `https://mempool.space/api/v1/cpfp/${firstTxid}`;
    let resp = await fetch(cpfpUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data.effectiveFeePerVsize) {
        return Math.round(data.effectiveFeePerVsize);
      }
    }

    // If CPFP not found or invalid, fallback to /api/tx
    const txUrl = `https://mempool.space/api/tx/${firstTxid}`;
    resp = await fetch(txUrl);
    if (resp.ok) {
      const data = await resp.json();
      if (data.fee && data.weight) {
        return Math.round(data.fee / (data.weight / 4));
      }
    }
    return "not found";
  } catch (err) {
    console.error("Error fetching fee rate:", err);
    return "Error";
  }
}

function formatTimeReceived(tsHex: string): string {
  try {
    const ns = BigInt("0x" + tsHex)
    const ms = Number(ns / BigInt(1000000))
    const date = new Date(ms)
    const hh = date.getHours().toString().padStart(2, "0")
    const mm = date.getMinutes().toString().padStart(2, "0")
    const ss = date.getSeconds().toString().padStart(2, "0")
    const msec = date.getMilliseconds().toString().padStart(3, "0")
    return `${hh}:${mm}:${ss}.${msec}`
  } catch {
    return "Invalid time"
  }
}

// Generate a color from unix time string with drastic contrast based on the reversed unix time
function getTimeColor(unixTime: string): string {
  if (timeColorCache.has(unixTime)) return timeColorCache.get(unixTime)!;
  const reversed = unixTime.split("").reverse().join("");
  const num = parseInt(reversed, 10);
  const hue = Math.abs(num % 360);
  const color = `hsl(${hue}, 80%, 70%)`;
  timeColorCache.set(unixTime, color);
  return color;
}

/* -----------------------------------
   Interface for column-resizing
----------------------------------- */
interface ColumnWidths {
  [key: string]: number;
}

/* -----------------------------------
   Main RealtimeTable Component
----------------------------------- */
interface RealtimeTableProps {
  paused?: boolean;
  showSettings?: boolean;
  onShowSettingsChange?: (showSettings: boolean) => void;
}

export default function RealtimeTable({ 
  paused = false, 
  showSettings = false,
  onShowSettingsChange
}: RealtimeTableProps) {
  // Get data from the global data stream
  const { filterByType } = useGlobalDataStream();
  
  // Filter for only Stratum V1 data
  const stratumV1Data = useMemo(() => {
    const filtered = filterByType(StreamDataType.STRATUM_V1);
    return filtered.map(item => item.data as StratumV1Data);
  }, [filterByType]);
  
  // State for the table rows
  const [rows, setRows] = useState<StratumV1Data[]>([]);
  
  // Update rows when data changes
  useEffect(() => {
    if (paused) return;
    
    // Process each new data item to update caches
    stratumV1Data.forEach(data => {
      // Reconstruct the coinbaseRaw so we know its unique string
      const newCoinbaseRaw = formatCoinbaseRaw(
        data.coinbase1,
        data.extranonce1,
        data.extranonce2_length,
        data.coinbase2
      );
  
      // Check if this pool had a coinbaseRaw stored:
      const oldCoinbaseRaw = poolCoinbaseMap.get(data.pool_name);
      if (oldCoinbaseRaw && oldCoinbaseRaw !== newCoinbaseRaw) {
        // Remove the old coinbase from both caches
        coinbaseOutputsCache.delete(oldCoinbaseRaw);
        coinbaseScriptAsciiCache.delete(oldCoinbaseRaw);
        coinbaseOutputValueCache.delete(oldCoinbaseRaw);
      }
  
      // Store the new coinbaseRaw for this pool
      poolCoinbaseMap.set(data.pool_name, newCoinbaseRaw);
    });

    // Update rows state with the latest data
    setRows(stratumV1Data);
  }, [stratumV1Data, paused]);

  // Cached fee rates: txid -> (fee rate or "not found"/"error")
  const [feeRateMap, setFeeRateMap] = useState<{ [txid: string]: number | string }>({});

  // Sorting
  type SortDirection = "asc" | "desc";
  interface SortConfig {
    key: keyof SortedRow;
    direction: SortDirection;
  }
  const [sortConfig, setSortConfig] = useState<SortConfig>({
    key: "coinbaseOutputValue",
    direction: "desc",
  });

  // Column Visibility
  const [columnsVisible, setColumnsVisible] = useState<{ [key: string]: boolean }>({
    // Visible by default
    pool_name: true,
    height: true,
    prev_hash: false,
    coinbaseScriptASCII: true,
    clean_jobs: false,
    first_transaction: true,
    fee_rate: true,
    version: false,
    nbits: false,
    coinbaseRaw: false,
    timestamp: true,
    ntime: true,
    coinbase_outputs: true,
    coinbaseOutputValue: true,
  });

  // Show/hide column settings panel
  const settingsRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------------
  // State for column widths and logic for resizing
  // ---------------------------------------------------------------------
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>({
    pool_name: 130,
    height: 65,
    prev_hash: 60,
    coinbaseScriptASCII: 100,
    coinbase_outputs: 50,
    clean_jobs: 60,
    first_transaction: 90,
    fee_rate: 50,
    version: 60,
    nbits: 60,
    timestamp: 85,
    ntime: 72,
    coinbaseRaw: 120,
    coinbaseOutputValue: 65,
  });

  // Load widths from local storage
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("columnWidths");
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as ColumnWidths;
          setColumnWidths((prev) => ({ ...prev, ...parsed }));
        } catch {
          // ignore parse errors
        }
      }
    }
  }, []);

  // Save widths to local storage
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("columnWidths", JSON.stringify(columnWidths));
    }
  }, [columnWidths]);

  const isResizing = useRef(false);
  const currentColKey = useRef<string | null>(null);
  const startX = useRef<number>(0);
  const startWidth = useRef<number>(0);
  const resizeActiveRef = useRef(false);

  const handleMouseDown = (colKey: string, e: React.MouseEvent) => {
    isResizing.current = true;
    currentColKey.current = colKey;
    startX.current = e.clientX;
    startWidth.current = columnWidths[colKey] ?? 80;
    resizeActiveRef.current = false;
    // Prevent text selection
    document.body.style.userSelect = "none";
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isResizing.current || !currentColKey.current) return;
    const diff = e.clientX - startX.current;
    if (Math.abs(diff) > 5) resizeActiveRef.current = true;
    const newWidth = Math.max(40, startWidth.current + diff);
    setColumnWidths((prev) => ({
      ...prev,
      [currentColKey.current as string]: newWidth,
    }));
  };

  const handleMouseUp = () => {
    isResizing.current = false;
    currentColKey.current = null;
    document.body.style.userSelect = "";
  };

  useEffect(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);
  // ---------------------------------------------------------------------

  // Column settings to be toggled in the UI
  const mainColumns: { key: keyof SortedRow; label: string }[] = [
    { key: "pool_name", label: "Pool Name" },
    { key: "height", label: "Height" },
    { key: "prev_hash", label: "Prev Block Hash" },
    { key: "coinbaseScriptASCII", label: "Coinbase Script (ASCII)" },
    { key: "clean_jobs", label: "Clean Jobs" },
    { key: "first_transaction", label: "First Tx" },
    { key: "fee_rate", label: "Fee Rate" },
    { key: "version", label: "Version" },
    { key: "nbits", label: "Nbits" },
    { key: "coinbaseRaw", label: "Coinbase RAW" },
    { key: "timestamp", label: "Time Received" },
    { key: "ntime", label: "Ntime" },
    { key: "coinbase_outputs", label: "Coinbase Outputs" },
    { key: "coinbaseOutputValue", label: "Coinbase Output Value" },
  ];

  // Compute derived fields
  const computedRows: SortedRow[] = useMemo(() => {
    return rows.map((row) => {
      const coinbaseRaw = formatCoinbaseRaw(
        row.coinbase1,
        row.extranonce1,
        row.extranonce2_length,
        row.coinbase2
      );
      const coinbaseScriptASCII = formatCoinbaseScriptASCII(coinbaseRaw);
      const coinbaseOutputValue = computeCoinbaseOutputValue(coinbaseRaw);
      const computedFirstTx = computeFirstTransaction(row.merkle_branches);
      // Fee rate from our cache if available, otherwise row.fee_rate
      const feeRateComputed = feeRateMap[computedFirstTx] ?? row.fee_rate;
      const coinbase_outputs = computeCoinbaseOutputs(coinbaseRaw);

      return {
        ...row,
        coinbaseRaw,
        coinbaseScriptASCII,
        coinbaseOutputValue,
        first_transaction: computedFirstTx,
        feeRateComputed,
        coinbase_outputs,
      };
    });
  }, [rows, feeRateMap]);

  // Cache or fetch missing fee rates, but never re-fetch the same txid
  useEffect(() => {
    // For each row, see if we need to fetch its fee rate
    computedRows.forEach((row) => {
      // Skip empty block or if we already have a numeric (or any) feeRate in feeRateMap
      if (!row.first_transaction || row.first_transaction === "empty block") return;

      const txid = row.first_transaction;
      // We only fetch if it's not in our cache AND not already in-flight
      if (!feeRateMap[txid] && !inFlightRequests[txid]) {
        inFlightRequests[txid] = true;
        fetchFeeRate(txid).then((rate) => {
          setFeeRateMap((prev) => ({ ...prev, [txid]: rate }));
          delete inFlightRequests[txid]; // done
        });
      }
    });
  }, [computedRows, feeRateMap]);

  // Sorting
  const sortedRows = useMemo(() => {
    const arr = [...computedRows];
    const { key, direction } = sortConfig;
    arr.sort((a, b) => {
      let valA = a[key];
      let valB = b[key];
      // For numeric sorts
      if (typeof valA === "number" && typeof valB === "number") {
        return direction === "asc" ? valA - valB : valB - valA;
      }
      // Otherwise compare as strings
      valA = String(valA);
      valB = String(valB);
      if (valA < valB) return direction === "asc" ? -1 : 1;
      if (valA > valB) return direction === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [computedRows, sortConfig]);

  // handle column sorting
  const handleSort = (key: keyof SortedRow) => {
    setSortConfig((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: "asc" };
    });
  };

  function renderSortIndicator(key: keyof SortedRow) {
    if (sortConfig.key !== key) return null;
    const arrow = sortConfig.direction === "asc" ? "↑" : "↓";
    return (
      <span className="sort-arrow inline-block w-5 h-5 bg-black text-white text-lg font-bold text-center leading-4 ml-1 rounded">
        {arrow}
      </span>
    );
  }

  // Toggle columns
  const toggleColumn = (colKey: string) => {
    setColumnsVisible((prev) => ({ ...prev, [colKey]: !prev[colKey] }));
  };

  // Auto-hide settings panel if clicked outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        // Notify parent component of settings change
        onShowSettingsChange?.(false);
      }
    };
    if (showSettings) {
      document.addEventListener("mousedown", handleClickOutside);
    } else {
      document.removeEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showSettings, onShowSettingsChange]);

  return (
    <div className="p-4 font-mono w-full overflow-x-auto relative">
      {/* Column Settings Dropdown */}
      {showSettings && (
        <div
          ref={settingsRef}
          className="settings-dropdown absolute top-4 right-4 bg-white dark:bg-[#1e1e2f] border border-gray-300 dark:border-gray-700 shadow-md rounded p-2 z-50"
        >          
          <div>
            <ModeToggle />
            <div className="font-bold text-sm">Toggle Columns</div>
          </div>
          {mainColumns.map((col) => (
            <label key={col.key} className="block text-sm">
              <input
                type="checkbox"
                className="mr-1"
                checked={columnsVisible[col.key]}
                onChange={() => toggleColumn(col.key.toString())}
              />
              {col.label}
            </label>
          ))}
        </div>
      )}

      {/* The Table */}
      <Table className="w-full table-fixed">
        <TableHeader>
          <TableRow>
            {columnsVisible.pool_name && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("pool_name");
                }}
                className="relative p-1 text-xs border-r-2 w-[130px] cursor-pointer select-none"
                style={{ width: columnWidths.pool_name }}
              >
                Pool Name{renderSortIndicator("pool_name")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("pool_name", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.height && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("height");
                }}
                className="relative p-1 border-r-2 text-xs w-[65px] cursor-pointer select-none"
                style={{ width: columnWidths.height }}
              >
                Height{renderSortIndicator("height")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("height", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.prev_hash && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("prev_hash");
                }}
                className="relative p-1 border-r-2 text-xs w-[60px] cursor-pointer select-none"
                style={{ width: columnWidths.prev_hash }}
              >
                Prev Block Hash{renderSortIndicator("prev_hash")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("prev_hash", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.coinbaseScriptASCII && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("coinbaseScriptASCII");
                }}
                className="relative p-1 border-r-2 text-xs w-[100px] cursor-pointer select-none"
                style={{ width: columnWidths.coinbaseScriptASCII }}
              >
                Coinbase Script (ASCII){renderSortIndicator("coinbaseScriptASCII")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("coinbaseScriptASCII", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.clean_jobs && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("clean_jobs");
                }}
                className="relative p-1 border-r-2 text-xs w-[60px] cursor-pointer select-none"
                style={{ width: columnWidths.clean_jobs }}
              >
                Clean Jobs{renderSortIndicator("clean_jobs")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("clean_jobs", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.first_transaction && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("first_transaction");
                }}
                className="relative p-1 border-r-2 text-xs w-[90px] cursor-pointer select-none"
                style={{ width: columnWidths.first_transaction }}
              >
                First Tx{renderSortIndicator("first_transaction")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("first_transaction", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.fee_rate && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("fee_rate");
                }}
                className="relative p-1 border-r-2 text-xs w-[90px] cursor-pointer select-none"
                style={{ width: columnWidths.fee_rate }}
              >
                First Tx Fee Rate{renderSortIndicator("fee_rate")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("fee_rate", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.version && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("version");
                }}
                className="relative p-1 border-r-2 text-xs w-[60px] cursor-pointer select-none"
                style={{ width: columnWidths.version }}
              >
                Version{renderSortIndicator("version")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("version", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.nbits && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("nbits");
                }}
                className="relative p-1 border-r-2 text-xs w-[60px] cursor-pointer select-none"
                style={{ width: columnWidths.nbits }}
              >
                Nbits
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("nbits", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.coinbaseRaw && (
              <TableHead
                className="relative p-1 border-r-2 text-xs w-[120px] cursor-pointer select-none"
                style={{ width: columnWidths.coinbaseRaw }}
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("coinbaseRaw");
                }}
              >
                Coinbase RAW{renderSortIndicator("coinbaseRaw")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("coinbaseRaw", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.timestamp && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("timestamp");
                }}
                className="relative p-1 border-r-2 text-xs w-[80px] cursor-pointer select-none"
                style={{ width: columnWidths.timestamp }}
              >
                Time Received{renderSortIndicator("timestamp")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("timestamp", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.ntime && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("ntime");
                }}
                className="relative p-1 border-r-2 text-xs cursor-pointer select-none"
                style={{ width: columnWidths.ntime }}
              >
                Ntime{renderSortIndicator("ntime")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("ntime", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {/* Merkle branches: always shown; 13 columns */}
            {Array.from({ length: 13 }).map((_, i) => (
              <TableHead
                key={i}
                className="p-1 border-r-2 text-xs max-w-[30px] w-12"
              >
                Merk. {i}
              </TableHead>
            ))}
            {columnsVisible.coinbase_outputs && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("coinbase_outputs");
                }}
                className="relative p-1 border-r-2 text-xs w-[100px] cursor-pointer select-none"
                style={{ width: columnWidths.coinbase_outputs }}
              >
                Coinbase Outputs
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("coinbase_outputs", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
            {columnsVisible.coinbaseOutputValue && (
              <TableHead
                onClick={() => {
                  if (resizeActiveRef.current) {
                    resizeActiveRef.current = false;
                    return;
                  }
                  handleSort("coinbaseOutputValue");
                }}
                className="relative p-1 text-xs w-[100px] cursor-pointer select-none"
                style={{ width: columnWidths.coinbaseOutputValue }}
              >
                Coinbase Output Value{renderSortIndicator("coinbaseOutputValue")}
                <div
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    handleMouseDown("coinbaseOutputValue", e);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
                />
              </TableHead>
            )}
          </TableRow>
        </TableHeader>

        <TableBody>
          {sortedRows.map((row, idx) => (
            <TableRow key={idx} className="hover:bg-gray-200 dark:hover:bg-gray-800">
              {columnsVisible.pool_name && (
                <TableCell
                  style={{ width: columnWidths.pool_name }}
                  className="p-1 truncate"
                  title={row.pool_name}
                >
                  {row.pool_name}
                </TableCell>
              )}
              {columnsVisible.height && (
                <TableCell
                  style={{ width: columnWidths.height }}
                  className="p-1 truncate"
                >
                  {row.height}
                </TableCell>
              )}
              {columnsVisible.prev_hash && (
                <TableCell
                  style={{ width: columnWidths.prev_hash }}
                  className="p-1 truncate"
                  title={formatPrevBlockHash(row.prev_hash)}
                >
                  {formatPrevBlockHash(row.prev_hash)}
                </TableCell>
              )}
              {columnsVisible.coinbaseScriptASCII && (
                <TableCell
                  style={{ width: columnWidths.coinbaseScriptASCII }}
                  className="p-1 truncate"
                  title={row.coinbaseScriptASCII}
                >
                  {row.coinbaseScriptASCII}
                </TableCell>
              )}
              {columnsVisible.clean_jobs && (
                <TableCell
                  style={{ width: columnWidths.clean_jobs }}
                  className="p-1 truncate"
                >
                  {row.clean_jobs?.toString() || "N/A"}
                </TableCell>
              )}
              {columnsVisible.first_transaction && (
                <TableCell
                  style={{ width: columnWidths.first_transaction }}
                  className="p-1 truncate"
                >
                  {row.first_transaction && row.first_transaction !== "empty block" ? (
                    <a
                      href={`https://mempool.space/tx/${row.first_transaction}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-500 underline"
                      title={row.first_transaction}
                    >
                      {row.first_transaction}
                    </a>
                  ) : (
                    "N/A"
                  )}
                </TableCell>
              )}
              {columnsVisible.fee_rate && (
                <TableCell
                  style={{ width: columnWidths.fee_rate }}
                  className="p-1 truncate"
                >
                  {typeof row.feeRateComputed === "number"
                    ? row.feeRateComputed
                    : row.feeRateComputed || "N/A"}
                </TableCell>
              )}
              {columnsVisible.version && (
                <TableCell
                  style={{ width: columnWidths.version }}
                  className="p-1 truncate"
                >
                  {row.version}
                </TableCell>
              )}
              {columnsVisible.nbits && (
                <TableCell
                  style={{ width: columnWidths.nbits }}
                  className="p-1 truncate"
                >
                  {row.nbits || "N/A"}
                </TableCell>
              )}
              {columnsVisible.coinbaseRaw && (
                <TableCell
                  style={{ width: columnWidths.coinbaseRaw }}
                  className="p-1 truncate"
                  title={row.coinbaseRaw}
                >
                  {row.coinbaseRaw}
                </TableCell>
              )}
              {columnsVisible.timestamp && (
                <TableCell
                  style={{ width: columnWidths.timestamp }}
                  className="p-1 truncate"
                  title={formatTimeReceived(row.timestamp)}
                >
                  {formatTimeReceived(row.timestamp)}
                </TableCell>
              )}
              {columnsVisible.ntime && (
                <TableCell
                  style={{ 
                    width: columnWidths.ntime,
                    backgroundColor: row.ntime ? getTimeColor(formatNtime(row.ntime)) : "transparent",
                    border: row.ntime ? `1px solid ${getTimeColor(formatNtime(row.ntime))}` : "1px solid transparent"
                  }}
                  className="p-1 truncate text-black"
                >
                  {row.ntime ? formatNtime(row.ntime) : "N/A"}
                </TableCell>
              )}
              {/* Merkle branch columns */}
              {Array.from({ length: 13 }).map((_, i) => {
                let bg = "transparent";
                if (row.merkle_branch_colors && row.merkle_branch_colors[i]) {
                  bg = row.merkle_branch_colors[i];
                } else if (row.merkle_branches && row.merkle_branches[i]) {
                  bg = getMerkleColor(row.merkle_branches[i]);
                }
                const branchValue = row.merkle_branches
                  ? row.merkle_branches[i] || ""
                  : "";
                return (
                  <TableCell
                    key={i}
                    className="p-1 truncate text-sm text-black"
                    style={{ backgroundColor: bg, border: `1px solid ${bg}` }}
                    title={branchValue}
                  >
                    {branchValue}
                  </TableCell>
                );
              })}
              {columnsVisible.coinbase_outputs && (
                <TableCell
                  className="p-1 truncate text-black"
                  title={
                    row.coinbase_outputs && row.coinbase_outputs.length
                      ? row.coinbase_outputs
                          .filter((o) => !o.address.includes("nulldata"))
                          .map((o) => `${o.address}:${o.value.toFixed(8)}`)
                          .join(" | ")
                      : "N/A"
                  }
                  style={{
                    ...{
                      width: columnWidths.coinbase_outputs,
                    },
                    backgroundColor: generateColorFromOutputs(
                      row.coinbase_outputs || []
                    ),
                    border: `1px solid ${generateColorFromOutputs(
                      row.coinbase_outputs || []
                    )}`,
                  }}
                >
                  {row.coinbase_outputs && row.coinbase_outputs.length
                    ? row.coinbase_outputs
                        .filter((o) => !o.address.includes("nulldata"))
                        .map((o) => `${o.address}:${o.value.toFixed(8)}`)
                        .join(" | ")
                    : "N/A"}
                </TableCell>
              )}
              {columnsVisible.coinbaseOutputValue && (
                <TableCell
                  style={{ width: columnWidths.coinbaseOutputValue }}
                  className="p-1 truncate"
                >
                  {isNaN(row.coinbaseOutputValue)
                    ? "N/A"
                    : row.coinbaseOutputValue.toFixed(8)}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {/* Show waiting message if no rows */}
      {sortedRows.length === 0 && (
        <div className="text-center text-black dark:text-white pt-10 mb-4">
          Wait for new stratum messages...
        </div>
      )}
    </div>
  );
}