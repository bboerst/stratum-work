import React from 'react';
import { TableCell, TableRow } from "@/components/ui/table";
import { SortedRow } from '@/types/tableTypes';
import { formatPrevBlockHash, formatTimeReceived, formatNtime } from '@/utils/formatters';
import { getMerkleColor, getTimeColor, generateColorFromOutputs } from '@/utils/colorUtils';

interface RealtimeTableRowProps {
  row: SortedRow;
  columnsVisible: { [key: string]: boolean };
  columnWidths: { [key: string]: number };
  handleBlockClick: (height: number) => void;
}

export default function RealtimeTableRowComponent({
  row,
  columnsVisible,
  columnWidths,
  handleBlockClick
}: RealtimeTableRowProps) {
  return (
    <TableRow className="hover:bg-gray-200 dark:hover:bg-gray-800">
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
          className="p-1 truncate cursor-pointer hover:text-blue-500"
          onClick={() => handleBlockClick(row.height)}
        >
          {row.height}
        </TableCell>
      )}
      
      {columnsVisible.prev_hash && (
        <TableCell
          style={{ width: columnWidths.prev_hash }}
          className="p-1"
          title={formatPrevBlockHash(row.prev_hash)}
        >
          <div className="w-full overflow-hidden text-ellipsis whitespace-nowrap" style={{ direction: 'rtl' }}>
            {formatPrevBlockHash(row.prev_hash)}
          </div>
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
  );
} 