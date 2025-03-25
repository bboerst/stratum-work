"use client";

import React from 'react';
import { formatTimestamp } from '@/lib/utils';

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
export const CustomTooltip = ({ active, payload }: CustomTooltipProps) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="custom-tooltip rounded-md p-3 bg-black/85 text-white text-xs max-w-xs border border-gray-700 shadow-lg" style={{ color: "white" }}>
        <h4 className="m-0 pb-1 mb-2 border-b border-gray-600 font-medium bg-gray-800 -mx-3 -mt-3 p-2 rounded-t-md" style={{ color: "white" }}>{data.poolName}</h4>
        <table className="w-full text-white">
          <tbody>
            <tr>
              <td className="pr-3 py-0.5 font-semibold" style={{ color: "white" }}>Time:</td>
              <td style={{ color: "white" }}>{formatTimestamp(data.timestamp)}</td>
            </tr>
            <tr>
              <td className="pr-3 py-0.5 font-semibold" style={{ color: "white" }}>Height:</td>
              <td style={{ color: "white" }}>{data.height || 'N/A'}</td>
            </tr>
            {data.version && (
              <tr>
                <td className="pr-3 py-0.5 font-semibold" style={{ color: "white" }}>Version:</td>
                <td style={{ color: "white" }}>{data.version}</td>
              </tr>
            )}
            {data.clean_jobs !== undefined && (
              <tr>
                <td className="pr-3 py-0.5 font-semibold" style={{ color: "white" }}>Clean Jobs:</td>
                <td style={{ color: "white" }}>{data.clean_jobs.toString()}</td>
              </tr>
            )}
            {data.prev_hash && (
              <tr>
                <td className="pr-3 py-0.5 font-semibold" style={{ color: "white" }}>Prev Hash:</td>
                <td className="truncate" style={{ maxWidth: "160px", color: "white" }}>{data.prev_hash}</td>
              </tr>
            )}
            {data.nbits && (
              <tr>
                <td className="pr-3 py-0.5 font-semibold" style={{ color: "white" }}>nBits:</td>
                <td style={{ color: "white" }}>{data.nbits}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
};

export default CustomTooltip; 