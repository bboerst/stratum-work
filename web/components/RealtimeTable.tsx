"use client";

import React, { useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Table, TableBody } from "@/components/ui/table";
import { StratumV1Data, StreamDataType } from "@/lib/types";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { useHistoricalData } from "@/lib/HistoricalDataContext";
import { useSelectedTemplate } from "@/lib/SelectedTemplateContext";
import { SortedRow, RealtimeTableProps, SortDirection } from "@/types/tableTypes";
import { useColumnVisibility, useColumnResizing, useSorting, usePagination } from "@/hooks/useTableState";
import { useTableData } from "@/hooks/useTableData";
import RealtimeTableHeader from "./RealtimeTableHeader";
import RealtimeTableRowComponent from "./RealtimeTableRow";
import RealtimeTableSettings from "./RealtimeTableSettings";

export default function RealtimeTable({ 
  paused = false, 
  showSettings = false,
  onShowSettingsChange,
  filterBlockHeight
}: RealtimeTableProps) {
  const router = useRouter();
  
  // Get data from the global data stream
  const { filterByType } = useGlobalDataStream();
  
  // Get historical data context
  const { 
    setHistoricalData, 
    setIsHistoricalDataLoaded, 
    setCurrentHistoricalHeight,
    currentHistoricalHeight,
    clearHistoricalData
  } = useHistoricalData();
  
  // Get selected template context
  const { setSelectedTemplate } = useSelectedTemplate();
  
  // Filter for only Stratum V1 data
  const stratumV1Data = useMemo(() => {
    const filtered = filterByType(StreamDataType.STRATUM_V1);
    return filtered.map(item => item.data as StratumV1Data);
  }, [filterByType]);
  
  // Use hooks for table state management
  const { columnsVisible, toggleColumn } = useColumnVisibility();
  const { columnWidths, handleMouseDown, resizeActiveRef } = useColumnResizing();
  
  // Get table data
  const { 
    rows,
    visibleRows,
    isLoading,
    isFiltering,
    hasMore,
    loadMore,
    handleSort: tableDataHandleSort,
    filteredData
  } = useTableData(stratumV1Data, paused, filterBlockHeight);
  
  // Update historical data context when filtered data changes
  useEffect(() => {
    // Only update when viewing a historical block
    if (filterBlockHeight && filterBlockHeight > 0) {
      if (filteredData && filteredData.length > 0) {
        // Map SortedRow[] back to StratumV1Data[] for the context
        const historicalStratumData: StratumV1Data[] = filteredData.map(row => ({
          pool_name: row.pool_name,
          timestamp: row.timestamp,
          job_id: row.job_id,
          height: row.height,
          prev_hash: row.prev_hash,
          version: row.version,
          coinbase1: row.coinbase1,
          coinbase2: row.coinbase2,
          merkle_branches: row.merkle_branches,
          nbits: row.nbits || '', // Ensure nbits is a string, handle potential undefined
          ntime: row.ntime || '', // Ensure ntime is a string, handle potential undefined
          clean_jobs: row.clean_jobs,
          extranonce1: row.extranonce1,
          extranonce2_length: row.extranonce2_length,
          // Map coinbase_outputs carefully, handling potential undefined address
          coinbase_outputs: row.coinbase_outputs
            .filter(output => output.address !== undefined) // Filter out outputs without an address
            .map(output => ({
              address: output.address!, // Use non-null assertion as we filtered undefined
              value: output.value,
            })),
          first_transaction: row.first_transaction, // Assuming this exists on SortedRow
          fee_rate: row.fee_rate, // Assuming this exists on SortedRow
          merkle_branch_colors: row.merkle_branch_colors // Assuming this exists on SortedRow
        }));
        
        // Store the mapped data in the historical data context
        setHistoricalData(historicalStratumData);
        setIsHistoricalDataLoaded(true);
        setCurrentHistoricalHeight(filterBlockHeight);
        
        // Make sure the first record has a valid timestamp
        if (historicalStratumData[0]?.timestamp) {
          // Valid timestamp exists
        }
      }
    } else {
      // If not viewing a historical block, clear the historical data
      if (currentHistoricalHeight !== null) {
        clearHistoricalData();
      }
    }
  }, [filteredData, filterBlockHeight, setHistoricalData, setIsHistoricalDataLoaded, setCurrentHistoricalHeight, currentHistoricalHeight, clearHistoricalData, isLoading]);
  
  // Initialize sorting
  const { 
    sortConfig, 
    isSorting,
    setSortConfig,
    sortData
  } = useSorting(isFiltering);
  
  // Initialize pagination
  const {
    loadMoreRef
  } = usePagination(isFiltering, isLoading, isSorting);
  
  // Handle sorting
  const handleSort = useCallback((key: keyof SortedRow) => {
    // Special case for timestamp column
    if (key === "timestamp") {
      // Toggle the sort direction based on the current sort configuration
      // If the current sort key is timestamp and direction is ascending, switch to descending
      // Otherwise, use ascending (this handles both the initial case and switching from desc to asc)
      const newDirection = 
        sortConfig?.key === "timestamp" && sortConfig.direction === "asc" 
          ? "desc" as SortDirection 
          : "asc" as SortDirection;
      
      const newSortConfig = { key: "timestamp" as keyof SortedRow, direction: newDirection };
      
      // First update the UI sort configuration
      setSortConfig(newSortConfig);
      
      // Then call the tableDataHandleSort with the SAME direction to ensure consistency
      tableDataHandleSort("timestamp" as keyof SortedRow, newSortConfig);
      return;
    }
    
    // For other columns, determine the new sort direction
    const newDirection = 
      sortConfig?.key === key && sortConfig.direction === "asc" 
        ? "desc" as SortDirection 
        : "asc" as SortDirection;
    
    // Update the sort configuration
    const newSortConfig = { key, direction: newDirection };
    setSortConfig(newSortConfig);
    
    // Call the tableDataHandleSort with the SAME direction to ensure consistency
    tableDataHandleSort(key, newSortConfig);
  }, [sortConfig, setSortConfig, tableDataHandleSort]);
  
  // Get the rows to display based on filtering and sorting
  const displayedRows = useMemo(() => {
    if (isFiltering) {
      // If we're filtering, the visibleRows are already filtered and sorted
      // The sorting is now done in the useTableData hook's handleSort function
      // This ensures that the entire dataset is sorted, not just the visible rows
      return visibleRows;
    } else {
      // For realtime data, we need to sort the rows using the current sort configuration
      const sortedRows = sortData(rows);
      return sortedRows;
    }
  }, [isFiltering, visibleRows, rows, sortData]);
  

  // Handle template selection for BlockTemplateCard
  const handleTemplateSelect = useCallback((row: SortedRow) => {
    // If we're viewing realtime data (not filtering by block height), navigate to template page
    if (!isFiltering) {
      // Navigate to the template page for realtime data
      router.push(`/template/${encodeURIComponent(row.pool_name)}`);
      return;
    }
    
    // For historical data, show in side panel
    const stratumData: StratumV1Data = {
      pool_name: row.pool_name,
      timestamp: row.timestamp,
      job_id: row.job_id,
      height: row.height,
      prev_hash: row.prev_hash,
      version: row.version,
      coinbase1: row.coinbase1,
      coinbase2: row.coinbase2,
      merkle_branches: row.merkle_branches,
      nbits: row.nbits || '',
      ntime: row.ntime || '',
      clean_jobs: row.clean_jobs,
      extranonce1: row.extranonce1,
      extranonce2_length: row.extranonce2_length,
      coinbase_outputs: row.coinbase_outputs
        .filter(output => output.address !== undefined)
        .map(output => ({
          address: output.address!,
          value: output.value,
        })),
      first_transaction: row.first_transaction,
      fee_rate: row.fee_rate,
      merkle_branch_colors: row.merkle_branch_colors
    };
    
    setSelectedTemplate(stratumData);
  }, [setSelectedTemplate, isFiltering, router]);

  // Add an effect to handle block changes
  useEffect(() => {
    // This effect detects when a new block is found
    // Listen for block data in the stream
    const blockData = filterByType(StreamDataType.BLOCK);
    
    if (blockData.length > 0 && !paused) {
      // We intentionally don't do anything special here
      // The useTableData hook handles updating the current height
    }
  }, [filterByType, paused]);

  // Set up the intersection observer for infinite scrolling
  useEffect(() => {
    if (isFiltering) {
      const options = {
        root: null,
        rootMargin: '20px',
        threshold: 0.1,
      };

      const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoading && !isSorting) {
          loadMore();
        }
      }, options);

      const loadMoreElement = loadMoreRef.current;
      if (loadMoreElement) {
        observer.observe(loadMoreElement);
      }

      return () => {
        if (loadMoreElement) {
          observer.disconnect();
        }
      };
    }
  }, [isFiltering, hasMore, isLoading, loadMore, isSorting, loadMoreRef]);

  return (
    <div className="relative overflow-hidden px-4 pb-4 min-h-[200px]">
      {isLoading && (
        <div className="fixed inset-x-0 top-0 bottom-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-lg text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-orange-500 mx-auto mb-2"></div>
          </div>
        </div>
      )}

      {/* Column Settings Dropdown */}
      <RealtimeTableSettings 
        showSettings={showSettings}
        onShowSettingsChange={onShowSettingsChange || (() => {})}
        columnsVisible={columnsVisible}
        toggleColumn={toggleColumn}
      />

      {/* The Table */}
      <Table className="w-full table-fixed">
        <RealtimeTableHeader 
          columnsVisible={columnsVisible}
          columnWidths={columnWidths}
          handleMouseDown={handleMouseDown}
          handleSort={handleSort}
          sortConfig={sortConfig}
          resizeActiveRef={resizeActiveRef}
        />

        <TableBody>
          {displayedRows.map((row, idx) => (
            <RealtimeTableRowComponent
              key={idx}
              row={row}
              columnsVisible={columnsVisible}
              columnWidths={columnWidths}
              handleTemplateSelect={handleTemplateSelect}
            />
          ))}
          
          {/* Add a loading indicator at the bottom for infinite scrolling */}
          {isFiltering && hasMore && (
            <tr>
              <td colSpan={Object.keys(columnsVisible).filter(key => columnsVisible[key as keyof typeof columnsVisible]).length}>
                <div ref={loadMoreRef} className="flex justify-center p-4">
                  {isLoading ? (
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-900 dark:border-gray-100"></div>
                  ) : (
                    <div className="text-sm text-gray-500">Scroll for more</div>
                  )}
                </div>
              </td>
            </tr>
          )}
        </TableBody>
      </Table>
      
      {/* Show waiting message if no rows */}
      {displayedRows.length === 0 && !isLoading && (
        <div className="text-center text-black dark:text-white py-20 flex items-center justify-center min-h-[150px]">
          <div>
            {isFiltering ? (
              <>
                <div className="text-xl mb-2">No data found for this block</div>
                <div className="text-sm text-gray-500 dark:text-gray-400">Try selecting a different block</div>
              </>
            ) : (
              "Wait for new stratum messages..."
            )}
          </div>
        </div>
      )}
    </div>
  );
}