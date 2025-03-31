"use client";

import React, { useState, useEffect, useRef, useCallback, useTransition } from "react";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType, StratumV1Data } from "@/lib/types";
import { useHistoricalData } from "@/lib/HistoricalDataContext";
import { CHART_POINT_SIZES } from "@/lib/constants";

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
  pointSize?: number; // Size of data points in pixels
}

// Define pool colors map type
interface PoolColorsMap {
  [poolName: string]: string;
}

// Chart renderer component base
function RealtimeChartBase({ 
  paused = false, 
  filterBlockHeight,
  timeWindow = 30, // Default to 30 seconds
  pointSize
}: RealtimeChartProps) {
  // Get data from the global data stream
  const { filterByType } = useGlobalDataStream();
  
  // Get historical data from context
  const { historicalData, isHistoricalDataLoaded } = useHistoricalData();
  
  // Check if we're in historical mode (viewing a specific historical block)
  const isHistoricalBlock = filterBlockHeight !== undefined && filterBlockHeight !== -1;
  
  // Define point size based on mode and props
  const basePointSize = isHistoricalBlock 
    ? (pointSize || CHART_POINT_SIZES.HISTORICAL) 
    : (pointSize || CHART_POINT_SIZES.REALTIME);
  
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
  const [allPoolNames, setAllPoolNames] = useState<string[]>([]); // Track all pools we've ever seen
  const [maxPoolCount, setMaxPoolCount] = useState<number>(10); // Track maximum pool count for stable scaling
  const poolDataHistoryRef = useRef<Map<string, ChartDataPoint[]>>(new Map());
  const timeDomainRef = useRef<[number, number]>([0, 0]);
  const localTimeWindowRef = useRef<number>(timeWindow);
  const dimensionsRef = useRef(dimensions);
  
  // Track if we've already loaded historical data for a given block height
  const [, setHistoricalDataLoaded] = useState(false);
  const currentBlockHeightRef = useRef<number | undefined>(filterBlockHeight);
  
  // Reset the historical data loaded flag when the block height changes
  useEffect(() => {
    if (currentBlockHeightRef.current !== filterBlockHeight) {
      setHistoricalDataLoaded(false);
      currentBlockHeightRef.current = filterBlockHeight;
      
      // Clear existing data when switching between blocks
      poolDataHistoryRef.current.clear();
      setChartData([]);
      
      // Reset pool tracking when switching blocks
      if (isHistoricalBlock) {
        setAllPoolNames([]);
      }
    }
  }, [filterBlockHeight, isHistoricalBlock]);
  
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
    
    // Get pixel ratio and use it directly
    const pixelRatio = window.devicePixelRatio || 1;
    ctx.resetTransform();
    ctx.scale(pixelRatio, pixelRatio);
    
    // Clear the canvas
    ctx.clearRect(0, 0, dimensions.width, dimensions.height);
    
    // Skip if no data
    if (chartData.length === 0) {
      // Draw empty chart message
      ctx.fillStyle = 'rgba(150, 150, 150, 0.5)';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      
      // Special message for historical blocks with no data
      if (isHistoricalBlock && isHistoricalDataLoaded) {
        ctx.fillText('No data available for this block', dimensions.width / 2, dimensions.height / 2);
      } else {
        ctx.fillText('No data available', dimensions.width / 2, dimensions.height / 2);
      }
      return;
    }

    // Calculate margin and available area
    const margin = { top: 10, right: 20, bottom: 20, left: 20 };
    const availableWidth = dimensions.width - margin.left - margin.right;
    const availableHeight = dimensions.height - margin.top - margin.bottom;
    
    // Group data by pool name
    const groupedData = new Map<string, ChartDataPoint[]>();
    chartData.forEach(point => {
      if (!groupedData.has(point.poolName)) {
        groupedData.set(point.poolName, []);
      }
      groupedData.get(point.poolName)!.push(point);
    });
    
    // Use allPoolNames for stable vertical positioning
    // If allPoolNames is empty, fall back to current pool names
    const stablePoolNames = allPoolNames.length > 0 
      ? allPoolNames 
      : Array.from(groupedData.keys()).sort();
    
    // Get min/max timestamps for domain calculation
    const timestamps = chartData.map(point => point.timestamp);
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    
    // If we don't have a valid time domain from data stream, use the min/max from the data
    const currentTimeDomain = timeDomainRef.current;
    const useCalculatedDomain = currentTimeDomain[0] === 0 && currentTimeDomain[1] === 0;
    const effectiveTimeDomain: [number, number] = useCalculatedDomain 
      ? [minTime, maxTime] 
      : currentTimeDomain;
    
    // Helper functions for coordinate conversion
    const timestampToPixel = (timestamp: number): number => {
      // Check for invalid domain that would cause division by zero
      if (effectiveTimeDomain[1] === effectiveTimeDomain[0]) {
        return margin.left + availableWidth / 2; // Center point
      }
      
      const ratio = (timestamp - effectiveTimeDomain[0]) / (effectiveTimeDomain[1] - effectiveTimeDomain[0]);
      return margin.left + ratio * availableWidth;
    };
    
    const poolIndexToPixel = (index: number, poolName: string): number => {
      // Get the index of the pool in the stable pool names list
      const poolIndex = stablePoolNames.indexOf(poolName);
      
      // If pool is not in stable list, use a fallback
      const effectivePoolIndex = poolIndex >= 0 ? poolIndex : (stablePoolNames.length + index % 5);
      
      // Use a fixed denominator based on the length of the stable pool names list
      // This ensures the vertical positions remain stable
      const denominator = Math.max(stablePoolNames.length, maxPoolCount, 10);
      const ratio = effectivePoolIndex / denominator;
      
      // Remove the random offset to prevent points from moving when hovering
      return margin.top + ratio * availableHeight;
    };
    
    // Draw axes
    ctx.strokeStyle = 'rgba(150, 150, 150, 0.3)';
    ctx.lineWidth = 1;
    
    // Draw x-axis
    ctx.beginPath();
    ctx.moveTo(margin.left, dimensions.height - margin.bottom);
    ctx.lineTo(dimensions.width - margin.right, dimensions.height - margin.bottom);
    ctx.stroke();
    
    // Draw x-axis tick marks and labels
    const tickCount = 5;
    const tickWidth = availableWidth / (tickCount - 1);
    
    ctx.fillStyle = 'rgba(150, 150, 150, 0.8)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    
    for (let i = 0; i < tickCount; i++) {
      const x = margin.left + i * tickWidth;
      const timestamp = effectiveTimeDomain[0] + (i / (tickCount - 1)) * (effectiveTimeDomain[1] - effectiveTimeDomain[0]);
      
      // Draw tick mark
      ctx.beginPath();
      ctx.moveTo(x, dimensions.height - margin.bottom);
      ctx.lineTo(x, dimensions.height - margin.bottom + 5);
      ctx.stroke();
      
      // Draw label
      ctx.fillText(formatMicroseconds(timestamp), x, dimensions.height - margin.bottom + 15);
    }
    
    // Draw data points for each pool
    groupedData.forEach((points, poolName) => {
      const isHovered = hoveredPoint?.poolName === poolName;
      const color = poolColors[poolName] || stringToColor(poolName);
      
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      
      points.forEach(point => {
        const x = timestampToPixel(point.timestamp);
        const y = poolIndexToPixel(point.poolIndex, point.poolName);
        
        // Skip points outside the visible area
        if (x < margin.left || x > dimensions.width - margin.right || 
            y < margin.top || y > dimensions.height - margin.bottom) {
          return;
        }
        
        // Draw the point
        ctx.beginPath();
        
        // Larger points for hovered pool
        const size = isHovered ? basePointSize * CHART_POINT_SIZES.HOVER_MULTIPLIER : basePointSize;
        
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
        
        // Add a subtle outline for better visibility against dark backgrounds
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.stroke();
        ctx.strokeStyle = color; // Reset stroke style
        
        // Draw label if showLabels is true
        if (showLabels) {
          ctx.fillStyle = color;
          ctx.font = '9px sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(poolName, x + 6, y + 3);
          ctx.fillStyle = color; // Reset fill style for next point
        }
        
        // Highlight if this is the exact hovered point
        if (hoveredPoint && point.timestamp === hoveredPoint.timestamp && point.poolName === hoveredPoint.poolName) {
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, size + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
    });
    
    // Draw crosshair if hovering
    if (hoveredPoint) {
      const x = timestampToPixel(hoveredPoint.timestamp);
      const y = poolIndexToPixel(hoveredPoint.poolIndex, hoveredPoint.poolName);
      
      ctx.strokeStyle = 'rgba(200, 200, 200, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      
      // Vertical line
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, dimensions.height - margin.bottom);
      ctx.stroke();
      
      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(dimensions.width - margin.right, y);
      ctx.stroke();
      
      ctx.setLineDash([]); // Reset line dash
    }
  }, [dimensions, chartData, hoveredPoint, showLabels, poolColors, maxPoolCount, isHistoricalBlock, isHistoricalDataLoaded, basePointSize, allPoolNames]);

  // Draw the chart whenever dependencies change
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
      // For historical blocks, the timestamp might be in ISO format or similar
      if (isHistoricalBlock) {
        // First check if it's a valid date string (ISO format)
        const dateTimestamp = new Date(timestampStr).getTime();
        if (!isNaN(dateTimestamp)) {
          return dateTimestamp;
        }
        
        // Sometimes timestamps in the DB are just large numbers stored as strings
        const numValue = Number(timestampStr);
        if (!isNaN(numValue)) {
          // If it's a very large number, it might be nanoseconds
          if (numValue > 1e15) {
            const msValue = numValue / 1000000;
            return msValue;
          }
          
          // If it's a moderately large number, it might be milliseconds
          if (numValue > 1e9) {
            return numValue;
          }
          
          // If it's a smaller number, it might be seconds
          return numValue * 1000;
        }
      } else {
        // For non-historical data, first try as date string
        const dateTimestamp = new Date(timestampStr).getTime();
        if (!isNaN(dateTimestamp)) {
          return dateTimestamp;
        }
      }
      
      // Otherwise, parse as hexadecimal nanoseconds (for collector format)
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
  }, [isHistoricalBlock]);
  
  // Direct approach: Create data points from historical data when component is paused
  useEffect(() => {
    if (isHistoricalBlock && historicalData.length > 0) {
      // Create a map of pool names to indices for consistent y-axis positioning
      const poolNames = Array.from(new Set(historicalData.map(item => item.pool_name || 'unknown'))).sort();
      
      // Create data points directly from historical records
      const points: ChartDataPoint[] = [];
      
      historicalData.forEach(record => {
        // Parse timestamp - try several formats
        let timestamp: number;
        try {
          if (record.timestamp) {
            if (typeof record.timestamp === 'string' && record.timestamp.startsWith('0x')) {
              // Hex-encoded timestamp (nanoseconds)
              const cleaned = record.timestamp.replace(/^0x/, '');
              timestamp = parseInt(cleaned, 16) / 1000000; // Convert to milliseconds
            } else if (typeof record.timestamp === 'string' && /^[0-9a-f]+$/i.test(record.timestamp)) {
              // Non-prefixed hex timestamp
              timestamp = parseInt(record.timestamp, 16) / 1000000; // Convert to milliseconds
            } else {
              // Try as a regular timestamp
              timestamp = parseTimestamp(record.timestamp);
            }
          } else {
            timestamp = Date.now() - Math.random() * 1000; // Random timestamp in last second
          }
          
          // Get stable pool index
          const poolName = record.pool_name || 'unknown';
          const poolIndex = poolNames.indexOf(poolName) + 1; // +1 to avoid 0 index
          
          points.push({
            timestamp,
            poolName,
            poolIndex,
            height: record.height || 0,
            // Include other fields if needed
            version: record.version,
            prev_hash: record.prev_hash,
            nbits: record.nbits,
            ntime: record.ntime,
          });
        } catch (e) {
          console.error("Failed to process record:", record, e);
        }
      });
      
      // Sort by timestamp
      points.sort((a, b) => a.timestamp - b.timestamp);
      
      // If min and max timestamps are identical, artificially spread them apart
      const timestamps = points.map(p => p.timestamp);
      const minTime = Math.min(...timestamps);
      const maxTime = Math.max(...timestamps);
      
      if (minTime === maxTime && points.length > 0) {
        // Spread the points horizontally by adding artificial offset based on their order
        points.forEach((point, index) => {
          point.timestamp += index * 100; // Add 100ms spacing between points
        });
      }
      
      // Set domain for drawing
      const newTimestamps = points.map(p => p.timestamp);
      const newMinTime = Math.min(...newTimestamps);
      const newMaxTime = Math.max(...newTimestamps);
      
      // Set time domain for the chart
      timeDomainRef.current = [newMinTime, newMaxTime];
      setTimeDomain([newMinTime, newMaxTime]);
      
      // Update the chart data
      setChartData(points);
      setHistoricalDataLoaded(true);
    }
  }, [isHistoricalBlock, historicalData, parseTimestamp]);
  
  // Prune old data beyond the time window to prevent memory leaks
  const pruneOldData = useCallback((cutoffTimeMs: number) => {
    poolDataHistoryRef.current.forEach((history, poolName) => {
      const prunedHistory = history.filter(point => point.timestamp >= cutoffTimeMs);
      poolDataHistoryRef.current.set(poolName, prunedHistory);
    });
  }, []);
  
  // Handle canvas mouse events
  const handleCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const rect = canvas.getBoundingClientRect();
    
    // Calculate mouse position accounting for pixel ratio and canvas scaling
    const x = (e.clientX - rect.left);
    const y = (e.clientY - rect.top);
    
    // Find the closest point
    let closestPoint: ChartDataPoint | null = null;
    let minDistance = Infinity;
    
    // Ensure we have data to work with
    if (chartData.length === 0) {
      setHoveredPoint(null);
      return;
    }
    
    // Calculate margins (must match drawChart exactly)
    const margin =  { top: 10, right: 20, bottom: 20, left: 20 };
    const availableWidth = dimensions.width - margin.left - margin.right;
    const availableHeight = dimensions.height - margin.top - margin.bottom;
    
    // Use allPoolNames for stable vertical positioning (same as in drawChart)
    const currentPoolNames = Array.from(new Set(chartData.map(point => point.poolName)));
    const stablePoolNames = allPoolNames.length > 0 
      ? allPoolNames 
      : currentPoolNames.sort();
    
    // Calculate timestamps for domain determination
    const timestamps = chartData.map(point => point.timestamp);
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    
    // Get current time domain from ref
    const currentTimeDomain = timeDomainRef.current;
    
    // Use calculated domain if current domain is invalid (must match drawChart exactly)
    const useCalculatedDomain = currentTimeDomain[0] === 0 && currentTimeDomain[1] === 0;
    const effectiveTimeDomain: [number, number] = useCalculatedDomain 
      ? [minTime, maxTime] 
      : currentTimeDomain;
    
    // Helper functions for coordinate conversion - must be identical to drawChart
    const timestampToPixel = (timestamp: number): number => {
      // Check for invalid domain that would cause division by zero
      if (effectiveTimeDomain[1] === effectiveTimeDomain[0]) {
        return margin.left + availableWidth / 2; // Center point
      }
      
      const ratio = (timestamp - effectiveTimeDomain[0]) / (effectiveTimeDomain[1] - effectiveTimeDomain[0]);
      return margin.left + ratio * availableWidth;
    };
    
    const poolIndexToPixel = (index: number, poolName: string): number => {
      // Get the index of the pool in the stable pool names list (must match drawChart)
      const poolIndex = stablePoolNames.indexOf(poolName);
      
      // If pool is not in stable list, use a fallback
      const effectivePoolIndex = poolIndex >= 0 ? poolIndex : (stablePoolNames.length + index % 5);
      
      // Use a fixed denominator based on the length of the stable pool names list
      const denominator = Math.max(stablePoolNames.length, maxPoolCount, 10);
      const ratio = effectivePoolIndex / denominator;
      
      // Must match drawChart exactly - no randomness here
      return margin.top + ratio * availableHeight;
    };
    
    // Use constants for hover tolerance
    const hoverTolerance = basePointSize * CHART_POINT_SIZES.HOVER_TOLERANCE_MULTIPLIER;
    
    chartData.forEach(point => {
      const pointX = timestampToPixel(point.timestamp);
      const pointY = poolIndexToPixel(point.poolIndex, point.poolName);
      
      // Calculate distance using actual screen coordinates
      const distance = Math.sqrt(
        Math.pow((pointX - x), 2) + 
        Math.pow((pointY - y), 2)
      );

      if (distance < minDistance && distance < hoverTolerance) { 
        minDistance = distance;
        closestPoint = point;
      }
    });
    
    setHoveredPoint(closestPoint);
  }, [chartData, dimensions, maxPoolCount, allPoolNames, basePointSize]);
  
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
  
  // Process data and filter by time window
  const processData = useCallback((stratumData: StratumV1Data[]) => {
    // Filter by block height if needed
    let filteredData = stratumData;
    
    if (isHistoricalBlock) {
      // For historical blocks, we're more explicit about filtering
      filteredData = stratumData.filter(item => item.height === filterBlockHeight);
    }
    
    // Calculate the earliest timestamp to include based on time window
    const currentTimeMs = Date.now();
    const timeWindowMs = localTimeWindowRef.current * 1000; // Convert seconds to milliseconds
    
    // For historical data, don't apply cutoff time
    // For real-time data, use the time window for filtering
    const cutoffTimeMs = isHistoricalBlock ? 0 : currentTimeMs - timeWindowMs;
    
    // Prune old data to avoid memory growth, but only for real-time data
    if (!isHistoricalBlock) {
      pruneOldData(cutoffTimeMs);
    }

    // Special case for data with no results after filtering
    if (filteredData.length === 0) {
      return {
        points: [],
        poolInfo: {
          poolNames: [],
          cutoffTimeMs
        },
        domainInfo: {
          hasValidDomain: false,
          newestTimestamp: Date.now(),
          minTimestamp: 0,
          maxTimestamp: 0
        }
      };
    }
    
    // Collect pool names to assign colors and rankings
    const poolNames = new Set<string>();
    filteredData.forEach(item => {
      if (item.pool_name) {
        poolNames.add(item.pool_name);
      }
    });
    
    // Get current pools as array
    const currentPoolNames = Array.from(poolNames).sort();
    
    // Update the allPoolNames state to include any new pools
    if (!isHistoricalBlock) {
      const newPools = currentPoolNames.filter(name => !allPoolNames.includes(name));
      if (newPools.length > 0) {
        const updatedPoolNames = [...allPoolNames, ...newPools].sort();
        setAllPoolNames(updatedPoolNames);
        
        // Also update rankings for new pools
        const updatedRankings = new Map(poolRankings);
        newPools.forEach((name, idx) => {
          updatedRankings.set(name, allPoolNames.length + idx + 1);
        });
        setPoolRankings(updatedRankings);
        
        // Update colors for all pools
        const updatedColors: PoolColorsMap = {...poolColors};
        updatedPoolNames.forEach(name => {
          if (!updatedColors[name]) {
            updatedColors[name] = stringToColor(name);
          }
        });
        setPoolColors(updatedColors);
        
        // Update max pool count for scaling calculations
        setMaxPoolCount(Math.max(maxPoolCount, updatedPoolNames.length));
      }
    } else {
      // For historical blocks, just use the current pools since we reset when switching blocks
      setAllPoolNames(currentPoolNames);
      
      // Update rankings, colors for historical view
      const rankings = new Map<string, number>();
      const colors: PoolColorsMap = {};
      
      currentPoolNames.forEach((name, idx) => {
        rankings.set(name, idx + 1);
        colors[name] = stringToColor(name);
      });
      
      setPoolRankings(rankings);
      setPoolColors(colors);
      setMaxPoolCount(Math.max(maxPoolCount, currentPoolNames.length));
    }
    
    // Return pool info
    const poolInfo = {
      poolNames: currentPoolNames,
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
      
      // Use current rankings or default to an evenly distributed value
      const poolName = item.pool_name || 'Unknown';
      const poolIndex = poolRankings.get(poolName) || 
        (currentPoolNames.indexOf(poolName) + 1) || 1;
      
      return {
        timestamp,
        poolName,
        poolIndex,
        height: item.height,
        version: item.version,
        clean_jobs: item.clean_jobs,
        prev_hash: item.prev_hash,
        nbits: item.nbits,
        ntime: item.ntime
      };
    });
    
    // Real-time data: Update the pool data history and filter by time window
    if (!isHistoricalBlock) {
      // Store processed data in the pool history
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
      
      // Collect points within the time window
      const resultPoints: ChartDataPoint[] = [];
      
      poolDataHistoryRef.current.forEach((history) => {
        const pointsInTimeWindow = history.filter(point => point.timestamp >= cutoffTimeMs);
        resultPoints.push(...pointsInTimeWindow);
      });
      
      // Return domain information and filtered points
      return {
        points: resultPoints,
        poolInfo,
        domainInfo: {
          hasValidDomain: minTimestamp !== Number.MAX_SAFE_INTEGER,
          newestTimestamp: Math.max(maxTimestamp, Date.now()),
          minTimestamp,
          maxTimestamp
        }
      };
    }
    
    // For historical data: Use processed points directly
    return {
      points: processedData,
      poolInfo,
      domainInfo: {
        hasValidDomain: minTimestamp !== Number.MAX_SAFE_INTEGER && minTimestamp !== maxTimestamp,
        newestTimestamp: Math.max(maxTimestamp, Date.now()),
        minTimestamp,
        maxTimestamp
      }
    };
  }, [filterBlockHeight, parseTimestamp, poolRankings, pruneOldData, maxPoolCount, isHistoricalBlock, allPoolNames, poolColors]);
  
  // Reset pool data history when block height changes
  useEffect(() => {
    poolDataHistoryRef.current.clear();
    setChartData([]);
  }, [filterBlockHeight]);
  
  // Fetch and update data from the global stream or historical data
  useEffect(() => {
    // Don't fetch if paused
    if (paused) return;
    
    // We'll handle historical data with the direct approach above
    // Only fetch real-time data in this effect
    if (!isHistoricalBlock) {
      // Create a throttled update function to limit the frequency of updates
      const throttledUpdate = createThrottle(() => {
        // Get stratum updates from the stream
        const stratumUpdates = filterByType(StreamDataType.STRATUM_V1);
        if (stratumUpdates.length === 0) return;
        
        const stratumData = stratumUpdates.map(item => item.data as StratumV1Data);
        
        // Process the data to get the points within time window
        const result = processData(stratumData);
        
        // Update time domain if we have valid data
        if (result.domainInfo.hasValidDomain) {
          // For real-time data, use the standard moving window approach
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
    }
  }, [filterByType, paused, processData, startTransition, isHistoricalBlock]);
  
  return (
    <div 
      className="w-full h-full relative" 
      onMouseLeave={handleCanvasMouseLeave}
    >
      {/* Chart header with title and options - only show for non-historical blocks */}
      {!isHistoricalBlock && (
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
      )}
      
      <div 
        ref={containerRef}
        className={`w-full ${isHistoricalBlock ? 'h-full' : 'h-[calc(100%-24px)]'}`}
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