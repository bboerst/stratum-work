"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType, StratumV1Data } from "@/lib/types";
import { 
  ChartContainer
} from "@/components/ui/chart";
import * as RechartsPrimitive from "recharts";

// For type safety with recharts domains
type AxisDomain = number | string | ((value: number) => number);

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
  z?: number;
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

export default function RealtimeChart({ 
  paused = false, 
  filterBlockHeight,
  timeWindow = 30 // Default to 30 seconds
}: RealtimeChartProps) {
  // Get data from the global data stream
  const { filterByType } = useGlobalDataStream();
  
  // State for chart data and visualization options
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  
  // Add state for hovering
  const [hoveredPool, setHoveredPool] = useState<string | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<ChartDataPoint | null>(null);
  
  // Maps to track pool information
  const poolRankingsRef = useRef<Map<string, number>>(new Map());
  const poolColorsRef = useRef<PoolColorsMap>({});
  
  // Keep a history of data points for each pool
  const poolDataHistoryRef = useRef<Map<string, ChartDataPoint[]>>(new Map());
  
  // Track the time range of the data for x-axis domain
  const timeRangeRef = useRef<{ min: number, max: number }>({ min: 0, max: 0 });
  
  // Chart config for shadcn/ui chart
  const chartConfig = useMemo(() => {
    const config: Record<string, { color: string, label: string }> = {};
    
    Object.entries(poolColorsRef.current).forEach(([name, color]) => {
      config[name] = {
        color,
        label: name
      };
    });
    
    return config;
  }, []);
  
  // Process pool colors and rankings
  const updatePoolInfo = useCallback((stratumData: StratumV1Data[]) => {
    const poolNames = new Set<string>();
    stratumData.forEach(item => {
      if (item.pool_name) {
        poolNames.add(item.pool_name);
      }
    });
    
    // Update rankings and colors if we have new pools
    const existingPoolsCount = poolRankingsRef.current.size;
    if (poolNames.size > existingPoolsCount) {
      const rankings = new Map<string, number>();
      const colors: PoolColorsMap = {};
      
      Array.from(poolNames).sort().forEach((name, idx) => {
        rankings.set(name, idx + 1);
        colors[name] = stringToColor(name);
      });
      
      poolRankingsRef.current = rankings;
      poolColorsRef.current = colors;
    }
  }, []);
  
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
    const timeWindowMs = timeWindow * 1000; // Convert seconds to milliseconds
    const cutoffTimeMs = currentTimeMs - timeWindowMs;
    
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
        poolIndex: poolRankingsRef.current.get(item.pool_name || 'Unknown') || 0,
        height: item.height,
        version: item.version,
        clean_jobs: item.clean_jobs,
        prev_hash: item.prev_hash,
        nbits: item.nbits,
        ntime: item.ntime,
        z: 1 // Fixed value for all points to ensure same size
      };
    });
    
    // Update time range reference if we have valid data
    if (minTimestamp !== Number.MAX_SAFE_INTEGER) {
      timeRangeRef.current = {
        min: minTimestamp,
        max: maxTimestamp
      };
    }
    
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
    
    return resultPoints;
  }, [filterBlockHeight, timeWindow, parseTimestamp]);
  
  // Reset pool data history when block height changes
  useEffect(() => {
    poolDataHistoryRef.current.clear();
    setChartData([]);
  }, [filterBlockHeight]);
  
  // Fetch and update data from the global stream
  useEffect(() => {
    if (paused) return;
    
    // Get stratum updates from the stream
    const stratumUpdates = filterByType(StreamDataType.STRATUM_V1);
    if (stratumUpdates.length === 0) return;
    
    const stratumData = stratumUpdates.map(item => item.data as StratumV1Data);
    
    // Update pool information
    updatePoolInfo(stratumData);
    
    // Process the data to get the points within time window
    const dataPoints = processData(stratumData);
    
    // Update the chart data if we have points
    if (dataPoints.length > 0) {
      setChartData(dataPoints);
    }
    
  }, [filterByType, paused, updatePoolInfo, processData]);
  
  // Compute Y-axis domain based on the number of pools
  const yAxisDomain = useMemo((): [AxisDomain, AxisDomain] => {
    return [0, Math.max(10, poolRankingsRef.current.size + 1)];
  }, []);
  
  // Compute X-axis domain based on the time window and actual data
  const xAxisDomain = useMemo((): [AxisDomain, AxisDomain] => {
    if (chartData.length === 0) {
      // Default domain when no data
      const currentTime = Date.now();
      return [currentTime - (timeWindow * 1000), currentTime];
    }
    
    // Use the time range from the data, but ensure it spans at most timeWindow seconds
    const { min, max } = timeRangeRef.current;
    const currentTime = Date.now();
    const minTime = Math.max(min, currentTime - (timeWindow * 1000));
    
    // Make sure we always have a reasonable domain width
    return [minTime, Math.max(max, minTime + 1000)];
  }, [chartData, timeWindow]);

  // Handle mouse events for highlighting
  const handleMouseEnter = useCallback((data: ChartDataPoint) => {
    setHoveredPool(data.poolName);
    setHoveredPoint(data);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredPool(null);
    setHoveredPoint(null);
  }, []);

  // Group chart data by pool name for easier rendering
  const groupedChartData = useMemo(() => {
    const grouped: Record<string, ChartDataPoint[]> = {};
    
    chartData.forEach(point => {
      if (!grouped[point.poolName]) {
        grouped[point.poolName] = [];
      }
      grouped[point.poolName].push(point);
    });
    
    return grouped;
  }, [chartData]);

  return (
    <div className="w-full h-full relative">
      <div className="w-full h-full" style={{ cursor: 'crosshair' }}>
        <ChartContainer className="w-full h-full" config={chartConfig}>
          <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
            <RechartsPrimitive.ScatterChart
              margin={{ top: 15, right: 15, bottom: 25, left: 5 }}
              onMouseLeave={handleMouseLeave}
            >
              <RechartsPrimitive.XAxis 
                type="number"
                dataKey="timestamp"
                name="Time"
                domain={xAxisDomain}
                tickFormatter={formatMicroseconds}
                label={{ 
                  position: 'insideBottom', 
                  offset: -5,
                  fontSize: 10
                }}
                tick={{ fontSize: 8 }}
                tickCount={4}
                stroke="currentColor"
              />
              <RechartsPrimitive.YAxis 
                type="number"
                dataKey="poolIndex"
                name="Pool"
                domain={yAxisDomain}
                tick={false}
                axisLine={false}
                stroke="currentColor"
                width={0}
              />
              <RechartsPrimitive.ZAxis 
                type="number"
                range={[30, 60]} // Range from moderate to larger size 
                name="Size"
              />
              {/* Add full crosshair only */}
              <RechartsPrimitive.Tooltip 
                cursor={{
                  strokeDasharray: '3 3',
                  stroke: 'rgba(200, 200, 200, 0.8)',
                  strokeWidth: 1
                }}
                content={() => null}
                position={{x: 0, y: 0}}
                wrapperStyle={{ opacity: 0 }}
              />
              {/* Render normal-sized points for all data */}
              {Object.entries(groupedChartData).map(([poolName, points]) => (
                <RechartsPrimitive.Scatter 
                  key={`scatter-${poolName}`}
                  name={poolName}
                  data={hoveredPool === poolName ? [] : points} // Only show if not hovered
                  fill={poolColorsRef.current[poolName] || '#8884d8'}
                  shape="circle"
                  isAnimationActive={false}
                  fillOpacity={0.8}
                >
                  {points.map((entry) => (
                    <RechartsPrimitive.Cell 
                      key={`cell-${entry.poolName}-${entry.timestamp}`} 
                      onMouseEnter={() => handleMouseEnter(entry)}
                      onMouseLeave={handleMouseLeave}
                      style={{ cursor: 'crosshair' }}
                    />
                  ))}
                </RechartsPrimitive.Scatter>
              ))}
              
              {/* Render larger points for hovered pool */}
              {hoveredPool && (
                <RechartsPrimitive.Scatter
                  name={`${hoveredPool}-large`}
                  data={groupedChartData[hoveredPool] || []}
                  fill={poolColorsRef.current[hoveredPool] || '#8884d8'}
                  shape="circle"
                  isAnimationActive={false}
                  fillOpacity={0.8}
                  zAxisId={1}
                >
                  {(groupedChartData[hoveredPool] || []).map((entry) => (
                    <RechartsPrimitive.Cell 
                      key={`cell-large-${entry.poolName}-${entry.timestamp}`} 
                      onMouseEnter={() => handleMouseEnter(entry)}
                      style={{ cursor: 'crosshair' }}
                    />
                  ))}
                </RechartsPrimitive.Scatter>
              )}
            </RechartsPrimitive.ScatterChart>
          </RechartsPrimitive.ResponsiveContainer>
        </ChartContainer>
      </div>
      
      {/* Fixed tooltip at the bottom of the chart */}
      {hoveredPoint && (
        <div className="absolute bottom-2 right-2 text-xs font-medium text-right">
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