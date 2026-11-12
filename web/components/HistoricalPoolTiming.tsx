'use client';

import React, { useEffect, useState } from 'react';
import { useLatencyAdjusted } from './TimingDisplayContext';
import { computePoolTiming, type FirstSeenRow, type PoolTiming } from '@/utils/poolTiming';

interface HistoricalPoolTimingProps {
  blockHeight: number | null;
}

// Helper function to calculate percentiles (linear interpolation method)
function getPercentile(sortedData: number[], percentile: number): number {
  if (!sortedData || sortedData.length === 0) {
    return 0;
  }
  const index = (percentile / 100) * (sortedData.length - 1);
  if (Number.isInteger(index)) {
    return sortedData[index];
  } else {
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    // Ensure upper is within bounds
    const safeUpper = Math.min(upper, sortedData.length - 1);
    if (lower === safeUpper) return sortedData[lower]; // Avoid issues if index is near the end
    return sortedData[lower] * (safeUpper - index) + sortedData[safeUpper] * (index - lower);
  }
}

const HistoricalPoolTiming: React.FC<HistoricalPoolTimingProps> = ({ blockHeight }) => {
  const [timing, setTiming] = useState<PoolTiming>({ reliable: [], unreliable: [] });
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [latencyAdjusted] = useLatencyAdjusted('timing-chart');

  useEffect(() => {
    if (blockHeight === null || blockHeight <= 0) {
      setTiming({ reliable: [], unreliable: [] }); // Clear data if blockHeight is not valid
      return;
    }

    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/block-pool-first-seen?height=${blockHeight}`);
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ message: 'Failed to fetch data' }));
          throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
        }
        const data: FirstSeenRow[] = await response.json();
        // Only pools whose collector was already connected at the previous height can anchor "First" (#104).
        setTiming(computePoolTiming(data, latencyAdjusted));
      } catch (e) {
        if (e instanceof Error) {
          setError(e.message);
        } else {
          setError('An unknown error occurred');
        }
        console.error("Error fetching pool timing data:", e);
        setTiming({ reliable: [], unreliable: [] });
      }
      setIsLoading(false);
    };

    fetchData();
  }, [blockHeight, latencyAdjusted]);

  if (blockHeight === null || blockHeight <= 0) {
    return null; // Don't render anything if no valid block is selected
  }

  if (isLoading) {
    return <div className="p-4 text-center text-gray-500 dark:text-gray-400">Loading pool timing data...</div>;
  }

  if (error) {
    return <div className="p-4 text-center text-red-500">Error: {error}</div>;
  }

  if (timing.reliable.length === 0 && timing.unreliable.length === 0) {
    return <div className="p-4 text-center text-gray-500 dark:text-gray-400">No pool timing data available for this block.</div>;
  }

  const timingData = timing.reliable;
  const allRelativeTimesNs = timingData.map(d => d.relativeTimeNs ?? 0);
  const actualMaxObservedTime = Math.max(0, ...allRelativeTimesNs);
  let barScalingReferenceTime = actualMaxObservedTime;

  if (actualMaxObservedTime > 0) {
    const positiveUniqueSortedTimes = Array.from(new Set(allRelativeTimesNs.filter(t => t > 0))).sort((a, b) => a - b);

    if (positiveUniqueSortedTimes.length >= 4) { // Need enough data for meaningful Q1/Q3
      const q1 = getPercentile(positiveUniqueSortedTimes, 25);
      const q3 = getPercentile(positiveUniqueSortedTimes, 75);
      const iqr = q3 - q1;

      if (iqr >= 0) { // Proceed if IQR is non-negative
        const upperFence = q3 + 1.0 * iqr;
        // The reference time should be the upper fence, but not smaller than Q3 itself (e.g. if IQR is 0)
        // And not smaller than the smallest positive value if the fence is very low.
        // Also, ensure it is positive.
        let potentialReference = Math.max(upperFence, q3);
        if (positiveUniqueSortedTimes[0] > 0) {
            potentialReference = Math.max(potentialReference, positiveUniqueSortedTimes[0]);
        }
        barScalingReferenceTime = potentialReference > 0 ? potentialReference : actualMaxObservedTime;
      } else {
        // Fallback if IQR is negative (should not happen with sorted positive data but defensive)
        barScalingReferenceTime = actualMaxObservedTime;
      }
    } else {
      // Not enough distinct positive values for IQR, use actual max
      barScalingReferenceTime = actualMaxObservedTime;
    }
  }
  // Ensure barScalingReferenceTime is not zero if there is positive data, to avoid division by zero for barWidth
  if (barScalingReferenceTime === 0 && actualMaxObservedTime > 0) {
    barScalingReferenceTime = actualMaxObservedTime;
  }

  const midHeightTitle =
    'Our collector for this pool connected after this height started (no template from it at the previous height), ' +
    "so this is when we first saw its work, not when the pool first sent it.";

  return (
    <div className="p-4">
      {timingData.length === 0 && (
        <p className="px-2 pb-2 text-xs text-gray-500 dark:text-gray-400">
          Timing for this height is incomplete: every collector connected after it started.
        </p>
      )}
      <ul className="space-y-0">
        {timingData.map((item, index) => {
          const relativeTimeNs = item.relativeTimeNs ?? 0;
          const timeForBarLength = Math.min(relativeTimeNs, barScalingReferenceTime);
          const barWidth = barScalingReferenceTime > 0 ? (timeForBarLength / barScalingReferenceTime) * 100 : 0;
          
          return (
            <li key={index} className="flex justify-between items-center px-2 rounded-sm">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300 w-36 truncate mr-2" title={item.poolName}>{item.poolName}</span>
              <div className="flex items-center grow">
                <div className="w-full h-3 bg-gray-200 dark:bg-gray-600 rounded-sm mr-1">
                  <div 
                    className="h-3 bg-blue-500 rounded-sm transition-all duration-500 ease-in-out"
                    style={{ width: `${barWidth}%` }}
                    title={`${relativeTimeNs.toLocaleString()} ns after first`}
                  ></div>
                </div>
                <span className="text-xs text-gray-600 dark:text-gray-400 w-20 text-right">
                  {relativeTimeNs === 0 ? 'First' : `+${(relativeTimeNs / 1_000_000_000).toFixed(3)}s`}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {timing.unreliable.length > 0 && (
        <div className="mt-2 opacity-60" title={midHeightTitle}>
          <p className="px-2 text-xs text-gray-500 dark:text-gray-400">Connected mid-height (timing not comparable)</p>
          <ul className="space-y-0">
            {timing.unreliable.map((item, index) => (
              <li key={index} className="flex justify-between items-center px-2 rounded-sm">
                <span className="text-sm text-gray-600 dark:text-gray-400 w-36 truncate mr-2" title={item.poolName}>{item.poolName}</span>
                <div className="grow h-3 mr-1 border border-dashed border-gray-300 dark:border-gray-600 rounded-sm" />
                <span className="text-xs text-gray-500 dark:text-gray-400 w-20 text-right">n/a</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default HistoricalPoolTiming; 