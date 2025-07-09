"use client";

import React, { useState, useEffect, useRef, useCallback, useTransition, useMemo } from "react";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType, StratumV1Data } from "@/lib/types";
import { useHistoricalData } from "@/lib/HistoricalDataContext";
import { CHART_POINT_SIZES } from "@/lib/constants";
import { 
  detectTemplateChanges, 
  getChangeTypeDisplay,
  TemplateChangeResult,
  clearTemplateCache
} from "@/utils/templateChangeDetection";
import { getFormattedCoinbaseAsciiTag } from "@/utils/bitcoinUtils";

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

// Convert HSL color to RGB format for better canvas compatibility
const hslToRgb = (hslString: string): string => {
  // Parse HSL string like "hsl(120, 70%, 50%)"
  const match = hslString.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (!match) return hslString; // Return original if not HSL format
  
  const h = parseInt(match[1]) / 360;
  const s = parseInt(match[2]) / 100;
  const l = parseInt(match[3]) / 100;
  
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hue2rgb(p, q, h + 1/3) * 255);
  const g = Math.round(hue2rgb(p, q, h) * 255);
  const b = Math.round(hue2rgb(p, q, h - 1/3) * 255);
  
  return `rgb(${r}, ${g}, ${b})`;
};

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

// Determine if a color is light or dark to choose appropriate text color
const getContrastingTextColor = (backgroundColor: string): string => {
  // Parse HSL color (format: "hsl(h, s%, l%)")
  const hslMatch = backgroundColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
  if (hslMatch) {
    const hue = parseInt(hslMatch[1], 10);
    
    // Since all colors have 50% lightness, determine based on hue
    // Yellow/lime/cyan hues (45-195 degrees) appear brighter, use black text
    // Red/magenta/blue hues appear darker, use white text
    if (hue >= 45 && hue <= 195) {
      return '#000000';
    } else {
      return '#ffffff';
    }
  }
  
  // Fallback for other color formats - use white as default
  return '#ffffff';
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
  changeInfo?: TemplateChangeResult;
  changeDisplay?: string;
  asciiTag?: string;
  // Fields needed for asciiTag calculation
  coinbase1?: string;
  coinbase2?: string;
  extranonce1?: string;
  extranonce2_length?: number;
  [key: string]: unknown;
}


interface RealtimeChartProps {
  paused?: boolean;
  filterBlockHeight?: number;
  timeWindow?: number; // Time window in seconds
  pointSize?: number; // Size of data points in pixels
  hideHeader?: boolean; // Hide the title and options
  showLabels?: boolean; // Show labels for data points
  showPoolNames?: boolean; // Show static pool names column on the right
  sortByTimeReceived?: boolean; // External sorting control (overrides internal state when provided)
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
  pointSize,
  hideHeader = false,
  showLabels: propShowLabels,
  showPoolNames = false,
  sortByTimeReceived: propSortByTimeReceived
}: RealtimeChartProps) {
  // Get data from the global data stream
  const { filteredData } = useGlobalDataStream();
  
  // Get historical data from context
  const { historicalData, isHistoricalDataLoaded } = useHistoricalData();
  
  // Check if we're in historical mode (viewing a specific historical block)
  const isHistoricalBlock = filterBlockHeight !== undefined && filterBlockHeight !== -1;
  
  // Add useTransition for non-urgent UI updates
  const [, startTransition] = useTransition();
  
  // Local state for time window to enable changing it
  const [localTimeWindow, setLocalTimeWindow] = useState(timeWindow);
  
  // State for visualization options
  const [localShowLabels, setLocalShowLabels] = useState(false); // Off by default
  const [localSortByTimeReceived, setLocalSortByTimeReceived] = useState(true); // True = time received descending by default
  
  // Use prop if provided, otherwise use local state
  const showLabels = propShowLabels !== undefined ? propShowLabels : localShowLabels;
  const sortByTimeReceived = propSortByTimeReceived !== undefined ? propSortByTimeReceived : localSortByTimeReceived;
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
  
  // Define point size based on mode and props with dynamic sizing
  const basePointSize = useMemo(() => {
    if (pointSize) {
      // Use provided pointSize if specified
      return pointSize;
    }
    
    // Get the number of pools for dynamic calculation
    const poolCount = Math.max(allPoolNames.length, maxPoolCount, 5);
    const availableHeight = dimensions.height - 60; // Account for margins (top: 30, bottom: 20, extra padding)
    
    // Calculate maximum point size that prevents overlap
    // Each pool should have at least enough space for a circle plus some padding
    const maxPointSize = Math.floor(availableHeight / poolCount / 3.5); // Divide by 3.5 for balanced spacing between circles
    
    // Set reasonable bounds: minimum 2px, maximum 12px
    const dynamicSize = Math.max(2, Math.min(12, maxPointSize));
    
    return isHistoricalBlock 
      ? Math.min(dynamicSize, CHART_POINT_SIZES.HISTORICAL) 
      : dynamicSize;
  }, [pointSize, allPoolNames.length, maxPoolCount, dimensions.height, isHistoricalBlock]);
  const poolDataHistoryRef = useRef<Map<string, ChartDataPoint[]>>(new Map());
  const timeDomainRef = useRef<[number, number]>([0, 0]);
  const localTimeWindowRef = useRef<number>(timeWindow);
  const dimensionsRef = useRef(dimensions);
  
  // Track if we've already loaded historical data for a given block height
  const [, setHistoricalDataLoaded] = useState(false);
  const currentBlockHeightRef = useRef<number | undefined>(filterBlockHeight);
  
  // Function to sort pool names based on current sorting mode
  const sortPoolNames = useCallback((poolNames: string[], chartData: ChartDataPoint[]) => {
    if (!sortByTimeReceived) {
      // Alphabetical sorting
      return [...poolNames].sort();
    } else {
      // Time received descending - get the latest timestamp for each pool
      const poolLatestTimestamps = new Map<string, number>();
      
      chartData.forEach(point => {
        const currentLatest = poolLatestTimestamps.get(point.poolName) || 0;
        if (point.timestamp > currentLatest) {
          poolLatestTimestamps.set(point.poolName, point.timestamp);
        }
      });
      
      // Sort by latest timestamp descending, then alphabetically for ties
      return [...poolNames].sort((a, b) => {
        const aTime = poolLatestTimestamps.get(a) || 0;
        const bTime = poolLatestTimestamps.get(b) || 0;
        
        if (aTime !== bTime) {
          return bTime - aTime; // Descending order (newest first)
        }
        
        // If timestamps are equal, sort alphabetically
        return a.localeCompare(b);
      });
    }
  }, [sortByTimeReceived]);
  
  
  // Reset the historical data loaded flag when the block height changes
  useEffect(() => {
    if (currentBlockHeightRef.current !== filterBlockHeight) {
      setHistoricalDataLoaded(false);
      currentBlockHeightRef.current = filterBlockHeight;
      
      // Clear existing data when switching between blocks
      poolDataHistoryRef.current.clear();
      setChartData([]);
      
      // Clear template change detection cache to prevent stale comparisons
      clearTemplateCache();
      
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
    // Add extra right margin for pool names if enabled
    const poolNamesWidth = showPoolNames ? 180 : 0;
    const margin = { top: 30, right: 20 + poolNamesWidth, bottom: 20, left: 20 };
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
    const basePoolNames = allPoolNames.length > 0 
      ? allPoolNames 
      : Array.from(groupedData.keys());
    
    // Apply sorting based on current sorting mode
    const stablePoolNames = sortPoolNames(basePoolNames, chartData);
    
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
        
        // Check if we should draw a change indicator or regular point
        // Draw larger circles for any detected changes, even if untracked (empty changeDisplay)
        const hasChangeInfo = point.changeInfo && point.changeInfo.hasChanges;
        
        // Calculate size for both cases
        const size = isHovered ? basePointSize * CHART_POINT_SIZES.HOVER_MULTIPLIER : basePointSize;
        
        if (hasChangeInfo) {
          // Draw change indicator letter(s) in fixed-size circle
          const text = point.changeDisplay || '';
          const circleRadius = size * 1.8; // Balanced circle size for readability
          
          // Use contrasting text color based on background
          const textColor = getContrastingTextColor(color);
          
          // Draw colored background circle
          // Convert HSL to RGB since canvas might not support HSL properly
          const rgbColor = hslToRgb(color);
          ctx.beginPath();
          ctx.arc(x, y, circleRadius, 0, Math.PI * 2);
          ctx.fillStyle = rgbColor;
          ctx.fill();
          
          // Draw subtle border
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
          ctx.lineWidth = 1;
          ctx.stroke();
          
          // Auto-adjust font size to fit text in circle - start with larger font
          let fontSize = Math.max(10, basePointSize + 2); // Start with larger font size
          ctx.font = `${fontSize}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          
          // Measure text and scale down font if needed
          let textMetrics = ctx.measureText(text);
          const maxTextWidth = circleRadius * 1.4; // Leave some padding (diameter * 0.7)
          
          // Scale down font size if text is too wide, but don't go below 8px
          while (textMetrics.width > maxTextWidth && fontSize > 8) {
            fontSize--;
            ctx.font = `${fontSize}px monospace`;
            textMetrics = ctx.measureText(text);
          }
          
          // Draw text with appropriate color
          ctx.fillStyle = textColor;
          ctx.fillText(text, x, y);
          
        } else {
          // Draw regular circle point
          const rgbColor = hslToRgb(color);
          ctx.beginPath();
          ctx.arc(x, y, size, 0, Math.PI * 2);
          ctx.fillStyle = rgbColor;
          ctx.fill();
          
          // Add a subtle outline for better visibility against dark backgrounds
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
          ctx.stroke();
          ctx.strokeStyle = color; // Reset stroke style
        }
        
        // Draw label if showLabels is true
        if (showLabels) {
          ctx.fillStyle = color;
          ctx.font = '9px sans-serif';
          ctx.textAlign = 'left';
          // Position label to the right of the circle, accounting for circle size
          const labelOffset = hasChangeInfo ? size * 1.8 + 4 : size + 4;
          ctx.fillText(poolName, x + labelOffset, y + 3);
          ctx.fillStyle = color; // Reset fill style for next point
        }
        
        // Highlight if this is the exact hovered point
        if (hoveredPoint && point.timestamp === hoveredPoint.timestamp && point.poolName === hoveredPoint.poolName) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
          
          if (hasChangeInfo) {
            // For change indicators, use fixed circle size
            const highlightRadius = size * 1.8 + 3; // Same as change indicator circle + highlight border
            ctx.beginPath();
            ctx.arc(x, y, highlightRadius, 0, Math.PI * 2);
            ctx.stroke();
          } else {
            // For regular points
            const highlightRadius = size + 3;
            ctx.beginPath();
            ctx.arc(x, y, highlightRadius, 0, Math.PI * 2);
            ctx.stroke();
          }
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
    
    // Draw pool names on the right side if enabled
    if (showPoolNames && stablePoolNames.length > 0) {
      // Draw vertical separator line
      const separatorX = dimensions.width - poolNamesWidth;
      ctx.strokeStyle = 'rgba(150, 150, 150, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(separatorX, margin.top);
      ctx.lineTo(separatorX, dimensions.height - margin.bottom);
      ctx.stroke();
      
      // Calculate row height for horizontal separators
      const denominator = Math.max(stablePoolNames.length, maxPoolCount, 10);
      const rowHeight = availableHeight / denominator;
      
      // Draw horizontal row separator lines between pools
      ctx.strokeStyle = 'rgba(150, 150, 150, 0.2)'; // Slightly more visible for row separation
      ctx.lineWidth = 1;
      for (let i = 1; i < stablePoolNames.length; i++) {
        // Position line at the boundary between rows (halfway between pool centers)
        const y = margin.top + (i * rowHeight) - (rowHeight / 2);
        ctx.beginPath();
        // Draw separator line only in the chart area (not extending into pool names section)
        ctx.moveTo(margin.left, y);
        ctx.lineTo(separatorX, y);
        ctx.stroke();
      }
      
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      
      const poolNamesX = separatorX + 10; // 10px padding from the separator line
      
      // Set font size proportional to row height (about 40% of row height, with min/max bounds)
      const fontSize = Math.max(10, Math.min(18, Math.floor(rowHeight * 0.4)));
      ctx.font = `${fontSize}px monospace`;
      
      stablePoolNames.forEach((poolName, index) => {
        const y = poolIndexToPixel(index, poolName);
        const color = poolColors[poolName] || stringToColor(poolName);
        const rgbColor = hslToRgb(color);
        
        // Calculate background width extending to right edge with padding
        const rightPadding = 10;
        const backgroundWidth = dimensions.width - (poolNamesX - 2) - rightPadding;
        
        // Draw colored background rectangle extending full row height and to right edge
        ctx.fillStyle = rgbColor;
        ctx.fillRect(poolNamesX - 2, y - rowHeight/2, backgroundWidth, rowHeight);
        
        // Draw pool name with contrasting text color and left padding
        const textColor = getContrastingTextColor(color);
        const textPadding = 8; // Left padding for the text
        const maxTextWidth = backgroundWidth - textPadding - 10; // Reserve space for padding and right margin
        
        // Get ASCII tag for this pool (from latest data point)
        const poolDataPoints = chartData.filter(point => point.poolName === poolName);
        const latestPoint = poolDataPoints.sort((a, b) => b.timestamp - a.timestamp)[0];
        const asciiTag = latestPoint?.asciiTag || '';
        
        // Draw pool name
        let poolNameText = poolName;
        const poolNameWidth = ctx.measureText(poolNameText).width;
        
        if (poolNameWidth > maxTextWidth) {
          // Binary search to find the longest pool name that fits with ellipsis
          let start = 0;
          let end = poolName.length;
          
          while (start < end) {
            const mid = Math.floor((start + end + 1) / 2);
            const testText = poolName.substring(0, mid) + '...';
            const testWidth = ctx.measureText(testText).width;
            
            if (testWidth <= maxTextWidth) {
              start = mid;
            } else {
              end = mid - 1;
            }
          }
          
          poolNameText = poolName.substring(0, start) + '...';
        }
        
        // Calculate positions for pool name and ASCII tag
        const poolNameY = y - (asciiTag ? rowHeight * 0.15 : 0); // Move up slightly if ASCII tag exists
        const asciiTagY = y + rowHeight * 0.25; // Position ASCII tag below pool name
        
        // Draw pool name
        ctx.fillStyle = textColor;
        ctx.fillText(poolNameText, poolNamesX + textPadding, poolNameY);
        
        // Draw ASCII tag on new line if it exists
        if (asciiTag) {
          // Use smaller font for ASCII tag
          const originalFont = ctx.font;
          const smallerFontSize = Math.max(8, Math.floor(fontSize * 0.75));
          ctx.font = `${smallerFontSize}px monospace`;
          
          // Truncate ASCII tag if too long
          let asciiDisplayText = asciiTag;
          const asciiTextWidth = ctx.measureText(asciiDisplayText).width;
          
          if (asciiTextWidth > maxTextWidth) {
            // Binary search to find the longest ASCII tag that fits with ellipsis
            let start = 0;
            let end = asciiTag.length;
            
            while (start < end) {
              const mid = Math.floor((start + end + 1) / 2);
              const testText = asciiTag.substring(0, mid) + '...';
              const testWidth = ctx.measureText(testText).width;
              
              if (testWidth <= maxTextWidth) {
                start = mid;
              } else {
                end = mid - 1;
              }
            }
            
            asciiDisplayText = asciiTag.substring(0, start) + '...';
          }
          
          // Draw ASCII tag with slightly dimmed color
          const dimmedTextColor = textColor === '#000000' ? '#666666' : '#cccccc';
          ctx.fillStyle = dimmedTextColor;
          ctx.fillText(asciiDisplayText, poolNamesX + textPadding, asciiTagY);
          
          // Restore original font
          ctx.font = originalFont;
        }
      });
    }
    
  }, [dimensions, chartData, hoveredPoint, showLabels, poolColors, maxPoolCount, isHistoricalBlock, isHistoricalDataLoaded, basePointSize, allPoolNames, showPoolNames, sortPoolNames]);

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
    } catch {
      return Date.now(); // Fallback to current time
    }
  }, [isHistoricalBlock]);
  
  // Direct approach: Create data points from historical data when component is paused
  useEffect(() => {
    if (isHistoricalBlock && historicalData.length > 0) {
      // Create a map of pool names to indices for consistent y-axis positioning
      const basePoolNames = Array.from(new Set(historicalData.map(item => item.pool_name || 'unknown')));
      // For historical data, we'll temporarily use all points for sorting calculation
      const tempPoints = historicalData.map(item => ({
        poolName: item.pool_name || 'unknown',
        timestamp: typeof item.timestamp === 'string' && item.timestamp.startsWith('0x') 
          ? parseInt(item.timestamp.replace(/^0x/, ''), 16) / 1000000
          : parseTimestamp(item.timestamp || 0)
      }));
      const poolNames = sortPoolNames(basePoolNames, tempPoints as ChartDataPoint[]);
      
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
          
          // Get ASCII tag for historical data
          const asciiTag = record.coinbase1 && record.extranonce1 && record.extranonce2_length !== undefined && record.coinbase2
            ? getFormattedCoinbaseAsciiTag(
                record.coinbase1,
                record.extranonce1,
                record.extranonce2_length,
                record.coinbase2
              )
            : '';

          points.push({
            timestamp,
            poolName,
            poolIndex,
            height: record.height || 0,
            // Include other fields for display
            version: record.version,
            prev_hash: record.prev_hash,
            nbits: record.nbits,
            ntime: record.ntime,
            asciiTag,
            // Fields needed for asciiTag calculation
            coinbase1: record.coinbase1,
            coinbase2: record.coinbase2,
            extranonce1: record.extranonce1,
            extranonce2_length: record.extranonce2_length,
            clean_jobs: record.clean_jobs,
          });
        } catch {
          // Skip failed records silently
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
  }, [isHistoricalBlock, historicalData, parseTimestamp, sortPoolNames]);
  
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
    const poolNamesWidth = showPoolNames ? 180 : 0;
    const margin = { top: 30, right: 20 + poolNamesWidth, bottom: 20, left: 20 };
    const availableWidth = dimensions.width - margin.left - margin.right;
    const availableHeight = dimensions.height - margin.top - margin.bottom;
    
    // Use allPoolNames for stable vertical positioning (same as in drawChart)
    const currentPoolNames = Array.from(new Set(chartData.map(point => point.poolName)));
    const basePoolNames = allPoolNames.length > 0 
      ? allPoolNames 
      : currentPoolNames;
    
    // Apply sorting based on current sorting mode
    const stablePoolNames = sortPoolNames(basePoolNames, chartData);
    
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
  }, [chartData, dimensions, maxPoolCount, allPoolNames, basePointSize, showPoolNames, sortPoolNames]);
  
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
    const currentPoolNames = Array.from(poolNames);
    
    // Create temporary data points for sorting calculation
    const tempDataForSorting = filteredData.map(item => ({
      poolName: item.pool_name || 'Unknown',
      timestamp: parseTimestamp(item.timestamp)
    }));
    
    // Apply sorting to current pool names
    const sortedCurrentPoolNames = sortPoolNames(currentPoolNames, tempDataForSorting as ChartDataPoint[]);
    
    // Update the allPoolNames state to include any new pools
    if (!isHistoricalBlock) {
      const newPools = sortedCurrentPoolNames.filter(name => !allPoolNames.includes(name));
      if (newPools.length > 0) {
        const updatedPoolNames = [...allPoolNames, ...newPools];
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
      setAllPoolNames(sortedCurrentPoolNames);
      
      // Update rankings, colors for historical view
      const rankings = new Map<string, number>();
      const colors: PoolColorsMap = {};
      
      sortedCurrentPoolNames.forEach((name, idx) => {
        rankings.set(name, idx + 1);
        colors[name] = stringToColor(name);
      });
      
      setPoolRankings(rankings);
      setPoolColors(colors);
      setMaxPoolCount(Math.max(maxPoolCount, sortedCurrentPoolNames.length));
    }
    
    // Return pool info
    const poolInfo = {
      poolNames: sortedCurrentPoolNames,
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
        (sortedCurrentPoolNames.indexOf(poolName) + 1) || 1;
      
      // Detect template changes using the new simplified interface
      const changeInfo = detectTemplateChanges(item);
      const changeDisplay = getChangeTypeDisplay(changeInfo.changeTypes);
      
      // Get ASCII tag from coinbase script sig
      const asciiTag = getFormattedCoinbaseAsciiTag(
        item.coinbase1,
        item.extranonce1,
        item.extranonce2_length,
        item.coinbase2
      );
      
      return {
        timestamp,
        poolName,
        poolIndex,
        height: item.height,
        version: item.version,
        clean_jobs: item.clean_jobs,
        prev_hash: item.prev_hash,
        nbits: item.nbits,
        ntime: item.ntime,
        changeInfo,
        changeDisplay,
        asciiTag,
        // Fields needed for asciiTag calculation
        coinbase1: item.coinbase1,
        coinbase2: item.coinbase2,
        extranonce1: item.extranonce1,
        extranonce2_length: item.extranonce2_length
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
        
        // Create a more robust unique key to prevent infinite loops
        const pointKey = `${point.poolName}-${point.timestamp}-${point.changeDisplay}`;
        
        // Check if we already have this exact point
        const isDuplicate = history.some(existing => {
          const existingKey = `${existing.poolName}-${existing.timestamp}-${existing.changeDisplay}`;
          return existingKey === pointKey;
        });
        
        if (!isDuplicate) {
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
  }, [filterBlockHeight, parseTimestamp, pruneOldData, isHistoricalBlock, allPoolNames, maxPoolCount, poolColors, poolRankings, sortPoolNames]);
  
  // Reset pool data history when block height changes
  useEffect(() => {
    poolDataHistoryRef.current.clear();
    setChartData([]);
    // Clear template change detection cache to prevent stale comparisons
    clearTemplateCache();
  }, [filterBlockHeight]);
  
  // Track seen pools to detect filter changes
  const seenPoolsRef = useRef<Set<string>>(new Set());

  // Clear chart internal state when pool filtering changes
  useEffect(() => {
    if (isHistoricalBlock) return; // Skip for historical data
    
    const currentPoolsFromData = new Set<string>();
    const stratumUpdates = filteredData.filter(item => item.type === StreamDataType.STRATUM_V1);
    stratumUpdates.forEach(item => {
      const stratumData = item.data as StratumV1Data;
      if (stratumData.pool_name) {
        currentPoolsFromData.add(stratumData.pool_name);
      }
    });
    
    const previousPools = seenPoolsRef.current;
    const removedPools = Array.from(previousPools).filter(pool => !currentPoolsFromData.has(pool));
    
    if (removedPools.length > 0) {
      // Clear internal state to remove filtered pools
      setChartData([]);
      poolDataHistoryRef.current.clear();
      
      // Remove filtered pools from pool tracking
      const updatedPoolNames = allPoolNames.filter(pool => !removedPools.includes(pool));
      setAllPoolNames(updatedPoolNames);
      
      // Update pool colors and rankings
      const updatedColors: PoolColorsMap = {};
      const updatedRankings = new Map<string, number>();
      
      updatedPoolNames.forEach((name, idx) => {
        updatedColors[name] = poolColors[name] || stringToColor(name);
        updatedRankings.set(name, idx + 1);
      });
      
      setPoolColors(updatedColors);
      setPoolRankings(updatedRankings);
    }
    
    // Update seen pools for next check
    seenPoolsRef.current = currentPoolsFromData;
  }, [filteredData, isHistoricalBlock, allPoolNames, poolColors]);

  // Fetch and update data from the global stream or historical data
  useEffect(() => {
    // Don't fetch if paused
    if (paused) {
      return;
    }
    
    // We'll handle historical data with the direct approach above
    // Only fetch real-time data in this effect
    if (!isHistoricalBlock) {
      // Create a throttled update function to limit the frequency of updates
      const throttledUpdate = createThrottle(() => {
        // Get stratum updates from the filtered stream
        const stratumUpdates = filteredData.filter(item => item.type === StreamDataType.STRATUM_V1);
        if (stratumUpdates.length === 0) {
          return;
        }
        
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
  }, [filteredData, paused, isHistoricalBlock, processData]);
  
  return (
    <div 
      className="w-full h-full relative" 
      onMouseLeave={handleCanvasMouseLeave}
    >
      {/* Chart header with title and options - only show for non-historical blocks */}
      {!isHistoricalBlock && !hideHeader && (
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
                      onClick={() => setLocalShowLabels(prev => !prev)}
                      className={`px-2 py-1 text-xs rounded ${
                        showLabels
                          ? 'bg-blue-500 text-white'
                          : 'bg-gray-200 dark:bg-gray-700'
                      }`}
                    >
                      {showLabels ? "On" : "Off"}
                    </button>
                  </div>
                  
                  {/* Pool sorting toggle - only show if not controlled externally */}
                  {propSortByTimeReceived === undefined && (
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">Sort pools:</span>
                      <button
                        onClick={() => setLocalSortByTimeReceived(prev => !prev)}
                        className={`px-2 py-1 text-xs rounded ${
                          sortByTimeReceived
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-200 dark:bg-gray-700'
                        }`}
                      >
                        {sortByTimeReceived ? "Time" : "A-Z"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      
      <div 
        ref={containerRef}
        className={`w-full ${isHistoricalBlock || hideHeader ? 'h-full' : 'h-[calc(100%-24px)]'}`}
        style={{ cursor: 'crosshair' }}
      >
        <canvas
          ref={canvasRef}
          className="w-full h-full bg-transparent"
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
          {hoveredPoint.changeInfo?.changeDetails && (
            <>
              <br />
              <div className="text-[8px] text-gray-300 mt-1 whitespace-nowrap">
                {hoveredPoint.changeInfo.changeDetails.auxPowHash && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">AuxPOW Old: {hoveredPoint.changeInfo.changeDetails.auxPowHash.old ? hoveredPoint.changeInfo.changeDetails.auxPowHash.old.substring(0, 16) + '...' : 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">AuxPOW New: {hoveredPoint.changeInfo.changeDetails.auxPowHash.new ? hoveredPoint.changeInfo.changeDetails.auxPowHash.new.substring(0, 16) + '...' : 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.merkleBranches && (
                  <div className="mb-1">
                    <div className="text-blue-300 whitespace-nowrap overflow-hidden">Merkle branches changed</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.cleanJobs && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">Clean Jobs Old: {String(hoveredPoint.changeInfo.changeDetails.cleanJobs.old)}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">Clean Jobs New: {String(hoveredPoint.changeInfo.changeDetails.cleanJobs.new)}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.prevHash != null && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">Prev Hash Old: {hoveredPoint.changeInfo.changeDetails.prevHash.old ? hoveredPoint.changeInfo.changeDetails.prevHash.old.substring(0, 16) + '...' : 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">Prev Hash New: {hoveredPoint.changeInfo.changeDetails.prevHash.new ? hoveredPoint.changeInfo.changeDetails.prevHash.new.substring(0, 16) + '...' : 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.height != null && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">Height Old: {hoveredPoint.changeInfo.changeDetails.height.old}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">Height New: {hoveredPoint.changeInfo.changeDetails.height.new}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.version && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">Version Old: {hoveredPoint.changeInfo.changeDetails.version.old || 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">Version New: {hoveredPoint.changeInfo.changeDetails.version.new || 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.nbits && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">nBits Old: {hoveredPoint.changeInfo.changeDetails.nbits.old || 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">nBits New: {hoveredPoint.changeInfo.changeDetails.nbits.new || 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.ntime && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">nTime Old: {hoveredPoint.changeInfo.changeDetails.ntime.old || 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">nTime New: {hoveredPoint.changeInfo.changeDetails.ntime.new || 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.extranonce2Length && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">Extranonce2 Length Old: {hoveredPoint.changeInfo.changeDetails.extranonce2Length.old}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">Extranonce2 Length New: {hoveredPoint.changeInfo.changeDetails.extranonce2Length.new}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.txVersion && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">TX Version Old: {hoveredPoint.changeInfo.changeDetails.txVersion.old ?? 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">TX Version New: {hoveredPoint.changeInfo.changeDetails.txVersion.new ?? 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.txLocktime && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">TX Locktime Old: {hoveredPoint.changeInfo.changeDetails.txLocktime.old ?? 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">TX Locktime New: {hoveredPoint.changeInfo.changeDetails.txLocktime.new ?? 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.inputSequence && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">Input Sequence Old: {hoveredPoint.changeInfo.changeDetails.inputSequence.old ?? 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">Input Sequence New: {hoveredPoint.changeInfo.changeDetails.inputSequence.new ?? 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.witnessNonce && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">Witness Nonce Old: {hoveredPoint.changeInfo.changeDetails.witnessNonce.old || 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">Witness Nonce New: {hoveredPoint.changeInfo.changeDetails.witnessNonce.new || 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.coinbaseAscii && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">Coinbase ASCII Old: {hoveredPoint.changeInfo.changeDetails.coinbaseAscii.old || 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">Coinbase ASCII New: {hoveredPoint.changeInfo.changeDetails.coinbaseAscii.new || 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.coinbaseOutputValue && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">Output Value Old: {(hoveredPoint.changeInfo.changeDetails.coinbaseOutputValue.old / 100000000).toFixed(8)} BTC</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">Output Value New: {(hoveredPoint.changeInfo.changeDetails.coinbaseOutputValue.new / 100000000).toFixed(8)} BTC</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.coinbaseOutputs && (
                  <div className="mb-1">
                    <div className="text-orange-300 font-semibold mb-1">Output Structure Changed:</div>
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">Old: {hoveredPoint.changeInfo.changeDetails.coinbaseOutputs.old.length} output(s)</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">New: {hoveredPoint.changeInfo.changeDetails.coinbaseOutputs.new.length} output(s)</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.auxPowMerkleSize && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">AuxPOW Merkle Size Old: {hoveredPoint.changeInfo.changeDetails.auxPowMerkleSize.old ?? 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">AuxPOW Merkle Size New: {hoveredPoint.changeInfo.changeDetails.auxPowMerkleSize.new ?? 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.auxPowNonce && (
                  <div className="mb-1">
                    <div className="text-red-300 whitespace-nowrap overflow-hidden">AuxPOW Nonce Old: {hoveredPoint.changeInfo.changeDetails.auxPowNonce.old ?? 'N/A'}</div>
                    <div className="text-green-300 whitespace-nowrap overflow-hidden">AuxPOW Nonce New: {hoveredPoint.changeInfo.changeDetails.auxPowNonce.new ?? 'N/A'}</div>
                  </div>
                )}
                {hoveredPoint.changeInfo?.changeDetails.opReturnProtocols && hoveredPoint.changeInfo.changeDetails.opReturnProtocols.changed.length > 0 && (
                  <div className="mb-1">
                    <div className="text-purple-300 font-semibold mb-1">OP_RETURN Protocol Changes:</div>
                    {hoveredPoint.changeInfo.changeDetails.opReturnProtocols.changed.map((protocol, index) => {
                      const oldData = hoveredPoint.changeInfo?.changeDetails.opReturnProtocols?.old.get(protocol);
                      const newData = hoveredPoint.changeInfo?.changeDetails.opReturnProtocols?.new.get(protocol);
                      
                      // Helper function to get key display value for different protocols
                      const getDisplayValue = (data: { details?: Record<string, unknown>; dataHex?: string; value?: number } | undefined) => {
                        if (!data) return 'N/A';
                        
                        // For WitnessCommitment, show dataHex if no details
                        if (protocol === 'WitnessCommitment' && !data.details && data.dataHex) {
                          return data.dataHex.substring(0, 16) + '...';
                        }
                        
                        if (!data.details) return 'N/A';
                        
                        switch (protocol) {
                          case 'RSK Block':
                            return (data.details.rskBlockHash as string)?.substring(0, 16) + '...' || 'N/A';
                          case 'CoreDAO':
                            return (data.details.validatorAddress as string)?.substring(0, 20) + '...' || 'N/A';
                          case 'Syscoin':
                            return (data.details.relatedHash as string)?.substring(0, 16) + '...' || 'N/A';
                          case 'Hathor Network':
                            return (data.details.auxBlockHash as string)?.substring(0, 16) + '...' || 'N/A';
                          case 'ExSat':
                            return (data.details.synchronizerAccount as string) || 'N/A';
                          case 'Omni':
                            return data.dataHex ? data.dataHex.substring(0, 16) + '...' : 'Empty';
                          case 'Runestone':
                            return data.dataHex ? data.dataHex.substring(0, 16) + '...' : 'Empty';
                          case 'WitnessCommitment':
                            return data.dataHex ? data.dataHex.substring(0, 16) + '...' : 'Empty';
                          case 'Stacks Block Commit':
                            return data.dataHex ? data.dataHex.substring(0, 16) + '...' : 'Empty';
                          case 'BIP47 Payment Code':
                            return data.dataHex ? data.dataHex.substring(0, 16) + '...' : 'Empty';
                          default:
                            const keys = Object.keys(data.details);
                            return keys.length > 0 ? `${keys.length} fields` : 'Empty';
                        }
                      };
                      
                      return (
                        <div key={index} className="mb-1">
                          <div className="text-cyan-300 font-medium">{protocol}:</div>
                          {!oldData && newData && (
                            <div className="text-green-300 whitespace-nowrap overflow-hidden">  Added: {getDisplayValue(newData)}</div>
                          )}
                          {oldData && !newData && (
                            <div className="text-red-300 whitespace-nowrap overflow-hidden">  Removed: {getDisplayValue(oldData)}</div>
                          )}
                          {oldData && newData && (
                            <>
                              <div className="text-red-300 whitespace-nowrap overflow-hidden">  Old: {getDisplayValue(oldData)}</div>
                              <div className="text-green-300 whitespace-nowrap overflow-hidden">  New: {getDisplayValue(newData)}</div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {hoveredPoint.changeInfo.changeDetails.otherChanges && hoveredPoint.changeInfo.changeDetails.otherChanges.length > 0 && (
                  <div className="mb-1">
                    <div className="text-yellow-300 font-semibold mb-1">Other Changes:</div>
                    {hoveredPoint.changeInfo.changeDetails.otherChanges.map((change, index) => (
                      <div key={index} className="mb-1">
                        <div className="text-red-300 whitespace-nowrap overflow-hidden">{change.field} Old: {String(change.old)}</div>
                        <div className="text-green-300 whitespace-nowrap overflow-hidden">{change.field} New: {String(change.new)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
      
      {/* Change indicators legend in footer */}
      <div className="absolute bottom-6 left-2 group">
        <div className="text-[9px] text-gray-500 dark:text-gray-400 cursor-help">
          Legend
        </div>
        <div className="absolute bottom-6 left-0 hidden group-hover:block bg-black/95 text-white p-3 rounded-lg shadow-xl z-30 min-w-max">
          <div className="text-[10px] flex flex-row gap-6">
            <div className="flex flex-col space-y-0.5">
              <div className="font-bold mb-1 text-blue-300 text-center">Core Fields</div>
              <div><span className="font-mono font-bold">A</span> - AuxPOW hash</div>
              <div><span className="font-mono font-bold">M</span> - Merkle branches</div>
              <div><span className="font-mono font-bold">C</span> - Clean jobs</div>
              <div><span className="font-mono font-bold">P</span> - Prev hash</div>
              <div><span className="font-mono font-bold">H</span> - Height</div>
              <div><span className="font-mono font-bold">V</span> - Version</div>
              <div><span className="font-mono font-bold">N</span> - nBits</div>
              <div><span className="font-mono font-bold">E</span> - Extranonce2 length</div>
            </div>
            <div className="flex flex-col space-y-0.5">
              <div className="font-bold mb-1 text-green-300 text-center">Transaction Fields</div>
              <div><span className="font-mono font-bold">X</span> - TX version</div>
              <div><span className="font-mono font-bold">L</span> - TX locktime</div>
              <div><span className="font-mono font-bold">I</span> - Input sequence</div>
              <div><span className="font-mono font-bold">W</span> - Witness nonce</div>
              <div><span className="font-mono font-bold">U</span> - Output structure</div>
              <div><span className="font-mono font-bold">K</span> - AuxPOW merkle size</div>
              <div><span className="font-mono font-bold">J</span> - AuxPOW nonce</div>
            </div>
            <div className="flex flex-col space-y-0.5">
              <div className="font-bold mb-1 text-yellow-300 text-center">OP_RETURN Protocols</div>
              <div><span className="font-mono font-bold">R̶</span> - RSK Block</div>
              <div><span className="font-mono font-bold">C̶</span> - CoreDAO</div>
              <div><span className="font-mono font-bold">S̶</span> - Syscoin</div>
              <div><span className="font-mono font-bold">H̶</span> - Hathor Network</div>
              <div><span className="font-mono font-bold">E̶</span> - ExSat</div>
              <div><span className="font-mono font-bold">O̶</span> - Omni</div>
              <div><span className="font-mono font-bold">U̶</span> - Runestone</div>
              <div><span className="font-mono font-bold">W̶</span> - WitnessCommitment</div>
              <div><span className="font-mono font-bold">T̶</span> - Stacks Block</div>
              <div><span className="font-mono font-bold">B̶</span> - BIP47 Payment</div>
              <div><span className="font-mono font-bold">Ø̶</span> - Empty OP_RETURN</div>
              <div><span className="font-mono font-bold">Ω̶</span> - Other OP_RETURN</div>
              <div><span className="inline-block w-3 h-3 bg-gray-400 rounded-full mr-1"></span> - First/duplicate</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Wrap with React.memo to prevent unnecessary re-renders
const RealtimeChart = React.memo(RealtimeChartBase);

export default RealtimeChart; 