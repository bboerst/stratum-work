import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { StratumV1Data } from '@/lib/types';
import { SortedRow, SortDirection, SortConfig, ColumnWidths } from '@/types/tableTypes';
import { sortRowsByKey } from '@/utils/sortUtils';

// Hook for managing column visibility
export function useColumnVisibility() {
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

  const toggleColumn = useCallback((colKey: string) => {
    setColumnsVisible((prev) => ({ ...prev, [colKey]: !prev[colKey] }));
  }, []);

  return { columnsVisible, toggleColumn };
}

// Hook for managing column widths and resizing
export function useColumnResizing() {
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

  const isResizing = useRef(false);
  const currentColKey = useRef<string | null>(null);
  const startX = useRef<number>(0);
  const startWidth = useRef<number>(0);
  const resizeActiveRef = useRef(false);

  // Load widths from local storage
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("columnWidths");
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as ColumnWidths;
          setColumnWidths((prev: ColumnWidths) => ({ ...prev, ...parsed }));
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

  const handleMouseDown = useCallback((colKey: string, e: React.MouseEvent) => {
    isResizing.current = true;
    currentColKey.current = colKey;
    startX.current = e.clientX;
    startWidth.current = columnWidths[colKey] ?? 80;
    resizeActiveRef.current = false;
    // Prevent text selection
    document.body.style.userSelect = "none";
  }, [columnWidths]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current || !currentColKey.current) return;
    const diff = e.clientX - startX.current;
    if (Math.abs(diff) > 5) resizeActiveRef.current = true;
    const newWidth = Math.max(40, startWidth.current + diff);
    setColumnWidths((prev: ColumnWidths) => ({
      ...prev,
      [currentColKey.current as string]: newWidth,
    }));
  }, []);

  const handleMouseUp = useCallback(() => {
    isResizing.current = false;
    currentColKey.current = null;
    document.body.style.userSelect = "";
  }, []);

  useEffect(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  return { 
    columnWidths, 
    handleMouseDown, 
    resizeActiveRef 
  };
}

// Hook for managing sorting
export function useSorting(isFiltering: boolean) {
  // Default sort configurations
  const DEFAULT_REALTIME_SORT: SortConfig = { key: "coinbaseOutputValue", direction: "desc" };
  const DEFAULT_HISTORICAL_SORT: SortConfig = { key: "timestamp", direction: "desc" };
  
  // State for the sort configuration
  const [sortConfig, setSortConfig] = useState<SortConfig>(DEFAULT_REALTIME_SORT);
  const [isSorting, setIsSorting] = useState<boolean>(false);
  
  // Keep track of user-selected sort configurations
  const userSelectedSortRef = useRef<boolean>(false);

  // Update sort config when switching between realtime and historical
  useEffect(() => {
    // Only reset to default if the user hasn't selected a sort configuration
    if (!userSelectedSortRef.current) {
      const newConfig = isFiltering ? DEFAULT_HISTORICAL_SORT : DEFAULT_REALTIME_SORT;
      // Only update if the config has actually changed
      if (sortConfig.key !== newConfig.key || sortConfig.direction !== newConfig.direction) {
        setSortConfig(newConfig);
      }
    }
  }, [isFiltering, DEFAULT_HISTORICAL_SORT, DEFAULT_REALTIME_SORT, sortConfig]);

  // Custom setSortConfig function that logs the change
  const setSortConfigWithLogging = useCallback((newConfig: SortConfig) => {
    // Mark that the user has selected a sort configuration
    userSelectedSortRef.current = true;
    setSortConfig(newConfig);
  }, []);

  // Function to sort data based on the current sort configuration
  const sortData = useCallback((data: SortedRow[]) => {
    if (!data || data.length === 0) return [];
    
    // Using our shared sortRowsByKey utility function
    return sortRowsByKey(data, sortConfig.key, sortConfig.direction);
  }, [sortConfig]);

  return {
    sortConfig,
    setSortConfig: setSortConfigWithLogging,
    isSorting,
    setIsSorting,
    sortData
  };
}

// Hook for managing pagination
export function usePagination(isFiltering: boolean, isLoading: boolean, isSorting: boolean) {
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [allData, setAllData] = useState<SortedRow[]>([]);
  const [visibleData, setVisibleData] = useState<SortedRow[]>([]);
  const ITEMS_PER_PAGE = 50;
  
  // Create a ref for the intersection observer
  const observer = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Function to load more data when scrolling
  const loadMoreData = useCallback(() => {
    if (isFiltering && !isLoading && hasMore && !isSorting) {
      const nextItems = allData.slice(0, page * ITEMS_PER_PAGE);
      setVisibleData(nextItems);
      setPage(prevPage => prevPage + 1);
      setHasMore(nextItems.length < allData.length);
    }
  }, [isFiltering, isLoading, hasMore, allData, page, isSorting]);

  // Set up the intersection observer for infinite scrolling
  useEffect(() => {
    if (isFiltering) {
      const options = {
        root: null,
        rootMargin: '20px',
        threshold: 0.1,
      };

      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoading && !isSorting) {
          loadMoreData();
        }
      }, options);

      if (loadMoreRef.current) {
        observer.current.observe(loadMoreRef.current);
      }

      return () => {
        if (observer.current) {
          observer.current.disconnect();
        }
      };
    }
  }, [isFiltering, hasMore, isLoading, loadMoreData, isSorting]);

  return {
    page,
    setPage,
    hasMore,
    setHasMore,
    allData,
    setAllData,
    visibleData,
    setVisibleData,
    ITEMS_PER_PAGE,
    loadMoreRef
  };
} 