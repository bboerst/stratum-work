"use client";

import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType, StratumV1Data } from "@/lib/types";
import { 
  ChartContainer, 
  ChartTooltip
} from "@/components/ui/chart";
import * as RechartsPrimitive from "recharts";

// For type safety with recharts domains
type AxisDomain = number | string | ((value: number) => number);

// Format numerical timestamp (could be hex-derived) for display
const formatTimestamp = (timestamp: number) => {
  try {
    // Convert microseconds to milliseconds for Date
    const date = new Date(timestamp / 1000);
    
    // Format as HH:MM:SS.mmm
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
    const microseconds = (timestamp % 1000).toString().padStart(3, '0');
    
    return `${hours}:${minutes}:${seconds}.${milliseconds}${microseconds}`;
  } catch {
    return String(timestamp); // Fallback
  }
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

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    payload: ChartDataPoint;
  }>;
}

// Enhanced tooltip component
const CustomTooltip = ({ active, payload }: CustomTooltipProps) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="custom-tooltip rounded-md p-3 bg-black/85 text-white text-xs max-w-xs border border-gray-700 shadow-lg">
        <h4 className="m-0 pb-1 mb-2 border-b border-gray-600 font-medium bg-gray-800 -mx-3 -mt-3 p-2 rounded-t-md">{data.poolName}</h4>
        <table className="w-full">
          <tbody>
            <tr>
              <td className="pr-3 py-0.5 font-semibold">Time:</td>
              <td>{formatTimestamp(data.timestamp)}</td>
            </tr>
            <tr>
              <td className="pr-3 py-0.5 font-semibold">Height:</td>
              <td>{data.height || 'N/A'}</td>
            </tr>
            {data.version && (
              <tr>
                <td className="pr-3 py-0.5 font-semibold">Version:</td>
                <td>{data.version}</td>
              </tr>
            )}
            {data.clean_jobs !== undefined && (
              <tr>
                <td className="pr-3 py-0.5 font-semibold">Clean Jobs:</td>
                <td>{data.clean_jobs.toString()}</td>
              </tr>
            )}
            {data.prev_hash && (
              <tr>
                <td className="pr-3 py-0.5 font-semibold">Prev Hash:</td>
                <td className="truncate" style={{ maxWidth: "160px" }}>{data.prev_hash}</td>
              </tr>
            )}
            {data.nbits && (
              <tr>
                <td className="pr-3 py-0.5 font-semibold">nBits:</td>
                <td>{data.nbits}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
};

interface RealtimeChartProps {
  paused?: boolean;
  filterBlockHeight?: number;
  height?: number;
}

// Define pool colors map type
interface PoolColorsMap {
  [poolName: string]: string;
}

export default function RealtimeChart({ 
  paused = false, 
  filterBlockHeight,
  height = 200
}: RealtimeChartProps) {
  // Get data from the global data stream
  const { filterByType } = useGlobalDataStream();
  
  // State for chart data and visualization options
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [poolColors, setPoolColors] = useState<PoolColorsMap>({});
  
  // Maps to track pool information
  const poolRankingsRef = useRef<Map<string, number>>(new Map());
  const poolColorsRef = useRef<PoolColorsMap>({});
  
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
  
  // Process data and keep only the latest data point per pool
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
    
    // Keep only the latest data point for each pool
    const latestPointByPool = new Map<string, ChartDataPoint>();
    
    processedData.forEach(dataPoint => {
      const poolName = dataPoint.poolName;
      const existingPoint = latestPointByPool.get(poolName);
      
      // If we don't have a point for this pool yet, or this one is newer, use it
      if (!existingPoint || dataPoint.timestamp > existingPoint.timestamp) {
        latestPointByPool.set(poolName, dataPoint);
      }
    });
    
    // Convert map to array
    return Array.from(latestPointByPool.values());
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
    
    // Process the data to get the latest point per pool
    const latestDataPoints = processData(stratumData);
    
    // Update the chart data if we have points
    if (latestDataPoints.length > 0) {
      setChartData(latestDataPoints);
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
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 w-full min-h-0">
        <ChartContainer className="h-full" config={chartConfig}>
          <RechartsPrimitive.ScatterChart
            width={700}
            height={350}
            margin={{ top: 20, right: 30, bottom: 30, left: 10 }}
          >
            <RechartsPrimitive.XAxis 
              type="number"
              dataKey="timestamp"
              name="Time"
              domain={xAxisDomain}
              tickFormatter={formatTimestamp}
              label={{ 
                value: 'Time (HH:MM:SS.microsec)', 
                position: 'insideBottom', 
                offset: -5
              }}
              tick={{ fontSize: 10 }}
              tickCount={6}
            />
            <RechartsPrimitive.YAxis 
              type="number"
              dataKey="poolIndex"
              name="Pool"
              domain={yAxisDomain}
              tick={false}
              axisLine={false}
            />
            <RechartsPrimitive.ZAxis 
              type="number"
              dataKey="z"
              range={[60, 60]} // Larger dots for better visibility
              name="Size"
            />
            <ChartTooltip 
              content={<CustomTooltip />}
            />
            {chartData.map((entry) => (
              <RechartsPrimitive.Scatter 
                key={`scatter-${entry.poolName}`}
                name={entry.poolName}
                data={[entry]} 
                fill={poolColorsRef.current[entry.poolName] || '#8884d8'}
                shape="circle"
                isAnimationActive={false}
                fillOpacity={0.8}
              />
            ))}
          </RechartsPrimitive.ScatterChart>
        </ChartContainer>
      </div>
    </div>
  );
} 