import React from 'react';
import { TableCell, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SortedRow } from '@/types/tableTypes';
import { formatPrevBlockHash, formatTimeReceived, formatNtime } from '@/utils/formatters';
import { getMerkleColor, getTimeColor, generateColorFromOutputs } from '@/utils/colorUtils';
import { CoinbaseOutputDetail, EMPTY_TEMPLATE } from '@/utils/bitcoinUtils';
import { Zap } from 'lucide-react';
import type { PoolBurst } from '@/lib/useDataStream';
import { childTitle, feeRateChildOf } from '@/lib/txFeeRates';

interface RealtimeTableRowProps {
  row: SortedRow;
  /** This pool recently sent templates faster than the live display shows them (#105). */
  burst?: PoolBurst;
  columnsVisible: { [key: string]: boolean };
  columnWidths: { [key: string]: number };
  handleTemplateSelect: (row: SortedRow) => void;
}

function RealtimeTableRowComponent({
  row,
  burst,
  columnsVisible,
  columnWidths,
  handleTemplateSelect
}: RealtimeTableRowProps) {
  return (
    <TableRow
      // relative z-0: each row is its own stacking context, so the browser repaints only the rows that changed instead
      // of the whole table on every update (no visual change).
      className="relative z-0 hover:bg-[hsl(var(--muted))] cursor-pointer"
      onClick={() => handleTemplateSelect(row)}
    >
      {columnsVisible.pool_name && (
        <TableCell
          style={{ width: columnWidths.pool_name }}
          className="p-1 truncate"
          title={row.pool_name}
        >
          <div className="flex items-center justify-between">
            <span className="truncate">{row.pool_name}</span>
            {burst && (
              <span
                className="ml-1 shrink-0 text-amber-600 dark:text-amber-400"
                title={`Burst: this pool sent templates faster than the live display shows them. ${burst.suppressed.toLocaleString()} weren't shown live since ${new Date(burst.firstMs).toLocaleTimeString()}; all of them are stored.`}
                aria-label="Burst of templates"
                data-burst={burst.suppressed}
              >
                <Zap className="h-3 w-3" aria-hidden="true" />
              </span>
            )}
          </div>
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
          {row.first_transaction === EMPTY_TEMPLATE ? (
            <span className="text-muted-foreground" title="No transactions besides the coinbase">
              {EMPTY_TEMPLATE}
            </span>
          ) : row.first_transaction ? (
            <a
              href={`https://mempool.space/tx/${row.first_transaction}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 underline"
              title={row.first_transaction}
              onClick={(e) => e.stopPropagation()}
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
          {typeof row.feeRateComputed === "number" && (() => {
            const child = feeRateChildOf(row.first_transaction);
            return child ? (
              <span className="ml-1 text-xs text-muted-foreground cursor-help" title={childTitle(child)}>+child</span>
            ) : null;
          })()}
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
          style={{
            ...{
              width: columnWidths.coinbase_outputs,
            },
            backgroundColor: generateColorFromOutputs(
              (row.coinbase_outputs || []).filter((o): o is CoinbaseOutputDetail & { address: string } => !!o.address)
            ),
            border: `1px solid ${generateColorFromOutputs(
              (row.coinbase_outputs || []).filter((o): o is CoinbaseOutputDetail & { address: string } => !!o.address)
            )}`,
          }}
        >
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  {row.coinbase_outputs && row.coinbase_outputs.length
                    ? row.coinbase_outputs
                        .filter((o): o is CoinbaseOutputDetail & { address: string } => !!o.address)
                        .filter((o) => !o.address.includes("nulldata"))
                        .map((o) => `${o.address!}:${o.value.toFixed(8)}`)
                        .join(" | ")
                    : "N/A"}
                </span>
              </TooltipTrigger>
              <TooltipContent className="bg-background text-foreground border rounded-sm shadow-lg p-2 max-w-xs wrap-break-word">
                {row.coinbase_outputs && row.coinbase_outputs.length > 0 ? (
                  row.coinbase_outputs
                    .filter((o): o is CoinbaseOutputDetail & { address: string } => !!o.address)
                    .map((output, index) => (
                      <div key={index} className="text-xs mb-1">
                        <span className="font-semibold">Address:</span> {output.address}
                        <br />
                        <span className="font-semibold">Value:</span> {(output.value / 100000000).toFixed(8)} BTC
                      </div>
                    ))
                ) : (
                  <p>No coinbase outputs found.</p>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TableCell>
      )}
      
      {columnsVisible.coinbaseOutputValue && (
        <TableCell
          style={{ width: columnWidths.coinbaseOutputValue }}
          className="p-1 truncate"
        >
          {isNaN(row.coinbaseOutputValue)
            ? "N/A"
            : (row.coinbaseOutputValue / 100000000).toFixed(8)}
        </TableCell>
      )}

      {columnsVisible.mergeMining && (
        <TableCell
          style={{ width: columnWidths.mergeMining }}
          className="p-1 truncate"
          title={row.mergeMining || "No merge-mining commitments"}
        >
          {row.mergeMining || "–"}
        </TableCell>
      )}

      {columnsVisible.mergeMiningChange && (
        <TableCell
          style={{ width: columnWidths.mergeMiningChange }}
          className={`p-1 truncate ${row.mergeMiningSetChanged ? "text-amber-600 dark:text-amber-400 font-semibold" : ""}`}
          title={
            row.mergeMiningChange
              ? `${row.mergeMiningChange} (vs this pool's previous template${row.mergeMiningSetChanged ? "; the set of chains changed" : ""})`
              : "First template seen from this pool"
          }
          data-mm-set-changed={row.mergeMiningSetChanged ? "true" : undefined}
        >
          {row.mergeMiningChange || ""}
        </TableCell>
      )}
    </TableRow>
  );
}

// Memoized: rows are reused objects while their pool's template is unchanged (useTableData), so a new template
// re-renders only its own row, not the whole table (perf harness, #157).
export default React.memo(RealtimeTableRowComponent);
