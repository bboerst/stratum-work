import React, { useRef, useEffect } from 'react';
import ModeToggle from "@/components/ModeToggle";
import { SortedRow } from '@/types/tableTypes';
import { useLatencyAdjusted } from "./TimingDisplayContext";
import type { TimingVisualKey } from "./TimingDisplayContext";

interface RealtimeTableSettingsProps {
  showSettings: boolean;
  onShowSettingsChange: (showSettings: boolean) => void;
  columnsVisible: { [key: string]: boolean };
  toggleColumn: (colKey: string) => void;
  latencySettingKey?: TimingVisualKey;
}

export default function RealtimeTableSettings({
  showSettings,
  onShowSettingsChange,
  columnsVisible,
  toggleColumn,
  latencySettingKey = "table"
}: RealtimeTableSettingsProps) {
  const settingsRef = useRef<HTMLDivElement>(null);
  const [latencyAdjusted, setLatencyAdjusted] = useLatencyAdjusted(latencySettingKey);

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
    { key: "signaling_bip110", label: "BIP-110 Signaling" },
    { key: "nbits", label: "Nbits" },
    { key: "coinbaseRaw", label: "Coinbase RAW" },
    { key: "timestamp", label: "Time Received" },
    { key: "ntime", label: "Ntime" },
    { key: "coinbase_outputs", label: "Coinbase Outputs" },
    { key: "coinbaseOutputValue", label: "Coinbase Output Value" },
  ];

  // Auto-hide settings panel if clicked outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        // Notify parent component of settings change
        onShowSettingsChange(false);
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

  if (!showSettings) return null;

  return (
    <div
      ref={settingsRef}
      className="settings-dropdown fixed bg-background text-foreground border shadow-md rounded p-2 z-50"
      style={{ 
        top: '60px', // Position below the header
        right: '20px' // Position from the right edge
      }}
    >
      <div className="pb-1 border-b border-gray-200 dark:border-gray-700 mb-1">
        <ModeToggle />
      </div>
      <div className="flex items-center justify-between px-2 py-1 border-b border-gray-200 dark:border-gray-700 mb-1">
        <span
          className="text-sm font-medium"
          title="Subtract each pool's measured network latency (RTT/2) from Time Received"
        >
          Latency adjusted
        </span>
        <button
          onClick={() => setLatencyAdjusted(!latencyAdjusted)}
          className={`px-2 py-1 text-sm rounded ${
            latencyAdjusted ? 'bg-blue-500 text-white' : 'bg-gray-200 dark:bg-gray-700'
          }`}
        >
          {latencyAdjusted ? "On" : "Off"}
        </button>
      </div>
      <div className="font-bold text-sm px-2 py-1">
        Toggle Columns
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
  );
} 
