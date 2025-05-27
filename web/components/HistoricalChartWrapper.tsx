"use client";

import React from 'react';
import RealtimeChart from './RealtimeChart';
import { CHART_POINT_SIZES } from '@/lib/constants';

interface HistoricalChartWrapperProps {
  blockHeight: number;
}

export default function HistoricalChartWrapper({ blockHeight }: HistoricalChartWrapperProps) {
  return (
    <div className="w-full h-full">
      <div className="h-full">
        <RealtimeChart 
          paused={false} // We actually need this to be false to trigger data loading
          filterBlockHeight={blockHeight}
          timeWindow={300} // Use a larger time window for historical view
          pointSize={CHART_POINT_SIZES.HISTORICAL} // Use constant for historical data point size
        />
      </div>
    </div>
  );
} 