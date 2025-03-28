"use client";

import React from 'react';
import RealtimeChart from './RealtimeChart';

interface HistoricalChartWrapperProps {
  blockHeight: number;
}

export default function HistoricalChartWrapper({ blockHeight }: HistoricalChartWrapperProps) {
  return (
    <div className="w-full border border-border rounded-md px-2 py-0 bg-card h-[200px] mb-2">
      <div className="h-full">
        <RealtimeChart 
          paused={false} // We actually need this to be false to trigger data loading
          filterBlockHeight={blockHeight}
          timeWindow={300} // Use a larger time window for historical view
          pointSize={2} // Use smaller point size for historical data
        />
      </div>
    </div>
  );
} 