"use client";

import React, { useState, useEffect, useRef, useCallback, useTransition } from "react";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType, StratumV1Data, CoinbaseOutput } from "@/lib/types";
import { useHistoricalData } from "@/lib/HistoricalDataContext";
import { CHART_POINT_SIZES } from "@/lib/constants";
import {
    computeCoinbaseOutputs,
    decodeCoinbaseScriptSigInfo,
    CoinbaseScriptSigInfo,
    getCoinbaseTxDetails,
    CoinbaseTxDetails,
    getFormattedCoinbaseAsciiTag,
    computeCoinbaseOutputValue,
    getTransaction
} from "@/utils/bitcoinUtils";

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
  changeType?: ChangeCategory;
  changedOpReturnProtocol?: string;
  [key: string]: unknown;
}

// Define more specific change categories
type ChangeCategory =
  | 'op_return_rsk_changed'
  | 'op_return_coredao_changed'
  | 'op_return_other_known_protocol_changed'
  | 'op_return_unknown_protocol_changed'
  | 'op_return_structure_changed'
  | 'auxpow_changed'
  | 'coinbase_script_tag_changed'
  | 'coinbase_height_changed'
  | 'witness_commitment_changed'
  | 'merkle_tx_update'
  | 'coinbase_outputs_structure_changed'
  | 'coinbase_fixed_fields_changed'
  | 'stratum_header_fields_changed'
  | 'clean_jobs_changed'
  | 'no_significant_change';

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

interface PoolState {
  stratumData: StratumV1Data;
  coinbaseRaw: string;
  coinbaseOutputs: CoinbaseOutput[];
  scriptSigInfo: CoinbaseScriptSigInfo | null;
  txDetails: CoinbaseTxDetails | null;
  coinbaseOutputValue: number | undefined;
  coinbaseAsciiTag: string | null;
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
  const lastPoolStatesRef = useRef<Map<string, PoolState>>(new Map());
  
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
        
        // Visual indication for changed data
        if (point.changeType) {
          const originalLineWidth = ctx.lineWidth;
          const originalStrokeStyle = ctx.strokeStyle;

          // Define styles for each change type
          // Color scheme: RSK (lime), Other OP_RETURN (cyan), AuxPoW (magenta),
          // Script Tag (purple), Height (teal), Witness (orange),
          // Merkle/Tx Update (gold), Outputs Structure (pink), Fixed Fields (blue),
          // Stratum Header (red), Clean Jobs (gray)
          let changeColor = 'yellow'; // Default for 'other_field_changed' from previous version
          let outlineThicknessMultiplier = 0.4;
          let outlineRadiusMultiplier = 0.4;

          switch (point.changeType) {
              case 'op_return_rsk_changed':
                  changeColor = 'lime'; 
                  outlineThicknessMultiplier = 0.8;
                  outlineRadiusMultiplier = 0.8;
                  break;
              case 'op_return_coredao_changed':
                  changeColor = '#00E5FF'; // Bright Cyan for CoreDAO
                  outlineThicknessMultiplier = 0.7;
                  outlineRadiusMultiplier = 0.7;
                  break;
              case 'op_return_other_known_protocol_changed':
                  changeColor = '#FFD740'; // Amber/Orange for other known protocols
                  outlineThicknessMultiplier = 0.6;
                  outlineRadiusMultiplier = 0.6;
                  break;
              case 'op_return_unknown_protocol_changed':
                  changeColor = '#BDBDBD'; // Grey for unknown protocol OP_RETURN changes
                  outlineThicknessMultiplier = 0.5;
                  outlineRadiusMultiplier = 0.5;
                  break;
              case 'op_return_structure_changed':
                  changeColor = '#FF80AB'; // Pink for OP_RETURN structure changes
                  outlineThicknessMultiplier = 0.5;
                  outlineRadiusMultiplier = 0.5;
                  break;
              case 'auxpow_changed':
                  changeColor = '#E91E63'; // Magenta
                  outlineThicknessMultiplier = 0.6;
                  outlineRadiusMultiplier = 0.6;
                  break;
              case 'coinbase_script_tag_changed':
                  changeColor = '#9C27B0'; // Purple
                  outlineThicknessMultiplier = 0.5;
                  outlineRadiusMultiplier = 0.5;
                  break;
              case 'coinbase_height_changed':
                  changeColor = '#009688'; // Teal
                  outlineThicknessMultiplier = 0.5;
                  outlineRadiusMultiplier = 0.5;
                  break;
              case 'witness_commitment_changed':
                  changeColor = '#FF9800'; // Orange
                  outlineThicknessMultiplier = 0.6;
                  outlineRadiusMultiplier = 0.6;
                  break;
              case 'merkle_tx_update':
                  changeColor = '#FFC107'; // Gold/Amber
                  outlineThicknessMultiplier = 0.5;
                  outlineRadiusMultiplier = 0.5;
                  break;
              case 'coinbase_outputs_structure_changed':
                  changeColor = '#F48FB1'; // Light Pink
                  outlineThicknessMultiplier = 0.5;
                  outlineRadiusMultiplier = 0.5;
                  break;
              case 'coinbase_fixed_fields_changed':
                  changeColor = '#2196F3'; // Blue
                  outlineThicknessMultiplier = 0.4;
                  outlineRadiusMultiplier = 0.4;
                  break;
              case 'stratum_header_fields_changed':
                  changeColor = '#f44336'; // Red
                  outlineThicknessMultiplier = 0.4;
                  outlineRadiusMultiplier = 0.4;
                  break;
              case 'clean_jobs_changed':
                  changeColor = '#9E9E9E'; // Grey
                  outlineThicknessMultiplier = 0.3;
                  outlineRadiusMultiplier = 0.3;
                  break;
              // Default case handles 'other_field_changed' if it were still used, or new unstyled types
          }

          if (point.changeType !== 'no_significant_change') {
              ctx.strokeStyle = changeColor;
              ctx.lineWidth = basePointSize > 2 ? basePointSize * outlineThicknessMultiplier : Math.max(1, outlineThicknessMultiplier * 1.5);
              ctx.beginPath();
              ctx.arc(x, y, size + basePointSize * outlineRadiusMultiplier, 0, Math.PI * 2);
              ctx.stroke();
          }

          ctx.lineWidth = originalLineWidth;
        }
        
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
  
  // Helper to identify RSK OP_RETURN outputs
  const isRskOpReturnOutput = (output: CoinbaseOutput): boolean => {
    if (output.type === 'nulldata' && output.decodedData?.dataHex) {
      // RSKBLOCK: hex is 52534b424c4f434b3a
      // Check if the dataHex (converted to uppercase for case-insensitivity) includes "RSKBLOCK:"
      return output.decodedData.dataHex.toUpperCase().includes('52534B424C4F434B3A');
    }
    return false;
  };
  
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
      const poolName = item.pool_name || 'Unknown';
      const lastKnownPoolState = lastPoolStatesRef.current.get(poolName);

      // Construct current coinbase raw string
      let currentCoinbaseRaw = "";
      if (item.coinbase1 && item.coinbase2 && item.extranonce1 !== undefined && typeof item.extranonce2_length === 'number') {
          currentCoinbaseRaw = item.coinbase1 + item.extranonce1 + '00'.repeat(item.extranonce2_length) + item.coinbase2;
      }
      
      // Parse current coinbase data
      let currentScriptSigInfo: CoinbaseScriptSigInfo | null = null;
      let currentTxDetails: CoinbaseTxDetails | null = null;
      let currentCoinbaseOutputs: CoinbaseOutput[] = [];
      let currentCoinbaseOutputValue: number | undefined = undefined;
      let currentAsciiTag: string | null = null;

      if (currentCoinbaseRaw) {
        try {
          const tx = getTransaction(currentCoinbaseRaw); // Re-decode for scriptSig info
          if (tx.ins && tx.ins.length > 0) {
            currentScriptSigInfo = decodeCoinbaseScriptSigInfo(tx.ins[0].script);
          }
          currentTxDetails = getCoinbaseTxDetails(currentCoinbaseRaw);
          currentCoinbaseOutputs = computeCoinbaseOutputs(currentCoinbaseRaw);
          currentCoinbaseOutputValue = computeCoinbaseOutputValue(currentCoinbaseRaw);
          currentAsciiTag = getFormattedCoinbaseAsciiTag(
            item.coinbase1, item.extranonce1, item.extranonce2_length, item.coinbase2
          );
        } catch (e) {
          console.warn(`Error parsing coinbase for ${poolName} in chart:`, e);
          // Ensure a consistent state if parsing fails
          currentScriptSigInfo = null;
          currentTxDetails = null;
          currentCoinbaseOutputs = [];
          currentCoinbaseOutputValue = undefined;
          currentAsciiTag = null;
        }
      }
      
      // For debugging:
      // console.log(`[${poolName}] Current Raw CB: ${currentCoinbaseRaw}`);
      // if(currentScriptSigInfo) console.log(`[${poolName}] Current ScriptSig:`, currentScriptSigInfo);
      // if(currentTxDetails) console.log(`[${poolName}] Current TxDetails:`, currentTxDetails);
      // if(currentCoinbaseOutputs.length > 0) console.log(`[${poolName}] Current Outputs:`, currentCoinbaseOutputs);
      // console.log(`[${poolName}] Current Output Value: ${currentCoinbaseOutputValue}`);
      // console.log(`[${poolName}] Current ASCII Tag: ${currentAsciiTag}`);

      let currentChangeType: ChangeCategory = 'no_significant_change';
      let processedPointAdditions: Partial<ChartDataPoint> = {};

      if (lastKnownPoolState) {
        const prevState = lastKnownPoolState;
        let opReturnChangeDetected = false;

        // --- Start Debugging Logs ---
        console.log(`[${poolName}] --- Change Detection Cycle ---`);
        console.log(`[${poolName}] Prev State Exists:`, !!prevState);
        // To prevent overly verbose logs, selectively log parts of prev state if needed
        // console.log(`[${poolName}] Prev ScriptSig Height:`, prevState.scriptSigInfo?.height);
        // console.log(`[${poolName}] Prev RSK OP_RETURNs:`, prevState.coinbaseOutputs.filter(isRskOpReturnOutput).map(o => o.decodedData?.dataHex));
        
        console.log(`[${poolName}] Current Merkle Branches:`, item.merkle_branches);
        console.log(`[${poolName}] Prev Merkle Branches:`, prevState.stratumData.merkle_branches);
        console.log(`[${poolName}] Current Output Value: ${currentCoinbaseOutputValue}`);
        console.log(`[${poolName}] Prev Output Value: ${prevState.coinbaseOutputValue}`);
        console.log(`[${poolName}] Current ScriptSigInfo:`, currentScriptSigInfo);
        console.log(`[${poolName}] Prev ScriptSigInfo:`, prevState.scriptSigInfo);
        console.log(`[${poolName}] Current TxDetails:`, currentTxDetails);
        console.log(`[${poolName}] Prev TxDetails:`, prevState.txDetails);
        console.log(`[${poolName}] Current Coinbase Outputs Count:`, currentCoinbaseOutputs.length);
        console.log(`[${poolName}] Prev Coinbase Outputs Count:`, prevState.coinbaseOutputs.length);
        // --- End Debugging Logs ---

        // Helper to get OP_RETURNs by protocol
        const getOpReturnsByProtocol = (outputs: CoinbaseOutput[]) => {
          const map = new Map<string, string[]>();
          outputs.filter(o => o.type === 'nulldata' && o.decodedData).forEach(o => {
            const protocol = o.decodedData!.protocol || 'Unknown';
            const dataHex = o.decodedData!.dataHex || '';
            if (!map.has(protocol)) map.set(protocol, []);
            map.get(protocol)!.push(dataHex);
            map.get(protocol)!.sort(); // Sort for consistent comparison
          });
          return map;
        };

        const currentOpReturnsMap = getOpReturnsByProtocol(currentCoinbaseOutputs);
        const prevOpReturnsMap = getOpReturnsByProtocol(prevState.coinbaseOutputs);

        // 1. RSK OP_RETURN data change
        const currentRskHex = (currentOpReturnsMap.get('RSK') || []).join(',');
        const prevRskHex = (prevOpReturnsMap.get('RSK') || []).join(',');
        if (currentRskHex !== prevRskHex) {
          currentChangeType = 'op_return_rsk_changed';
          opReturnChangeDetected = true;
        }

        // 2. CoreDAO OP_RETURN data change
        if (!opReturnChangeDetected) {
          const currentCoreDaoHex = (currentOpReturnsMap.get('CoreDAO') || []).join(',');
          const prevCoreDaoHex = (prevOpReturnsMap.get('CoreDAO') || []).join(',');
          if (currentCoreDaoHex !== prevCoreDaoHex) {
            currentChangeType = 'op_return_coredao_changed';
            opReturnChangeDetected = true;
          }
        }

        // 3. Other Known Protocol OP_RETURN data change
        if (!opReturnChangeDetected) {
          const allProtocols = new Set([...currentOpReturnsMap.keys(), ...prevOpReturnsMap.keys()]);
          for (const protocol of allProtocols) {
            if (protocol === 'RSK' || protocol === 'CoreDAO' || protocol === 'Unknown') continue;
            const currentProtoHex = (currentOpReturnsMap.get(protocol) || []).join(',');
            const prevProtoHex = (prevOpReturnsMap.get(protocol) || []).join(',');
            if (currentProtoHex !== prevProtoHex) {
              currentChangeType = 'op_return_other_known_protocol_changed';
              processedPointAdditions.changedOpReturnProtocol = protocol; 
              opReturnChangeDetected = true;
              break;
            }
          }
        }
        
        // 4. Unknown Protocol OP_RETURN data change
        if (!opReturnChangeDetected) {
          const currentUnknownHex = (currentOpReturnsMap.get('Unknown') || []).join(',');
          const prevUnknownHex = (prevOpReturnsMap.get('Unknown') || []).join(',');
          if (currentUnknownHex !== prevUnknownHex) {
            currentChangeType = 'op_return_unknown_protocol_changed';
            opReturnChangeDetected = true;
          }
        }

        // 5. OP_RETURN Structure Change (if no specific data change detected yet for OP_RETURNs)
        // This checks if the set of protocols or number of OP_RETURNs per protocol changed.
        if (!opReturnChangeDetected) {
            const currentProtocolsSorted = Array.from(currentOpReturnsMap.keys()).sort().join(',');
            const prevProtocolsSorted = Array.from(prevOpReturnsMap.keys()).sort().join(',');
            let structureChanged = currentProtocolsSorted !== prevProtocolsSorted;
            if (!structureChanged) { // If protocols are same, check counts/scripts of non-data parts
                 // Simplified: check if raw coinbaseoutput hex for nulldata changed if protocols are same but datahex matched above
                 const currentOpScripts = currentCoinbaseOutputs.filter(o => o.type === 'nulldata').map(o=>o.hex).sort().join(',');
                 const prevOpScripts = prevState.coinbaseOutputs.filter(o => o.type === 'nulldata').map(o=>o.hex).sort().join(',');
                 if(currentOpScripts !== prevOpScripts) {
                    // This implies a change in OP_RETURN script itself, not just decoded data if data was same.
                    // Or an OP_RETURN was added/removed that didn't fall into other categories.
                    structureChanged = true;
                 }
            }
            if (structureChanged) {
                currentChangeType = 'op_return_structure_changed';
                opReturnChangeDetected = true;
            }
        }

        // Chain other checks only if no OP_RETURN change was detected
        if (!opReturnChangeDetected) {
            // 3. AuxPoW Change (original numbering, now after OP_RETURN checks)
            if (JSON.stringify(currentScriptSigInfo?.auxPowData) !== JSON.stringify(prevState.scriptSigInfo?.auxPowData)) {
                currentChangeType = 'auxpow_changed';
            }
            // 4. Coinbase Script Tag Change 
            else if (currentAsciiTag !== prevState.coinbaseAsciiTag) {
                 currentChangeType = 'coinbase_script_tag_changed';
            }
            // 5. Coinbase Height Change
            else if (currentScriptSigInfo?.height !== prevState.scriptSigInfo?.height) {
                currentChangeType = 'coinbase_height_changed';
            }
            // 6. Witness Commitment Change
            else if (currentTxDetails?.witnessCommitmentNonce !== prevState.txDetails?.witnessCommitmentNonce) {
                currentChangeType = 'witness_commitment_changed';
            }
            // 7. Merkle/Transaction Update
            else {
                const merkleChanged = JSON.stringify(item.merkle_branches) !== JSON.stringify(prevState.stratumData.merkle_branches);
                const outputValueChanged = currentCoinbaseOutputValue !== prevState.coinbaseOutputValue;
                const scriptSigStable = JSON.stringify(currentScriptSigInfo) === JSON.stringify(prevState.scriptSigInfo);
                const txDetailsStable = currentTxDetails?.txVersion === prevState.txDetails?.txVersion &&
                                      currentTxDetails?.inputSequence === prevState.txDetails?.inputSequence &&
                                      currentTxDetails?.txLocktime === prevState.txDetails?.txLocktime;
                // For merkle_tx_update, we expect OP_RETURNs to be stable (or changes already caught)
                // So, we only check if the *non-data* parts of OP_RETURN scripts are stable if any exist.
                const opReturnScriptsStable = currentCoinbaseOutputs
                    .filter(o => o.type === 'nulldata')
                    .map(o => o.hex) // compare raw script hex for nulldata outputs
                    .sort().join(',') === prevState.coinbaseOutputs
                    .filter(o => o.type === 'nulldata')
                    .map(o => o.hex)
                    .sort().join(',');
                
                const otherOutputScriptsStable = 
                    currentCoinbaseOutputs.filter(o => o.type !== 'nulldata').length === prevState.coinbaseOutputs.filter(o => o.type !== 'nulldata').length &&
                    currentCoinbaseOutputs.filter(o => o.type !== 'nulldata').every((out, i) => {
                        const prevOut = prevState.coinbaseOutputs.filter(p => p.type !== 'nulldata')[i];
                        return prevOut && out.type === prevOut.type && 
                               (out.type === 'address' ? out.address === prevOut.address : true) && 
                               out.hex === prevOut.hex;
                    });

                if (merkleChanged && outputValueChanged && scriptSigStable && txDetailsStable && opReturnScriptsStable && otherOutputScriptsStable) {
                    currentChangeType = 'merkle_tx_update';
                }
                // 8. Coinbase Outputs Structure Change (general, if not merkle_tx_update)
                else if (JSON.stringify(currentCoinbaseOutputs.map(o => ({ type: o.type, script: o.hex, value: o.value })).sort((a,b) => (a.script||'').localeCompare(b.script||''))) !== 
                         JSON.stringify(prevState.coinbaseOutputs.map(o => ({ type: o.type, script: o.hex, value: o.value })).sort((a,b) => (a.script||'').localeCompare(b.script||'')))) {
                    currentChangeType = 'coinbase_outputs_structure_changed';
                }
                // 9. Coinbase Fixed Fields Change
                else if (currentTxDetails?.txVersion !== prevState.txDetails?.txVersion ||
                    currentTxDetails?.inputSequence !== prevState.txDetails?.inputSequence ||
                    currentTxDetails?.txLocktime !== prevState.txDetails?.txLocktime) {
                    currentChangeType = 'coinbase_fixed_fields_changed';
                }
                // 10. Stratum Header Fields Change
                else {
                    const stratumFields: (keyof StratumV1Data)[] = ['version', 'prev_hash', 'nbits', 'ntime'];
                    for (const key of stratumFields) {
                        if (item[key] !== prevState.stratumData[key]) {
                            currentChangeType = 'stratum_header_fields_changed';
                            break;
                        }
                    }
                    // 11. Clean Jobs Change (lowest priority if nothing else changed)
                    if (currentChangeType === 'no_significant_change' && item.clean_jobs !== prevState.stratumData.clean_jobs) {
                        currentChangeType = 'clean_jobs_changed';
                    }
                }
            }
        }
      }
      
      console.log(`[${poolName}] Final ChangeType: ${currentChangeType}`, processedPointAdditions.changedOpReturnProtocol ? `(${processedPointAdditions.changedOpReturnProtocol})` : '');

      const timestamp = parseTimestamp(item.timestamp);
      const poolIndex = poolRankings.get(poolName) || (currentPoolNames.indexOf(poolName) + 1) || 1;

      // Data to be returned for the point, poolIndex will be added after state update
      const pointDataShell = {
        timestamp,
        poolName,
        poolIndex,
        height: item.height,
        version: item.version,
        clean_jobs: item.clean_jobs,
        prev_hash: item.prev_hash,
        nbits: item.nbits,
        ntime: item.ntime,
        changeType: currentChangeType,
        ...processedPointAdditions // Spread additional properties like changedOpReturnProtocol
      };

      // Update last known state for this pool
      const newPoolState: PoolState = {
        stratumData: item,
        coinbaseRaw: currentCoinbaseRaw,
        coinbaseOutputs: currentCoinbaseOutputs,
        scriptSigInfo: currentScriptSigInfo,
        txDetails: currentTxDetails,
        coinbaseOutputValue: currentCoinbaseOutputValue,
        coinbaseAsciiTag: currentAsciiTag
      };

      // Update min/max for domain calculation
      minTimestamp = Math.min(minTimestamp, timestamp);
      maxTimestamp = Math.max(maxTimestamp, timestamp);
      
      // Use current rankings or default to an evenly distributed value
      // const poolIndex = poolRankings.get(poolName) || 
      //   (currentPoolNames.indexOf(poolName) + 1) || 1;
      
      return {
        ...pointDataShell,
        poolIndex // Now correctly defined in scope
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
    lastPoolStatesRef.current.clear();
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
          {hoveredPoint.changeType && hoveredPoint.changeType !== 'no_significant_change' && (
            <>
              <br />
              <span style={{ color: hoveredPoint.changeType === 'op_return_rsk_changed' ? 'lime' : 
                                   hoveredPoint.changeType === 'op_return_coredao_changed' ? '#00E5FF' :
                                   hoveredPoint.changeType === 'op_return_other_known_protocol_changed' ? '#FFD740' :
                                   hoveredPoint.changeType === 'op_return_unknown_protocol_changed' ? '#BDBDBD' :
                                   hoveredPoint.changeType === 'op_return_structure_changed' ? '#FF80AB' :
                                   hoveredPoint.changeType === 'auxpow_changed' ? '#E91E63' :
                                   hoveredPoint.changeType === 'coinbase_script_tag_changed' ? '#9C27B0' :
                                   hoveredPoint.changeType === 'coinbase_height_changed' ? '#009688' :
                                   hoveredPoint.changeType === 'witness_commitment_changed' ? '#FF9800' :
                                   hoveredPoint.changeType === 'merkle_tx_update' ? '#FFC107' :
                                   hoveredPoint.changeType === 'coinbase_outputs_structure_changed' ? '#F48FB1' :
                                   hoveredPoint.changeType === 'coinbase_fixed_fields_changed' ? '#2196F3' :
                                   hoveredPoint.changeType === 'stratum_header_fields_changed' ? '#f44336' :
                                   hoveredPoint.changeType === 'clean_jobs_changed' ? '#9E9E9E' : 'yellow' // Default fallback
                                 }}>
                Change: {
                  hoveredPoint.changeType === 'op_return_other_known_protocol_changed' && hoveredPoint.changedOpReturnProtocol 
                    ? `OP_RETURN ${hoveredPoint.changedOpReturnProtocol} Data`
                    : hoveredPoint.changeType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                }
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Wrap with React.memo to prevent unnecessary re-renders
const RealtimeChart = React.memo(RealtimeChartBase);

export default RealtimeChart; 