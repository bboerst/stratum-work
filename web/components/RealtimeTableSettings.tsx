import React, { useRef, useEffect } from 'react';
import ModeToggle from "@/components/ModeToggle";
import { SortedRow } from '@/types/tableTypes';

interface RealtimeTableSettingsProps {
  showSettings: boolean;
  onShowSettingsChange: (showSettings: boolean) => void;
  columnsVisible: { [key: string]: boolean };
  toggleColumn: (colKey: string) => void;
}

export default function RealtimeTableSettings({
  showSettings,
  onShowSettingsChange,
  columnsVisible,
  toggleColumn
}: RealtimeTableSettingsProps) {
  const settingsRef = useRef<HTMLDivElement>(null);

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
      className="settings-dropdown fixed bg-white dark:bg-[#1e1e2f] border border-gray-300 dark:border-gray-700 shadow-md rounded p-2 z-50"
      style={{ 
        top: '60px', // Position below the header
        right: '20px' // Position from the right edge
      }}
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
  );
} 