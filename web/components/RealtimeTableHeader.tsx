import React from 'react';
import { TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortedRow, SortConfig } from '@/types/tableTypes';

interface RealtimeTableHeaderProps {
  columnsVisible: { [key: string]: boolean };
  columnWidths: { [key: string]: number };
  handleMouseDown: (colKey: string, e: React.MouseEvent) => void;
  handleSort: (key: keyof SortedRow) => void;
  sortConfig: SortConfig;
  resizeActiveRef: React.MutableRefObject<boolean>;
}

export default function RealtimeTableHeader({
  columnsVisible,
  columnWidths,
  handleMouseDown,
  handleSort,
  sortConfig,
  resizeActiveRef
}: RealtimeTableHeaderProps) {
  
  // Render sort indicator for a column
  function renderSortIndicator(key: keyof SortedRow) {
    if (sortConfig.key !== key) return null;
    const arrow = sortConfig.direction === "asc" ? "↑" : "↓";
    return (
      <span className="sort-arrow inline-block w-5 h-5 bg-black text-white text-lg font-bold text-center leading-4 ml-1 rounded">
        {arrow}
      </span>
    );
  }

  // Column definitions
  const mainColumns: { key: keyof SortedRow; label: string }[] = [
    { key: "pool_name", label: "Pool Name" },
    { key: "height", label: "Height" },
    { key: "prev_hash", label: "Prev Block Hash" },
    { key: "coinbaseScriptASCII", label: "Coinbase Script (ASCII)" },
    { key: "clean_jobs", label: "Clean Jobs" },
    { key: "first_transaction", label: "First Tx" },
    { key: "fee_rate", label: "First Tx Fee Rate" },
    { key: "version", label: "Version" },
    { key: "nbits", label: "Nbits" },
    { key: "coinbaseRaw", label: "Coinbase RAW" },
    { key: "timestamp", label: "Time Received" },
    { key: "ntime", label: "Ntime" },
  ];

  // Add a special handler for the timestamp column
  const handleTimestampClick = () => {
    // Just call the regular handleSort function with the timestamp key
    // The special case is now handled in the RealtimeTable component
    handleSort("timestamp");
  };

  return (
    <TableHeader>
      <TableRow>
        {/* Render visible columns */}
        {mainColumns.map(({ key, label }) => 
          columnsVisible[key] && (
            <TableHead
              key={key}
              onClick={() => {
                if (resizeActiveRef.current) {
                  resizeActiveRef.current = false;
                  return;
                }
                // Use the special handler for the timestamp column
                if (key === "timestamp") {
                  handleTimestampClick();
                } else {
                  handleSort(key);
                }
              }}
              className="relative p-1 border-r-2 text-xs cursor-pointer select-none"
              style={{ width: columnWidths[key] }}
            >
              {label}{renderSortIndicator(key)}
              <div
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleMouseDown(key, e);
                }}
                onClick={(e) => e.stopPropagation()}
                className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-gray-400"
              />
            </TableHead>
          )
        )}
        
        {/* Merkle branches: always shown; 13 columns */}
        {Array.from({ length: 13 }).map((_, i) => (
          <TableHead
            key={`merkle-${i}`}
            className="p-1 border-r-2 text-xs max-w-[30px] w-12"
          >
            Merk. {i}
          </TableHead>
        ))}
        
        {/* Add Coinbase Outputs and Coinbase Output Value after merkle branches */}
        {columnsVisible.coinbase_outputs && (
          <TableHead
            key="coinbase_outputs"
            onClick={() => {
              if (resizeActiveRef.current) {
                resizeActiveRef.current = false;
                return;
              }
              handleSort("coinbase_outputs");
            }}
            className="relative p-1 border-r-2 text-xs cursor-pointer select-none"
            style={{ width: columnWidths.coinbase_outputs }}
          >
            Coinbase Outputs{renderSortIndicator("coinbase_outputs")}
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
            key="coinbaseOutputValue"
            onClick={() => {
              if (resizeActiveRef.current) {
                resizeActiveRef.current = false;
                return;
              }
              handleSort("coinbaseOutputValue");
            }}
            className="relative p-1 border-r-2 text-xs cursor-pointer select-none"
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
  );
} 