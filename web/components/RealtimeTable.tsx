"use client";

import React, { useEffect, useState, useRef, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Transaction, address, networks } from "bitcoinjs-lib";

/* -----------------------------------
   Type Definitions
----------------------------------- */
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

// Internal "enhanced" row with derived fields
interface SortedRow extends MiningData {
  coinbaseRaw: string;
  coinbaseScriptASCII: string;
  coinbaseOutputValue: number;
  feeRateComputed: number | string;
  coinbase_outputs: { address: string; value: number }[];
}

/* -----------------------------------
   Helper Functions
----------------------------------- */

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
    return printable.length > 80 ? printable.substring(0, 80) + "…" : printable;
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
  try {
    const tx = Transaction.fromHex(coinbaseRaw);
    const totalSatoshis = tx.outs.reduce((sum, output) => sum + output.value, 0);
    return totalSatoshis / 1e8;
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
  value: number;
}[] {
  try {
    const tx = Transaction.fromHex(coinbaseRaw);
    return tx.outs.reduce((acc, out) => {
      try {
        const addr = address.fromOutputScript(out.script, networks.bitcoin);
        acc.push({ address: addr, value: out.value / 1e8 });
      } catch {
        // skip if address cannot be determined (e.g., OP_RETURN)
      }
      return acc;
    }, [] as { address: string; value: number }[]);
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
  const hue = Math.abs(hashCode(text) % 360);
  return `hsl(${hue}, 60%, 80%)`;
}

// Format ntime as HH:MM:SS
function formatNtime(ntimeHex: string): string {
  try {
    const timestamp = parseInt(ntimeHex, 16) * 1000;
    const date = new Date(timestamp);
    return date.toISOString().substr(11, 8);
  } catch {
    return "N/A";
  }
}

// Actually fetch the fee rate from mempool.space
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

// Format a timestamp as HH:MM:SS from the UTC date
function formatTimestamp(ts: string): string {
  const date = new Date(ts);
  return date.toISOString().substr(11, 8);
}

/* -----------------------------------
   Main RealtimeTable Component
----------------------------------- */
export default function RealtimeTable() {
  // SSE rows
  const [rows, setRows] = useState<MiningData[]>([]);

  // Whether SSE updates are paused
  const [paused, setPaused] = useState<boolean>(false);

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
    timestamp: true,
    height: true,
    prev_hash: true,
    coinbaseScriptASCII: true,
    coinbase_outputs: true,
    first_transaction: true,
    fee_rate: true,
    coinbaseOutputValue: true,
    // Hidden by default
    clean_jobs: false,
    version: false,
    nbits: false,
    ntime: false,
    coinbaseRaw: false,
  });

  // Show/hide column settings panel
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  // ---------------------- SSE subscription ----------------------
  useEffect(() => {
    let evtSource: EventSource | null = null;
    let reconnectFrequencySeconds = 1;
    let reconnectTimeout: NodeJS.Timeout | null = null;

    const setupEventSource = () => {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      // Connect to your SSE endpoint
      evtSource = new EventSource("/api/stream");

      evtSource.onmessage = (event) => {
        if (paused) return;
        try {
          const data: MiningData = JSON.parse(event.data);
          setRows((prev) => {
            // Remove any existing row for the same pool_name, then add the new one
            const withoutPool = prev.filter((r) => r.pool_name !== data.pool_name);
            return [...withoutPool, data];
          });
        } catch {
          console.error("Error parsing SSE data");
        }
      };

      evtSource.onopen = () => {
        console.log("SSE connected");
        reconnectFrequencySeconds = 1;
      };

      evtSource.onerror = () => {
        console.log("SSE error, reconnecting...");
        evtSource?.close();
        reconnectTimeout = setTimeout(() => {
          setupEventSource();
          reconnectFrequencySeconds = Math.min(reconnectFrequencySeconds * 1.75, 18);
        }, reconnectFrequencySeconds * 1000);
      };
    };

    setupEventSource();

    // Cleanup
    return () => {
      evtSource?.close();
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
    };
  }, [paused]);

  // ---------------------- Compute Derived Fields ----------------------
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

  // ---------------------- Cache or fetch missing fee rates ----------------------
  useEffect(() => {
    // For each row, if we don't have a feeRateMap entry, fetch & store it
    computedRows.forEach((row) => {
      if (
        row.first_transaction &&
        row.first_transaction !== "empty block" &&
        !feeRateMap[row.first_transaction] && // not in cache yet
        typeof row.feeRateComputed !== "number"
      ) {
        fetchFeeRate(row.first_transaction).then((rate) => {
          setFeeRateMap((prev) => ({ ...prev, [row.first_transaction]: rate }));
        });
      }
    });
  }, [computedRows, feeRateMap]);

  // ---------------------- Sorting ----------------------
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
    return sortConfig.direction === "asc" ? " ↑" : " ↓";
  }

  // ---------------------- Column Toggling ----------------------
  const toggleColumn = (colKey: string) => {
    setColumnsVisible((prev) => ({ ...prev, [colKey]: !prev[colKey] }));
  };

  // Column settings to be toggled in the UI
  const mainColumns: { key: keyof SortedRow; label: string }[] = [
    { key: "pool_name", label: "Pool Name" },
    { key: "timestamp", label: "Timestamp" },
    { key: "height", label: "Height" },
    { key: "prev_hash", label: "Prev Block Hash" },
    { key: "coinbaseScriptASCII", label: "Coinbase Script (ASCII)" },
    { key: "coinbase_outputs", label: "Coinbase Outputs" },
    { key: "clean_jobs", label: "Clean Jobs" },
    { key: "first_transaction", label: "First Tx" },
    { key: "fee_rate", label: "Fee Rate" },
    { key: "version", label: "Version" },
    { key: "nbits", label: "Nbits" },
    { key: "ntime", label: "Ntime" },
    { key: "coinbaseRaw", label: "Coinbase RAW" },
    { key: "coinbaseOutputValue", label: "Coinbase Output Value" },
  ];

  // ---------------------- Auto-hide settings panel if clicked outside ----------------------
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setShowSettings(false);
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
  }, [showSettings]);

  // ---------------------- Render ----------------------
  return (
    <div className="p-4 font-mono w-full overflow-x-auto relative">
      {/* Top Bar: Pause/Resume, GitHub link, Settings button */}
      <div className="flex justify-end items-center mb-2 space-x-4">
        <button
          className="bg-white text-gray-700 border border-gray-300 rounded px-2 py-1 hover:bg-gray-100"
          onClick={() => setPaused((prev) => !prev)}
          title={paused ? "Resume" : "Pause"}
        >
          {paused ? (
            <>
              {/* Play Icon */}
              <svg
                className="inline-block w-5 h-5 mr-1 align-text-bottom"
                height="800px"
                width="800px"
                version="1.1"
                viewBox="0 0 512 512"
                fill="#000000"
              >
                <path d="M256,0C114.625,0,0,114.625,0,256c0,141.374,114.625,256,256,256s256-114.626,256-256C512,114.625,397.374,0,256,0z M351.062,258.898l-144,85.945c-1.031,0.626-2.344,0.657-3.406,0.031c-1.031-0.594-1.687-1.702-1.687-2.937v-85.946v-85.946c0-1.218,0.656-2.343,1.687-2.938c1.062-0.609,2.375-0.578,3.406,0.031l144,85.962c1.031,0.586,1.641,1.718,1.641,2.89C352.703,257.187,352.094,258.297,351.062,258.898z" />
              </svg>
              Resume
            </>
          ) : (
            <>
              {/* Pause Icon */}
              <svg
                className="inline-block w-5 h-5 mr-1 align-text-bottom"
                fill="#000000"
                version="1.1"
                viewBox="0 0 45.812 45.812"
                width="800px"
                height="800px"
              >
                <g>
                  <g>
                    <g>
                      <path d="M39.104,6.708c-8.946-8.943-23.449-8.946-32.395,0c-8.946,8.944-8.946,23.447,0,32.394   c8.944,8.946,23.449,8.946,32.395,0C48.047,30.156,48.047,15.653,39.104,6.708z M20.051,31.704c0,1.459-1.183,2.64-2.641,2.64   s-2.64-1.181-2.64-2.64V14.108c0-1.457,1.182-2.64,2.64-2.64s2.641,1.183,2.641,2.64V31.704z M31.041,31.704   c0,1.459-1.183,2.64-2.64,2.64s-2.64-1.181-2.64-2.64V14.108c0-1.457,1.183-2.64,2.64-2.64s2.64,1.183,2.64,2.64V31.704z" />
                    </g>
                  </g>
                </g>
              </svg>
              Pause
            </>
          )}
        </button>

        {/* GitHub link (example) */}
        <a
          href="https://github.com/bboerst/stratum-work"
          target="_blank"
          rel="noopener noreferrer"
          title="GitHub Repository"
          className="w-10 h-10 bg-contain bg-no-repeat"
          style={{
            backgroundImage:
              "url(https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png)",
          }}
        />

        <button
          onClick={() => setShowSettings((prev) => !prev)}
          title="Toggle Column Settings"
          className="focus:outline-none"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 14 14"
            height="25"
            width="25"
          >
            <g id="cog--work-loading-cog-gear-settings-machine">
              <path
                fill="#000000"
                fillRule="evenodd"
                d="M5.69371 0.279427C5.96047 0.097683 6.27657 0.00041008 6.59927 0h0.8028c0.3227 0.000410318 0.6388 0.0976833 0.90556 0.279427 0.2664 0.181494 0.47217 0.438913 0.59014 0.739043l0.35231 0.88803 1.05272 0.60698 0.9481 -0.144c0.3195 -0.04803 0.6472 0.00089 0.9385 0.14079 0.2912 0.13984 0.5337 0.36407 0.6955 0.64379l0.4003 0.68996c0.1623 0.27972 0.2362 0.60194 0.2118 0.92448 -0.0243 0.32242 -0.1457 0.62976 -0.3479 0.88194l-0.5988 0.7473 0.0003 1.20452 0.5988 0.7473c0.2022 0.25218 0.3235 0.55952 0.3479 0.88194 0.0243 0.32254 -0.0496 0.64476 -0.2119 0.9245l-0.4002 0.6899c-0.16185 0.2798 -0.40435 0.50395 -0.69554 0.6438 -0.29131 0.1399 -0.61898 0.18882 -0.93851 0.1408l-0.94812 -0.144 -1.05267 0.607 -0.35232 0.888c-0.11797 0.3002 -0.32373 0.5576 -0.59013 0.7391 -0.26677 0.1817 -0.58286 0.279 -0.90557 0.2794h-0.80279c-0.32271 -0.0004 -0.6388 -0.0977 -0.90557 -0.2794 -0.2664 -0.1815 -0.47217 -0.4389 -0.59013 -0.7391l-0.35232 -0.888 -1.05267 -0.607 -0.94812 0.144c-0.31953 0.048 -0.6472 -0.0009 -0.93851 -0.1408 -0.29118 -0.1398 -0.53369 -0.364 -0.69553 -0.6438l-0.400278 -0.6899c-0.162281 -0.27974 -0.2362 -0.60196 -0.211847 -0.9245 0.024346 -0.32242 0.145722 -0.62976 0.347918 -0.88194l0.598787 -0.7473 -0.00024 -1.20452 -0.598792 -0.7473C0.650023 5.39826 0.528646 5.09092 0.504301 4.7685c-0.024353 -0.32254 0.049566 -0.64476 0.211847 -0.92448l0.400272 -0.6899c0.16185 -0.27972 0.40435 -0.50395 0.69554 -0.64379 0.29131 -0.1399 0.61898 -0.18882 0.93851 -0.14079l0.94812 0.144 1.05267 -0.60698 0.35231 -0.88803c0.11797 -0.30013 0.32374 -0.55755 0.59014 -0.739043Zm0.90607 0.970513c-0.07242 0.00015 -0.14291 0.02202 -0.20228 0.06247 -0.05942 0.04048 -0.10482 0.09758 -0.13069 0.16357l-0.00093 0.00237 -0.40323 1.01636 -0.00051 0.00129c-0.07085 0.17742 -0.19876 0.32579 -0.36305 0.42212l-0.00393 0.00231 -1.29638 0.74748c-0.16515 0.09345 -0.35649 0.12962 -0.54418 0.10313l-0.00651 -0.00092 -1.08437 -0.16473c-0.07182 -0.01073 -0.14545 0.00031 -0.21063 0.03161 -0.06525 0.03134 -0.11907 0.08134 -0.15478 0.1431l-0.40095 0.69113c-0.03578 0.06168 -0.05194 0.13244 -0.04661 0.20309 0.00534 0.07066 0.03196 0.13834 0.07674 0.19417l0.68839 0.85913c0.12005 0.15101 0.18546 0.33844 0.18513 0.53173v0.74059l0.00024 0.73929v0.0013c0.00033 0.19329 -0.06507 0.38071 -0.18513 0.53173l-0.68839 0.85913c-0.04478 0.05583 -0.0714 0.12351 -0.07673 0.19417 -0.00534 0.07065 0.01083 0.14141 0.04661 0.20309l0.40095 0.69115c0.0357 0.0617 0.08953 0.1117 0.15478 0.1431 0.06518 0.0313 0.13881 0.0423 0.21062 0.0316l1.08437 -0.1647 0.00652 -0.001c0.18768 -0.0264 0.37902 0.0097 0.54418 0.1032l1.29637 0.7475 0.00394 0.0023c0.16428 0.0963 0.29219 0.2447 0.36304 0.4221l0.00051 0.0013 0.40323 1.0163 0.00094 0.0024c0.02586 0.066 0.07127 0.1231 0.13068 0.1636 0.05937 0.0404 0.12986 0.0623 0.20228 0.0624h0.40089l0.40089 0.0001c0.07242 -0.0001 0.14291 -0.022 0.20228 -0.0625 0.05942 -0.0404 0.10482 -0.0976 0.13069 -0.1635l0.00093 -0.0024 0.40323 -1.0164 0.00052 -0.0013c0.07084 -0.1774 0.19876 -0.3257 0.36304 -0.4221l0.00393 -0.0023 1.29638 -0.7475c0.16515 -0.0934 0.3565 -0.1296 0.5442 -0.1031l0.00652 0.0009 1.08437 0.1648c0.0718 0.0107 0.1454 -0.0004 0.2106 -0.0317 0.0652 -0.0313 0.1191 -0.0813 0.1548 -0.1431l0.4009 -0.69109c0.0358 -0.06168 0.052 -0.13244 0.0466 -0.20309 -0.00534 -0.07066 -0.0319 -0.13834 -0.0767 -0.19417l-0.6884 -0.85913c-0.12 -0.15102 -0.1855 -0.33844 -0.1851 -0.53173v-0.0013L11.3008 7v-0.74059c-0.0003 -0.19329 0.0651 -0.38071 0.1851 -0.53173l0.6884 -0.85913c0.0448 -0.05583 0.0714 -0.12351 0.0768 -0.19417 0.00534 -0.07065 -0.0109 -0.14141 -0.0466 -0.20309l-0.401 -0.69113c-0.0357 -0.06176 -0.0895 -0.11176 -0.1548 -0.14309 -0.0651 -0.03131 -0.1388 -0.04235 -0.2106 -0.03162l-1.0844 0.16473 -0.0065 0.00092c-0.1877 0.02649 -0.379 -0.00967 -0.54416 -0.10313l-1.29637 -0.74748 -0.00394 -0.00231c-0.16428 -0.09633 -0.29219 -0.2447 -0.36304 -0.42212l-0.00051 -0.00129 -0.40323 -1.01636 -0.00093 -0.00237c-0.02587 -0.06599 -0.07127 -0.12309 -0.13069 -0.16357 -0.05937 -0.04045 -0.12986 -0.06232 -0.20228 -0.06247l-0.40138 -0.00006h-0.40089ZM9.25073 7c0 1.44 -0.81 2.25 -2.25 2.25s-2.25-0.81 -2.25-2.25 0.81-2.25 2.25-2.25 2.25 0.81 2.25 2.25Z"
                clipRule="evenodd"
                strokeWidth="1"
              ></path>
            </g>
          </svg>
        </button>
      </div>

      {/* Column Settings Dropdown */}
      {showSettings && (
        <div
          ref={settingsRef}
          className="absolute top-10 right-4 bg-white border border-gray-300 shadow-md rounded p-2 z-50"
        >
          <div className="font-bold mb-1 text-sm">Toggle Columns</div>
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
            {/* main columns (in the same order as the body) */}
            {columnsVisible.pool_name && (
              <TableHead
                onClick={() => handleSort("pool_name")}
                className="p-1 text-xs border-r-2 w-[130px] cursor-pointer select-none"
              >
                Pool Name{renderSortIndicator("pool_name")}
              </TableHead>
            )}
            {columnsVisible.timestamp && (
              <TableHead
                onClick={() => handleSort("timestamp")}
                className="p-1 border-r-2 text-xs w-[80px] cursor-pointer select-none"
              >
                Timestamp{renderSortIndicator("timestamp")}
              </TableHead>
            )}
            {columnsVisible.height && (
              <TableHead
                onClick={() => handleSort("height")}
                className="p-1 border-r-2 text-xs w-[65px] cursor-pointer select-none"
              >
                Height{renderSortIndicator("height")}
              </TableHead>
            )}
            {columnsVisible.prev_hash && (
              <TableHead
                onClick={() => handleSort("prev_hash")}
                className="p-1 border-r-2 text-xs w-[60px] cursor-pointer select-none"
              >
                Prev Block Hash{renderSortIndicator("prev_hash")}
              </TableHead>
            )}
            {columnsVisible.coinbaseScriptASCII && (
              <TableHead
                onClick={() => handleSort("coinbaseScriptASCII")}
                className="p-1 border-r-2 text-xs w-[100px] cursor-pointer select-none"
              >
                Coinbase Script (ASCII){renderSortIndicator("coinbaseScriptASCII")}
              </TableHead>
            )}
            {columnsVisible.coinbase_outputs && (
              <TableHead
                onClick={() => handleSort("coinbase_outputs")}
                className="p-1 border-r-2 text-xs w-[100px] cursor-pointer select-none"
              >
                Coinbase Outputs
              </TableHead>
            )}
            {columnsVisible.clean_jobs && (
              <TableHead
                onClick={() => handleSort("clean_jobs")}
                className="p-1 border-r-2 text-xs w-[60px] cursor-pointer select-none"
              >
                Clean Jobs{renderSortIndicator("clean_jobs")}
              </TableHead>
            )}
            {columnsVisible.first_transaction && (
              <TableHead
                onClick={() => handleSort("first_transaction")}
                className="p-1 border-r-2 text-xs w-[90px] cursor-pointer select-none"
              >
                First Tx{renderSortIndicator("first_transaction")}
              </TableHead>
            )}
            {columnsVisible.fee_rate && (
              <TableHead
                onClick={() => handleSort("fee_rate")}
                className="p-1 border-r-2 text-xs w-[90px] cursor-pointer select-none"
              >
                First Tx Fee Rate{renderSortIndicator("fee_rate")}
              </TableHead>
            )}
            {columnsVisible.version && (
              <TableHead
                onClick={() => handleSort("version")}
                className="p-1 border-r-2 text-xs w-[60px] cursor-pointer select-none"
              >
                Version{renderSortIndicator("version")}
              </TableHead>
            )}
            {columnsVisible.nbits && (
              <TableHead
                onClick={() => handleSort("nbits")}
                className="p-1 border-r-2 text-xs w-[60px] cursor-pointer select-none"
              >
                Nbits
              </TableHead>
            )}
            {columnsVisible.ntime && (
              <TableHead
                onClick={() => handleSort("ntime")}
                className="p-1 border-r-2 text-xs w-[60px] cursor-pointer select-none"
              >
                Ntime
              </TableHead>
            )}
            {columnsVisible.coinbaseRaw && (
              <TableHead
                onClick={() => handleSort("coinbaseRaw")}
                className="p-1 border-r-2 text-xs w-[120px] cursor-pointer select-none"
              >
                Coinbase RAW{renderSortIndicator("coinbaseRaw")}
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
            {columnsVisible.coinbaseOutputValue && (
              <TableHead
                onClick={() => handleSort("coinbaseOutputValue")}
                className="p-1 text-xs w-[100px] cursor-pointer select-none"
              >
                Coinbase Output Value{renderSortIndicator("coinbaseOutputValue")}
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedRows.map((row, idx) => (
            <TableRow key={idx} className="hover:bg-gray-200">
              {columnsVisible.pool_name && (
                <TableCell className="p-1 truncate" title={row.pool_name}>
                  {row.pool_name}
                </TableCell>
              )}
              {columnsVisible.timestamp && (
                <TableCell
                  className="p-1 truncate"
                  title={formatTimestamp(row.timestamp)}
                >
                  {formatTimestamp(row.timestamp)}
                </TableCell>
              )}
              {columnsVisible.height && (
                <TableCell className="p-1 truncate">{row.height}</TableCell>
              )}
              {columnsVisible.prev_hash && (
                <TableCell
                  className="p-1 truncate"
                  title={formatPrevBlockHash(row.prev_hash)}
                >
                  {formatPrevBlockHash(row.prev_hash)}
                </TableCell>
              )}
              {columnsVisible.coinbaseScriptASCII && (
                <TableCell className="p-1 truncate" title={row.coinbaseScriptASCII}>
                  {row.coinbaseScriptASCII}
                </TableCell>
              )}
              {columnsVisible.coinbase_outputs && (
                <TableCell
                  className="p-1 truncate"
                  title={
                    row.coinbase_outputs && row.coinbase_outputs.length
                      ? row.coinbase_outputs
                          .filter((o) => !o.address.includes("nulldata"))
                          .map((o) => `${o.address}:${o.value.toFixed(8)}`)
                          .join(" | ")
                      : "N/A"
                  }
                  style={{
                    backgroundColor: generateColorFromOutputs(row.coinbase_outputs || []),
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
              {columnsVisible.clean_jobs && (
                <TableCell className="p-1 truncate">
                  {row.clean_jobs?.toString() || "N/A"}
                </TableCell>
              )}
              {columnsVisible.first_transaction && (
                <TableCell className="p-1 truncate">
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
                <TableCell className="p-1 truncate">
                  {typeof row.feeRateComputed === "number"
                    ? row.feeRateComputed
                    : row.feeRateComputed || "N/A"}
                </TableCell>
              )}
              {columnsVisible.version && (
                <TableCell className="p-1 truncate">{row.version}</TableCell>
              )}
              {columnsVisible.nbits && (
                <TableCell className="p-1 truncate">
                  {row.nbits || "N/A"}
                </TableCell>
              )}
              {columnsVisible.ntime && (
                <TableCell className="p-1 truncate">
                  {row.ntime ? formatNtime(row.ntime) : "N/A"}
                </TableCell>
              )}
              {columnsVisible.coinbaseRaw && (
                <TableCell className="p-1 truncate" title={row.coinbaseRaw}>
                  {row.coinbaseRaw}
                </TableCell>
              )}
              {/* Merkle branch columns */}
              {Array.from({ length: 13 }).map((_, i) => {
                let bg = "transparent";
                // If user provided custom colors, otherwise pick color from the branch text
                if (row.merkle_branch_colors && row.merkle_branch_colors[i]) {
                  bg = row.merkle_branch_colors[i];
                } else if (row.merkle_branches && row.merkle_branches[i]) {
                  const hash = hashCode(row.merkle_branches[i]);
                  const hue = Math.abs(hash % 360);
                  const lightness = 60 + (hash % 25);
                  bg = `hsl(${hue}, 100%, ${lightness}%)`;
                }
                const branchValue = row.merkle_branches
                  ? row.merkle_branches[i] || ""
                  : "";
                return (
                  <TableCell
                    key={i}
                    className="p-1 truncate text-sm"
                    style={{ backgroundColor: bg, border: `1px solid ${bg}` }}
                    title={branchValue}
                  >
                    {branchValue}
                  </TableCell>
                );
              })}
              {columnsVisible.coinbaseOutputValue && (
                <TableCell className="p-1 truncate">
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
        <div className="text-center text-black pt-10 mb-4">
          Wait for new stratum messages...
        </div>
      )}

    </div>
  );
}