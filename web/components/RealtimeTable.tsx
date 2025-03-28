"use client";

import React, { useEffect, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Table, TableBody } from "@/components/ui/table";
import { StratumV1Data, StreamDataType } from "@/lib/types";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { useHistoricalData } from "@/lib/HistoricalDataContext";
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
        // Add debug logging
        console.log(`RealtimeTable: Updating historical data for block ${filterBlockHeight} with ${filteredData.length} items`);
        
        // Store the filtered data in the historical data context
        setHistoricalData(filteredData);
        setIsHistoricalDataLoaded(true);
        setCurrentHistoricalHeight(filterBlockHeight);
        
        // Make sure the first record has a valid timestamp and we can parse it
        if (filteredData[0]?.timestamp) {
          const timestampStr = filteredData[0].timestamp;
          console.log('First timestamp in historical data:', timestampStr);
          
          // Don't try to parse it directly as a date string - just acknowledge that data is present
          console.log('Historical data timestamp format:', typeof timestampStr);
          
          // For debugging, try to parse as hexadecimal if it's a string
          if (typeof timestampStr === 'string') {
            try {
              // Try to parse as hexadecimal nanoseconds (for collector format)
              const cleaned = timestampStr.replace(/^0x/, '');
              // Parse the hex string to get nanoseconds
              const nanoseconds = parseInt(cleaned, 16);
              // Convert to milliseconds and create a date
              const milliseconds = nanoseconds / 1000000;
              const date = new Date(milliseconds);
              console.log('Parsed as hex timestamp:', date.toISOString());
            } catch (e) {
              console.error('Failed to parse as hex timestamp:', e);
            }
          }
        }
      } else if (isLoading) {
        console.log(`RealtimeTable: Still loading data for block ${filterBlockHeight}`);
      } else {
        console.log(`RealtimeTable: No filtered data available for block ${filterBlockHeight}`);
      }
    } else {
      // If not viewing a historical block, clear the historical data
      if (currentHistoricalHeight !== null) {
        console.log('RealtimeTable: Clearing historical data');
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
  
  // Handle block height click
  const handleBlockClick = useCallback((height: number) => {
    // Special case for the being-mined block (height -1)
    if (height === -1) {
      // Navigate to the root URL for the being-mined block using client-side navigation
      router.push('/');
      return;
    }
    
    // Regular case for historical blocks
    if (height > 0) {
      // Use Next.js router for client-side navigation
      router.push(`/height/${height}`);
    }
  }, [router]);
  
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
              handleBlockClick={handleBlockClick}
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