import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { StratumV1Data, StreamDataType } from '@/lib/types';
import { SortedRow, SortConfig, SortDirection } from '@/types/tableTypes';
import { formatCoinbaseRaw } from '@/utils/formatters';
import { 
    //formatCoinbaseScriptASCII, // No longer needed directly here 
    computeCoinbaseOutputValue, 
    computeFirstTransaction, 
    computeCoinbaseOutputs, 
    fetchFeeRate, 
    clearCoinbaseFromCaches, 
    isRequestInFlight, 
    markRequestInFlight, 
    clearRequestInFlight,
    getFormattedCoinbaseAsciiTag // Import the correct function
} from '@/utils/bitcoinUtils';
import { sortRowsByKey } from '@/utils/sortUtils';

// Constants for pagination
const ITEMS_PER_PAGE = 50;

// Hook for managing the table data
export function useTableData(
  stratumV1Data: StratumV1Data[],
  paused: boolean,
  filterBlockHeight?: number
) {
  // State for the table rows
  const [rows, setRows] = useState<StratumV1Data[]>([]);
  
  // Add a ref to track the latest data for each pool at the current height
  const latestPoolDataRef = useRef<Map<string, StratumV1Data>>(new Map());
  const currentHeightRef = useRef<number | null>(null);

  // Track each pool's current coinbaseRaw, so we know when it changes
  const poolCoinbaseMap = useRef<Map<string, string>>(new Map());

  // Add state for filtered data and loading
  const [filteredData, setFilteredData] = useState<SortedRow[]>([]);
  const [isFiltering, setIsFiltering] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const fetchInProgress = useRef(false);

  // Cached fee rates: txid -> (fee rate or "not found"/"error")
  const [feeRateMap, setFeeRateMap] = useState<{ [txid: string]: number | string }>({});

  // Track if this is the first update for filtered data
  const isFirstFilteredDataRun = useRef(true);

  // State for pagination
  const [allData, setAllData] = useState<SortedRow[]>([]);
  const [visibleData, setVisibleData] = useState<SortedRow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  // Refs for tracking requests
  const inFlightRequests = useRef<Set<string>>(new Set());

  // Update rows when data changes
  useEffect(() => {
    // This effect processes new data from the stream
    // We keep track of the latest data for each pool, regardless of block height
    // When a new block is found, we don't clear the table
    // Instead, we keep showing the existing data until we receive new data for each pool at the new height
    // This ensures a smooth transition between blocks
    
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
      const oldCoinbaseRaw = poolCoinbaseMap.current.get(data.pool_name);
      if (oldCoinbaseRaw && oldCoinbaseRaw !== newCoinbaseRaw) {
        // Remove the old coinbase from caches
        clearCoinbaseFromCaches(oldCoinbaseRaw);
      }
  
      // Store the new coinbaseRaw for this pool
      poolCoinbaseMap.current.set(data.pool_name, newCoinbaseRaw);
      
      // Store this data as the latest for this pool
      // If this is data for the current height, update the pool's data
      // If this is data for a new height (higher than current), update the current height
      if (currentHeightRef.current === null || data.height >= currentHeightRef.current) {
        if (data.height > (currentHeightRef.current || 0)) {
          // New block height detected, update the current height
          currentHeightRef.current = data.height;
        }
        
        // Always store the latest data for this pool at its height
        latestPoolDataRef.current.set(data.pool_name, data);
      }
    });

    // Update rows state with all the latest data from each pool
    setRows(Array.from(latestPoolDataRef.current.values()));
  }, [stratumV1Data, paused]);

  // Compute derived fields without fee rate
  const computedRowsBase: Omit<SortedRow, 'feeRateComputed'>[] = useMemo(() => {
    return rows.map((row) => {
      const coinbaseRaw = formatCoinbaseRaw(
        row.coinbase1,
        row.extranonce1,
        row.extranonce2_length,
        row.coinbase2
      );
      const coinbase_outputs = computeCoinbaseOutputs(coinbaseRaw);
      const coinbaseScriptASCII = getFormattedCoinbaseAsciiTag(
        row.coinbase1,
        row.extranonce1,
        row.extranonce2_length,
        row.coinbase2
      );
      const coinbaseOutputValue = computeCoinbaseOutputValue(coinbaseRaw);
      const computedFirstTx = computeFirstTransaction(row.merkle_branches);

      return {
        ...row,
        coinbaseRaw,
        coinbaseScriptASCII,
        coinbaseOutputValue,
        first_transaction: computedFirstTx,
        coinbase_outputs,
      };
    });
  }, [rows]);

  // Add fee rates to computed rows
  const computedRows: SortedRow[] = useMemo(() => {
    return computedRowsBase.map(row => ({
      ...row,
      feeRateComputed: feeRateMap[row.first_transaction] ?? row.fee_rate
    }));
  }, [computedRowsBase, feeRateMap]);

  // Cache or fetch missing fee rates, but never re-fetch the same txid
  useEffect(() => {
    // Skip if paused
    if (paused) return;
    
    // Keep track of which txids we've processed in this effect run
    const processedTxids = new Set<string>();
    
    // For each row, see if we need to fetch its fee rate
    computedRows.forEach((row) => {
      // Skip empty block or if we already have a fee rate in feeRateMap
      if (!row.first_transaction || row.first_transaction === "empty block") return;
      
      const txid = row.first_transaction;
      
      // Skip if we've already processed this txid in this effect run
      if (processedTxids.has(txid)) return;
      processedTxids.add(txid);
      
      // Skip if we already have this fee rate or if it's already being fetched
      if (feeRateMap[txid] !== undefined) return;
      if (isRequestInFlight(txid)) return;

      // Mark as in-flight and fetch
      markRequestInFlight(txid);
      fetchFeeRate(txid)
        .then((rate) => {
          setFeeRateMap((prev) => {
            // Only update if we don't already have this fee rate
            if (prev[txid] !== undefined) return prev;
            return { ...prev, [txid]: rate };
          });
        })
        .catch((error) => {
          console.error(`Error fetching fee rate for ${txid}:`, error);
        })
        .finally(() => {
          clearRequestInFlight(txid);
        });
    });
  }, [computedRows, paused]);

  // Modified effect to fetch data for a specific block height
  useEffect(() => {
    // Clear the table immediately when filterBlockHeight changes
    setFilteredData([]);
    
    // Reset the fetch in progress flag when filterBlockHeight changes
    fetchInProgress.current = false;
    
    // Special case for the being-mined block (height -1)
    if (filterBlockHeight === -1) {
      // Reset to realtime data for the being-mined block
      setIsFiltering(false);
      return;
    }
    
    // Regular case for historical blocks
    if (filterBlockHeight && filterBlockHeight > 0) {
      fetchInProgress.current = true;
      setIsFiltering(true);
      setIsLoading(true);
      
      fetch(`/api/mining-notify?height=${filterBlockHeight}`)
        .then(res => res.json())
        .then(data => {
          if (Array.isArray(data)) {
            // Process all items from the API response
            const processedData = data.map(item => {
              const firstTx = computeFirstTransaction(item.merkle_branches);
              const coinbaseRaw = formatCoinbaseRaw(
                item.coinbase1,
                item.extranonce1,
                item.extranonce2_length,
                item.coinbase2
              );
              const coinbaseScriptASCII = getFormattedCoinbaseAsciiTag(
                item.coinbase1,
                item.extranonce1,
                item.extranonce2_length,
                item.coinbase2
              );
              const coinbaseOutputValue = computeCoinbaseOutputValue(coinbaseRaw);

              return {
                ...item,
                first_transaction: firstTx,
                coinbaseRaw,
                coinbaseScriptASCII,
                coinbaseOutputValue: computeCoinbaseOutputValue(coinbaseRaw),
                feeRateComputed: firstTx && firstTx !== "empty block" ? "fetching..." : "N/A",
                coinbase_outputs: computeCoinbaseOutputs(coinbaseRaw),
              };
            });
            
            // Sort the data by timestamp ascending (oldest first)
            const sortedData = [...processedData].sort((a, b) => {
              return a.timestamp.localeCompare(b.timestamp);
            });
            
            // Store the processed data for pagination
            setAllData(sortedData);
            setVisibleData(sortedData.slice(0, ITEMS_PER_PAGE));
            setHasMore(sortedData.length > ITEMS_PER_PAGE);
            setPage(1);
            
            // Also update filteredData for compatibility with existing code
            setFilteredData(sortedData);
            
            // Trigger fee rate fetching for all transactions in the historical data
            // by updating the feeRateMap with "fetching..." for each transaction
            const newFeeRateMap = { ...feeRateMap };
            let hasNewTxids = false;
            
            sortedData.forEach(item => {
              const firstTx = item.first_transaction;
              if (firstTx && firstTx !== "empty block" && firstTx !== "N/A" && newFeeRateMap[firstTx] === undefined) {
                newFeeRateMap[firstTx] = "fetching...";
                hasNewTxids = true;
              }
            });
            
            // Only update the feeRateMap if we have new transactions
            if (hasNewTxids) {
              setFeeRateMap(newFeeRateMap);
            }
          }
          setIsLoading(false);
          fetchInProgress.current = false;
        })
        .catch(error => {
          console.error("Error fetching historical data:", error);
          setIsLoading(false);
          fetchInProgress.current = false;
        });
    } else {
      // Reset to realtime data if no filterBlockHeight
      setIsFiltering(false);
    }
  }, [filterBlockHeight]);

  // Separate effect to fetch fee rates for filtered data
  useEffect(() => {
    // Skip if not filtering or no data
    if (!isFiltering || filteredData.length === 0) return;
    
    // Keep track of which txids we've processed in this effect run
    const processedTxids = new Set<string>();
    
    // For each item, see if we need to fetch its fee rate
    filteredData.forEach(item => {
      const firstTx = item.first_transaction;
      if (!firstTx || firstTx === "empty block" || firstTx === "N/A") return;
      
      // Skip if we've already processed this txid in this effect run
      if (processedTxids.has(firstTx)) return;
      processedTxids.add(firstTx);
      
      // Skip if we already have this fee rate or if it's already being fetched
      if (feeRateMap[firstTx] !== undefined && feeRateMap[firstTx] !== "fetching...") return;
      if (isRequestInFlight(firstTx)) return;

      // Mark as in-flight and fetch
      markRequestInFlight(firstTx);
      fetchFeeRate(firstTx)
        .then((rate) => {
          setFeeRateMap((prev) => {
            return { ...prev, [firstTx]: rate };
          });
          
          // Also update the filteredData with the new fee rate
          setFilteredData(prevData => 
            prevData.map(item => 
              item.first_transaction === firstTx 
                ? { ...item, feeRateComputed: rate } 
                : item
            )
          );
          
          // And update visibleData as well
          setVisibleData(prevData => 
            prevData.map(item => 
              item.first_transaction === firstTx 
                ? { ...item, feeRateComputed: rate } 
                : item
            )
          );
          
          // Also update allData to ensure consistency
          setAllData(prevData => 
            prevData.map(item => 
              item.first_transaction === firstTx 
                ? { ...item, feeRateComputed: rate } 
                : item
            )
          );
        })
        .catch((error) => {
          console.error(`Error fetching fee rate for filtered data ${firstTx}:`, error);
          // Set an error state in the fee rate map
          setFeeRateMap((prev) => {
            return { ...prev, [firstTx]: "Error" };
          });
          
          // Update the data with the error state
          setFilteredData(prevData => 
            prevData.map(item => 
              item.first_transaction === firstTx 
                ? { ...item, feeRateComputed: "Error" } 
                : item
            )
          );
          
          setVisibleData(prevData => 
            prevData.map(item => 
              item.first_transaction === firstTx 
                ? { ...item, feeRateComputed: "Error" } 
                : item
            )
          );
          
          // Also update allData with the error state
          setAllData(prevData => 
            prevData.map(item => 
              item.first_transaction === firstTx 
                ? { ...item, feeRateComputed: "Error" } 
                : item
            )
          );
        })
        .finally(() => {
          clearRequestInFlight(firstTx);
        });
    });
  }, [isFiltering, filteredData, feeRateMap]);

  // Update filtered data when data changes
  useEffect(() => {
    if (isFiltering) return; // Skip if we're in filtering mode
    
    if (isFirstFilteredDataRun.current) {
      // On first run, always set the data
      setFilteredData(computedRows);
      isFirstFilteredDataRun.current = false;
    } else {
      // On subsequent runs, only update if the data has actually changed
      // Compare only the essential properties to avoid deep comparison issues
      const hasChanged = computedRows.some((row, index) => {
        if (index >= filteredData.length) return true;
        const oldRow = filteredData[index];
        return (
          row.pool_name !== oldRow.pool_name ||
          row.height !== oldRow.height ||
          row.coinbaseScriptASCII !== oldRow.coinbaseScriptASCII ||
          row.first_transaction !== oldRow.first_transaction
        );
      }) || computedRows.length !== filteredData.length;
      
      if (hasChanged) {
        setFilteredData(computedRows);
      }
    }
  }, [computedRows, isFiltering, filteredData.length]);

  // Add separate effect to update filtered data when fee rates change
  useEffect(() => {
    if (!isFiltering || filteredData.length === 0) return;
    
    // Check if any fee rates have changed for our transactions
    let hasChanges = false;
    
    // Create a new array only if changes are needed
    const updatedData = filteredData.map(item => {
      if (
        item.first_transaction && 
        item.first_transaction !== "empty block" && 
        item.feeRateComputed !== feeRateMap[item.first_transaction] &&
        feeRateMap[item.first_transaction] !== undefined
      ) {
        hasChanges = true;
        return {
          ...item,
          feeRateComputed: feeRateMap[item.first_transaction]
        };
      }
      return item;
    });
    
    // Only update state if changes were made
    if (hasChanges) {
      setFilteredData(updatedData);
    }
  }, [feeRateMap, isFiltering]);

  // Function to load more data for infinite scrolling
  const loadMore = useCallback(() => {
    if (hasMore && !isLoading) {
      const nextPage = page + 1;
      
      // Load the next page of data from allData
      // Note: allData is not sorted here, the sorting will be done in the RealtimeTable component
      const newVisibleData = allData.slice(0, nextPage * ITEMS_PER_PAGE);
      
      // Update the visible data
      setVisibleData(newVisibleData);
      setPage(nextPage);
      setHasMore(allData.length > nextPage * ITEMS_PER_PAGE);
    }
  }, [hasMore, isLoading, page, allData, ITEMS_PER_PAGE, setVisibleData, setPage, setHasMore]);

  // Function to handle sorting
  const handleSort = useCallback((key: keyof SortedRow, sortConfig?: SortConfig) => {
    if (isFiltering && allData.length > 0) {
      // Sort the entire dataset for historical blocks
      
      // Use the direction from the provided sortConfig
      // This ensures consistency between the UI and the actual sorting
      const direction = sortConfig ? sortConfig.direction : "desc" as SortDirection;
      
      // Sort the entire dataset using our shared utility function
      const sortedAllData = sortRowsByKey(allData, key, direction);
      
      // Reset pagination to show the first page
      setPage(1);
      
      // Update the data with the sorted dataset
      setAllData(sortedAllData);
      setVisibleData(sortedAllData.slice(0, ITEMS_PER_PAGE));
      setHasMore(sortedAllData.length > ITEMS_PER_PAGE);
      
      // Also update filteredData for compatibility with existing code
      // This is important because rows is set to filteredData when isFiltering is true
      setFilteredData(sortedAllData);
    }
    
    // For realtime data, we don't need to do anything here
    // The RealtimeTable component will handle the sorting
  }, [isFiltering, allData, ITEMS_PER_PAGE, setAllData, setVisibleData, setPage, setHasMore, setFilteredData]);

  return {
    rows: isFiltering ? filteredData : computedRows,
    visibleRows: isFiltering ? visibleData : computedRows,
    isLoading,
    isFiltering,
    feeRateMap,
    loadMore,
    hasMore,
    handleSort,
    filteredData
  };
} 