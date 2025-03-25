"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType, StratumV1Data } from "@/lib/types";
import { formatTimestamp } from "@/lib/utils";
import { 
  ChartContainer, 
  ChartTooltip
} from "@/components/ui/chart";
import * as RechartsPrimitive from "recharts";
import CustomTooltip from "./CustomTooltip";

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
  height?: number;
  maxPointsPerPool?: number; // New parameter for controlling points per pool
}

// Define pool colors map type
interface PoolColorsMap {
  [poolName: string]: string;
}

export default function RealtimeChart({ 
  paused = false, 
  filterBlockHeight,
  height = 200,
  maxPointsPerPool = 1 // Default to 1 point per pool for backward compatibility
}: RealtimeChartProps) {
  // Get data from the global data stream
  const { filterByType } = useGlobalDataStream();
  
  // State for chart data and visualization options
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [poolColors, setPoolColors] = useState<PoolColorsMap>({});
  
  // Maps to track pool information
  const poolRankingsRef = useRef<Map<string, number>>(new Map());
  const poolColorsRef = useRef<PoolColorsMap>({});
  
  // Keep a history of data points for each pool
  const poolDataHistoryRef = useRef<Map<string, ChartDataPoint[]>>(new Map());
  
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
      
      setPoolColors({...colors});
    }
  }, []);
  
  // Process data and keep multiple data points per pool based on maxPointsPerPool
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
    
    // Transform the data for the chart
    const processedData = filteredData.map(item => {
      // Handle the timestamp - it may be a hex string or ISO date string
      let timestamp: number;
      
      if (typeof item.timestamp === 'string') {
        // First try parsing as ISO date
        const dateTimestamp = new Date(item.timestamp).getTime();
        
        if (isNaN(dateTimestamp)) {
          // If not a valid date, try parsing as hex
          try {
            // Remove '0x' prefix if present and convert to decimal
            const cleaned = item.timestamp.replace(/^0x/, '');
            // Parse the hex string 
            timestamp = parseInt(cleaned, 16);
          } catch {
            timestamp = Date.now(); // Fallback to current time
          }
        } else {
          // It was a valid date string
          timestamp = dateTimestamp * 1000; // Convert ms to μs
        }
      } else {
        // Use current time as fallback
        timestamp = Date.now() * 1000;
      }
      
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
    
    // Collect all the points to display from the history
    const resultPoints: ChartDataPoint[] = [];
    poolDataHistoryRef.current.forEach((history, poolName) => {
      // Take the most recent maxPointsPerPool points
      const pointsToShow = history.slice(0, maxPointsPerPool);
      resultPoints.push(...pointsToShow);
    });
    
    return resultPoints;
  }, [filterBlockHeight, maxPointsPerPool]);
  
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
    
    // Process the data to get the latest points per pool
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
  
  // Compute X-axis domain based on the timestamp range in the data
  const xAxisDomain = useMemo((): [AxisDomain, AxisDomain] => {
    if (chartData.length === 0) {
      return [0, 1000000]; // Default domain when no data
    }
    
    // Find min and max timestamps
    const timestamps = chartData.map(point => point.timestamp);
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    
    // Add padding to the domain
    const range = maxTime - minTime;
    const padding = Math.max(range * 0.2, 1000000); // At least 1 second of padding
    
    return [minTime - padding, maxTime + padding];
  }, [chartData]);

  return (
    <div className="w-full h-full">
      <div className="w-full h-full">
        <ChartContainer className="w-full h-full" config={chartConfig}>
          <RechartsPrimitive.ResponsiveContainer width="100%" height="100%">
            <RechartsPrimitive.ScatterChart
              margin={{ top: 15, right: 15, bottom: 25, left: 5 }}
            >
              <RechartsPrimitive.XAxis 
                type="number"
                dataKey="timestamp"
                name="Time"
                domain={xAxisDomain}
                tickFormatter={formatTimestamp}
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
              />
              <RechartsPrimitive.ZAxis 
                type="number"
                dataKey="z"
                range={[40, 40]} // Slightly smaller dots for narrow containers
                name="Size"
              />
              <ChartTooltip 
                content={<CustomTooltip />}
              />
              {chartData.map((entry) => (
                <RechartsPrimitive.Scatter 
                  key={`scatter-${entry.poolName}-${entry.timestamp}`}
                  name={entry.poolName}
                  data={[entry]} 
                  fill={poolColorsRef.current[entry.poolName] || '#8884d8'}
                  shape="circle"
                  isAnimationActive={false}
                  fillOpacity={0.8}
                />
              ))}
            </RechartsPrimitive.ScatterChart>
          </RechartsPrimitive.ResponsiveContainer>
        </ChartContainer>
      </div>
    </div>
  );
} 