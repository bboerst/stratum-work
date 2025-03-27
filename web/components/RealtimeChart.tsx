"use client";

import React, { useState, useEffect, useRef, useCallback, useTransition } from "react";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType, StratumV1Data } from "@/lib/types";

// Simple throttle implementation
function createThrottle<T extends (...args: unknown[]) => unknown>(
  func: T, 
  wait: number
): T & { cancel: () => void } {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastExecuted = 0;
  let cancelled = false;
  
  // The throttled function
  const throttled = function(...args: Parameters<T>) {
    if (cancelled) return;
    
    const now = Date.now();
    const remaining = wait - (now - lastExecuted);
    
    if (remaining <= 0 || remaining > wait) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      lastExecuted = now;
      func(...args);
    } else if (!timeout) {
      timeout = setTimeout(function() {
        lastExecuted = Date.now();
        timeout = null;
        func(...args);
      }, remaining);
    }
  } as T & { cancel: () => void };
  
  // Add cancel method
  throttled.cancel = function() {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    cancelled = true;
  };
  
  return throttled;
}

// Generate a consistent color from a string (pool name)
const stringToColor = (str: string): string => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  
  // Convert to HSL with fixed saturation and lightness for better visibility
  const h = Math.abs(hash % 360);
  return `hsl(${h}, 70%, 50%)`;
};

// Format timestamp to microseconds
const formatMicroseconds = (timestamp: number): string => {
  // Get just the microseconds part
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  const millis = date.getMilliseconds().toString().padStart(3, '0');
  
  return `${hours}:${minutes}:${seconds}.${millis}`;
};

interface ChartDataPoint {
  timestamp: number;
  poolName: string;
  poolIndex: number;
  height: number;
  version?: string;
  clean_jobs?: boolean | string;
  prev_hash?: string;
  nbits?: string;
  ntime?: string;
  [key: string]: unknown;
}

interface RealtimeChartProps {
  paused?: boolean;
  filterBlockHeight?: number;
  timeWindow?: number; // Time window in seconds
}

// Define pool colors map type
interface PoolColorsMap {
  [poolName: string]: string;
}

// Chart renderer component base
function RealtimeChartBase({ 
  paused = false, 
  filterBlockHeight,
  timeWindow = 30 // Default to 30 seconds
}: RealtimeChartProps) {
  // Get data from the global data stream
  const { filterByType } = useGlobalDataStream();
  
  // Add useTransition for non-urgent UI updates
  const [, startTransition] = useTransition();
  
  // Local state for time window to enable changing it
  const [localTimeWindow, setLocalTimeWindow] = useState(timeWindow);
  
  // State for visualization options
  const [showLabels, setShowLabels] = useState(false); // Off by default
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);
  const [hoveredPoint, setHoveredPoint] = useState<ChartDataPoint | null>(null);
  
  // Refs for DOM elements and data
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const optionsMenuRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Keep track of dimensions and time domain
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [timeDomain, setTimeDomain] = useState<[number, number]>([0, 0]);
  
  // Data storage
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [poolColors, setPoolColors] = useState<PoolColorsMap>({});
  const [poolRankings, setPoolRankings] = useState<Map<string, number>>(new Map());
  const [maxPoolCount, setMaxPoolCount] = useState<number>(10); // Track maximum pool count for stable scaling
  const poolDataHistoryRef = useRef<Map<string, ChartDataPoint[]>>(new Map());
  const timeDomainRef = useRef<[number, number]>([0, 0]);
  const localTimeWindowRef = useRef<number>(timeWindow);
  const dimensionsRef = useRef(dimensions);
  
  // Update refs when values change
  useEffect(() => {
    localTimeWindowRef.current = timeWindow;
  }, [timeWindow]);

  useEffect(() => {
    timeDomainRef.current = timeDomain;
  }, [timeDomain]);
  
  useEffect(() => {
    dimensionsRef.current = dimensions;
  }, [dimensions]);
  
  // Draw the chart - implemented as a memoized function to allow use in dependencies
  const drawChart = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Get pixel ratio for high-resolution displays
    const pixelRatio = window.devicePixelRatio || 1;
    ctx.resetTransform();
    ctx.scale(pixelRatio, pixelRatio);
    
    // Clear the canvas
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);
    
    // Draw background
    ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.fillRect(0, 0, dimensions.width, dimensions.height);
    
    // Draw axes
    ctx.strokeStyle = 'rgba(150, 150, 150, 0.3)';
    ctx.lineWidth = 1;
    
    // Draw x-axis
    ctx.beginPath();
    ctx.moveTo(60, dimensions.height - 20);
    ctx.lineTo(dimensions.width - 20, dimensions.height - 20);
    ctx.stroke();
    
    // Draw y-axis
    ctx.beginPath();
    ctx.moveTo(60, 30);
    ctx.lineTo(60, dimensions.height - 20);
    ctx.stroke();
    
    // Get the current time domain from ref to avoid re-renders
    const currentTimeDomain = timeDomainRef.current;
    
    // Skip if no data or invalid time domain
    if (chartData.length === 0 || (currentTimeDomain[0] === 0 && currentTimeDomain[1] === 0)) {
      // Draw empty chart message
      ctx.fillStyle = 'rgba(150, 150, 150, 0.5)';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data available', dimensions.width / 2, dimensions.height / 2);
      return;
    }
    
    // Helper functions for coordinate conversion
    const timestampToPixel = (timestamp: number): number => {
      const ratio = (timestamp - currentTimeDomain[0]) / (currentTimeDomain[1] - currentTimeDomain[0]);
      return 60 + ratio * (dimensions.width - 80); // 60px left margin, 20px right margin
    };
    
    const poolIndexToPixel = (index: number): number => {
      // Use a fixed denominator based on maxPoolCount for stable scaling
      // This ensures consistent vertical spacing even as new pools are added
      const denominator = Math.max(maxPoolCount, 10) + 1;
      const ratio = index / denominator;
      return 30 + ratio * (dimensions.height - 50); // 30px top margin, 20px bottom margin
    };
    
    // Draw x-axis tick marks and labels
    const tickCount = 5;
    const tickWidth = (dimensions.width - 80) / (tickCount - 1);
    
    ctx.fillStyle = 'rgba(150, 150, 150, 0.8)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    
    for (let i = 0; i < tickCount; i++) {
      const x = 60 + i * tickWidth;
      const timestamp = currentTimeDomain[0] + (i / (tickCount - 1)) * (currentTimeDomain[1] - currentTimeDomain[0]);
      
      // Draw tick mark
      ctx.beginPath();
      ctx.moveTo(x, dimensions.height - 20);
      ctx.lineTo(x, dimensions.height - 15);
      ctx.stroke();
      
      // Draw label
      ctx.fillText(formatMicroseconds(timestamp), x, dimensions.height - 5);
    }
    
    // Calculate point size based on canvas dimensions
    const pointSize = Math.max(3, Math.min(6, dimensions.width / 150));
    
    // Group data by pool name
    const groupedData = new Map<string, ChartDataPoint[]>();
    chartData.forEach(point => {
      if (!groupedData.has(point.poolName)) {
        groupedData.set(point.poolName, []);
      }
      groupedData.get(point.poolName)!.push(point);
    });
    
    // Draw data points for each pool
    groupedData.forEach((points, poolName) => {
      const isHovered = hoveredPoint?.poolName === poolName;
      const color = poolColors[poolName] || 'rgba(136, 132, 216, 0.8)';
      
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      
      points.forEach(point => {
        const x = timestampToPixel(point.timestamp);
        const y = poolIndexToPixel(point.poolIndex);
        
        // Skip points outside the visible area
        if (x < 60 || x > dimensions.width - 20 || y < 30 || y > dimensions.height - 20) {
          return;
        }
        
        // Draw the point
        ctx.beginPath();
        
        // Larger points for hovered pool
        const size = isHovered ? pointSize * 1.5 : pointSize;
        
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
        
        // Draw label if showLabels is true
        if (showLabels) {
          ctx.fillStyle = color;
          ctx.font = '8px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(poolName, x + 6, y + 3);
          ctx.fillStyle = color; // Reset fill style for next point
        }
        
        // Highlight if this is the exact hovered point
        if (hoveredPoint && point.timestamp === hoveredPoint.timestamp && point.poolName === hoveredPoint.poolName) {
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, size + 5, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
    });
    
    // Draw crosshair if hovering
    if (hoveredPoint) {
      const x = timestampToPixel(hoveredPoint.timestamp);
      const y = poolIndexToPixel(hoveredPoint.poolIndex);
      
      ctx.strokeStyle = 'rgba(200, 200, 200, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      
      // Vertical line
      ctx.beginPath();
      ctx.moveTo(x, 30);
      ctx.lineTo(x, dimensions.height - 20);
      ctx.stroke();
      
      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(60, y);
      ctx.lineTo(dimensions.width - 20, y);
      ctx.stroke();
      
      ctx.setLineDash([]); // Reset line dash
    }
  }, [dimensions, chartData, hoveredPoint, showLabels, poolColors, maxPoolCount]);

  // Draw the chart whenever relevant data changes
  useEffect(() => {
    drawChart();
  }, [drawChart]);

  // Update dimensions when container size changes
  useEffect(() => {
    const currentContainer = containerRef.current;
    if (!currentContainer) return;
    
    const updateDimensions = () => {
      if (!currentContainer || !canvasRef.current) return;
      
      const { width, height } = currentContainer.getBoundingClientRect();
      
      // Only update state if dimensions actually changed
      if (width !== dimensionsRef.current.width || height !== dimensionsRef.current.height) {
        // Update canvas size immediately without waiting for state update
        const pixelRatio = window.devicePixelRatio || 1;
        canvasRef.current.width = width * pixelRatio;
        canvasRef.current.height = height * pixelRatio;
        canvasRef.current.style.width = `${width}px`;
        canvasRef.current.style.height = `${height}px`;
        
        // Update state (will trigger drawChart via dependency)
        setDimensions({ width, height });
      }
    };
    
    // Initial update
    updateDimensions();
    
    // Add resize listener
    const resizeObserver = new ResizeObserver(() => {
      // Use requestAnimationFrame to throttle updates
      requestAnimationFrame(updateDimensions);
    });
    
    resizeObserver.observe(currentContainer);
    
    return () => {
      if (currentContainer) {
        resizeObserver.disconnect();
      }
    };
  }, []); // Empty dependency array - this effect should only run once
  
  // Parse timestamp - collector uses hex(time.time_ns())[2:] format
  const parseTimestamp = useCallback((timestampStr: string | number): number => {
    if (typeof timestampStr === 'number') return timestampStr;
    
    try {
      // First check if it's a valid date string
      const dateTimestamp = new Date(timestampStr).getTime();
      if (!isNaN(dateTimestamp)) {
        return dateTimestamp;
      }
      
      // Otherwise, parse as hexadecimal nanoseconds
      // Remove '0x' prefix if present
      const cleaned = timestampStr.replace(/^0x/, '');
      // Parse the hex string to get nanoseconds
      const nanoseconds = parseInt(cleaned, 16);
      // Convert to milliseconds for chart display
      return nanoseconds / 1000000;
    } catch (e) {
      console.error("Failed to parse timestamp:", timestampStr, e);
      return Date.now(); // Fallback to current time
    }
  }, []);
  
  // Prune old data beyond the time window to prevent memory leaks
  const pruneOldData = useCallback((cutoffTimeMs: number) => {
    poolDataHistoryRef.current.forEach((history, poolName) => {
      const prunedHistory = history.filter(point => point.timestamp >= cutoffTimeMs);
      poolDataHistoryRef.current.set(poolName, prunedHistory);
    });
  }, []);
  
  // Process data and filter by time window
  const processData = useCallback((stratumData: StratumV1Data[]) => {
    // Filter by block height if needed
    let filteredData = stratumData;
    if (filterBlockHeight) {
      filteredData = stratumData.filter(item => item.height === filterBlockHeight);
      
      // If we filtered out all data, use the complete dataset
      if (filteredData.length === 0) {
        filteredData = stratumData;
      }
    }
    
    // Calculate the earliest timestamp to include (current time - time window)
    const currentTimeMs = Date.now();
    const timeWindowMs = localTimeWindowRef.current * 1000; // Convert seconds to milliseconds
    const cutoffTimeMs = currentTimeMs - timeWindowMs;
    
    // Prune old data to avoid memory growth
    pruneOldData(cutoffTimeMs);
    
    // Collect pool names to assign colors and rankings
    const poolNames = new Set<string>();
    filteredData.forEach(item => {
      if (item.pool_name) {
        poolNames.add(item.pool_name);
      }
    });
    
    // Return early information for state updates
    const poolInfo = {
      poolNames: Array.from(poolNames),
      needsUpdate: poolNames.size > poolRankings.size,
      cutoffTimeMs
    };
    
    // Track min/max timestamps for domain calculation
    let minTimestamp = Number.MAX_SAFE_INTEGER;
    let maxTimestamp = 0;
    
    // Transform the data for the chart
    const processedData = filteredData.map(item => {
      // Parse timestamp from the data
      const timestamp = parseTimestamp(item.timestamp);
      
      // Update min/max for domain calculation
      minTimestamp = Math.min(minTimestamp, timestamp);
      maxTimestamp = Math.max(maxTimestamp, timestamp);
      
      return {
        timestamp,
        poolName: item.pool_name || 'Unknown',
        poolIndex: poolRankings.get(item.pool_name || 'Unknown') || 0,
        height: item.height,
        version: item.version,
        clean_jobs: item.clean_jobs,
        prev_hash: item.prev_hash,
        nbits: item.nbits,
        ntime: item.ntime
      };
    });
    
    // Update the history of data points for each pool
    processedData.forEach(point => {
      const poolName = point.poolName;
      if (!poolDataHistoryRef.current.has(poolName)) {
        poolDataHistoryRef.current.set(poolName, []);
      }
      
      const history = poolDataHistoryRef.current.get(poolName)!;
      
      // Only add the point if it has a new timestamp
      if (!history.some(existing => existing.timestamp === point.timestamp)) {
        history.push(point);
      }
      
      // Sort by timestamp descending
      history.sort((a, b) => b.timestamp - a.timestamp);
    });
    
    // Collect all the points to display from the history within the time window
    const resultPoints: ChartDataPoint[] = [];
    poolDataHistoryRef.current.forEach((history) => {
      // Filter to only include points within the time window
      const pointsInTimeWindow = history.filter(point => point.timestamp >= cutoffTimeMs);
      resultPoints.push(...pointsInTimeWindow);
    });
    
    // Return domain information
    const domainInfo = {
      hasValidDomain: minTimestamp !== Number.MAX_SAFE_INTEGER,
      newestTimestamp: Math.max(maxTimestamp, Date.now()),
    };
    
    return {
      points: resultPoints,
      poolInfo,
      domainInfo
    };
  }, [filterBlockHeight, parseTimestamp, poolRankings, pruneOldData]);
  
  // Reset pool data history when block height changes
  useEffect(() => {
    poolDataHistoryRef.current.clear();
    setChartData([]);
  }, [filterBlockHeight]);
  
  // Fetch and update data from the global stream
  useEffect(() => {
    if (paused) return;
    
    // Create a throttled update function to limit the frequency of updates
    const throttledUpdate = createThrottle(() => {
      // Get stratum updates from the stream
      const stratumUpdates = filterByType(StreamDataType.STRATUM_V1);
      if (stratumUpdates.length === 0) return;
      
      const stratumData = stratumUpdates.map(item => item.data as StratumV1Data);
      
      // Process the data to get the points within time window
      const result = processData(stratumData);
      
      // Handle pool rankings and colors updates
      if (result.poolInfo.needsUpdate) {
        const rankings = new Map<string, number>();
        const colors: PoolColorsMap = {};
        
        result.poolInfo.poolNames.sort().forEach((name, idx) => {
          rankings.set(name, idx + 1);
          colors[name] = stringToColor(name);
        });
        
        // Update state
        setPoolRankings(rankings);
        setPoolColors(colors);
        
        // Update max pool count to ensure consistent vertical scaling
        setMaxPoolCount(prev => Math.max(prev, result.poolInfo.poolNames.length));
      }
      
      // Update time domain if we have valid data
      if (result.domainInfo.hasValidDomain) {
        const newDomain: [number, number] = [
          result.domainInfo.newestTimestamp - (localTimeWindowRef.current * 1000),
          result.domainInfo.newestTimestamp
        ];
        // Store in ref first
        timeDomainRef.current = newDomain;
        // Update state (for UI rendering)
        setTimeDomain(newDomain);
      }
      
      // Update the chart data if we have points
      if (result.points.length > 0) {
        // Use startTransition to make this a lower priority update
        startTransition(() => {
          setChartData(result.points);
        });
      }
    }, 1000); // Throttle to max 1 update per second for better performance
    
    // Execute the throttled function
    throttledUpdate();
    
    // Return cleanup function to cancel any pending throttled calls
    return () => {
      throttledUpdate.cancel();
    };
  }, [filterByType, paused, processData, startTransition]);
  
  // Handle canvas mouse events
  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Find the closest point
    let closestPoint: ChartDataPoint | null = null;
    let minDistance = Infinity;
    
    // Get current time domain from ref
    const currentTimeDomain = timeDomainRef.current;
    
    // Skip hover detection if no time domain
    if (currentTimeDomain[0] === 0 && currentTimeDomain[1] === 0) return;
    
    // Helper functions for coordinate conversion - must be consistent with drawChart
    const timestampToPixel = (timestamp: number): number => {
      const ratio = (timestamp - currentTimeDomain[0]) / (currentTimeDomain[1] - currentTimeDomain[0]);
      return 60 + ratio * (dimensions.width - 80); // 60px left margin, 20px right margin
    };
    
    const poolIndexToPixel = (index: number): number => {
      // Use a fixed denominator based on maxPoolCount for stable scaling
      // This ensures consistent vertical spacing even as new pools are added
      const denominator = Math.max(maxPoolCount, 10) + 1;
      const ratio = index / denominator;
      return 30 + ratio * (dimensions.height - 50); // 30px top margin, 20px bottom margin
    };
    
    chartData.forEach(point => {
      const pointX = timestampToPixel(point.timestamp);
      const pointY = poolIndexToPixel(point.poolIndex);
      
      const distance = Math.sqrt(Math.pow(pointX - x, 2) + Math.pow(pointY - y, 2));
      if (distance < minDistance && distance < 20) { // 20px tolerance
        minDistance = distance;
        closestPoint = point;
      }
    });
    
    setHoveredPoint(closestPoint);
  }, [chartData, dimensions, maxPoolCount]);
  
  const handleCanvasMouseLeave = useCallback(() => {
    setHoveredPoint(null);
  }, []);
  
  // Handle outside click to close options menu
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (optionsMenuRef.current && !optionsMenuRef.current.contains(event.target as Node)) {
        setShowOptionsMenu(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);
  
  // Toggle options menu
  const toggleOptionsMenu = useCallback(() => {
    setShowOptionsMenu(prev => !prev);
  }, []);
  
  // Handle time window adjustment
  const adjustTimeWindow = useCallback((change: number) => {
    const newWindow = Math.max(5, Math.min(300, localTimeWindow + change)); // Limit between 5s and 5min
    setLocalTimeWindow(newWindow);
    localTimeWindowRef.current = newWindow;
  }, [localTimeWindow]);
  
  return (
    <div 
      className="w-full h-full relative" 
      onMouseLeave={handleCanvasMouseLeave}
    >
      {/* Chart header with title and options */}
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-sm font-medium">Timing</h3>
        
        {/* Options menu */}
        <div 
          ref={optionsMenuRef}
        >
          <button 
            onClick={toggleOptionsMenu}
            className="bg-opacity-20 bg-black dark:bg-white dark:bg-opacity-20 text-[10px] px-1.5 py-0.5 rounded"
          >
            Options
          </button>
          
          {showOptionsMenu && (
            <div className="absolute right-0 mt-1 w-48 rounded-md shadow-lg bg-white dark:bg-gray-800 ring-1 ring-black ring-opacity-5 p-2 z-10">
              <div className="space-y-3">
                {/* Show last time control */}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Show last:</span>
                  <div className="flex items-center space-x-2">
                    <button 
                      onClick={() => adjustTimeWindow(-15)} 
                      className="w-5 h-5 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded"
                    >
                      −
                    </button>
                    <span className="text-xs w-8 text-center">{localTimeWindow}s</span>
                    <button 
                      onClick={() => adjustTimeWindow(15)} 
                      className="w-5 h-5 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded"
                    >
                      +
                    </button>
                  </div>
                </div>
                
                {/* Show labels toggle */}
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Show labels:</span>
                  <button
                    onClick={() => setShowLabels(prev => !prev)}
                    className={`px-2 py-1 text-xs rounded ${
                      showLabels
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 dark:bg-gray-700'
                    }`}
                  >
                    {showLabels ? "On" : "Off"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      
      <div 
        ref={containerRef}
        className="w-full h-[calc(100%-24px)]" 
        style={{ cursor: 'crosshair' }}
      >
        <canvas
          ref={canvasRef}
          className="w-full h-full"
          onMouseMove={handleCanvasMouseMove}
          onMouseLeave={handleCanvasMouseLeave}
        />
      </div>
      
      {/* Fixed tooltip at the bottom of the chart */}
      {hoveredPoint && (
        <div className="absolute bottom-1 right-2 text-[9px] font-medium text-right bg-black/70 dark:bg-gray-800/90 p-1 rounded shadow-sm z-10">
          <span className="font-bold">{hoveredPoint.poolName}</span>
          {" | "}
          <span>Height: {hoveredPoint.height || 'N/A'}</span>
          <br />
          <span>Time: {formatMicroseconds(hoveredPoint.timestamp)}</span>
        </div>
      )}
    </div>
  );
}

// Wrap with React.memo to prevent unnecessary re-renders
const RealtimeChart = React.memo(RealtimeChartBase);

export default RealtimeChart; 