"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useVisualization } from './VisualizationContext';
import RealtimeChart from './RealtimeChart';
import { CHART_POINT_SIZES } from '@/lib/constants';

// Improved throttle helper function with correct typing and better performance
function createThrottle<T extends (e: MouseEvent) => void>(
  func: T,
  limit: number
): T {
  let lastCall = 0;
  return ((e: MouseEvent) => {
    const now = performance.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      func(e);
    }
  }) as T;
}

interface VisualizationPanelProps {
  paused?: boolean;
  filterBlockHeight?: number;
}

export default function VisualizationPanel({ 
  paused = false,
  filterBlockHeight
}: VisualizationPanelProps) {
  const { isPanelVisible } = useVisualization();
  const [width, setWidth] = useState(350); // Default width
  const minWidth = 350; // Minimum width
  const maxWidth = 800; // Maximum width
  const timeWindow = 15; // Default to 15 seconds
  
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // Check if we're in historical mode (viewing a specific historical block)
  const isHistoricalBlock = filterBlockHeight !== undefined && filterBlockHeight !== -1;

  // Throttled resize handler to improve performance
  const handleThrottledMouseMove = useCallback((e: MouseEvent) => {
    if (isDraggingRef.current) {
      // Invert the delta since we're resizing from the left side now
      const delta = startXRef.current - e.clientX;
      let newWidth = startWidthRef.current + delta;
      
      // Apply constraints
      newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      
      setWidth(newWidth);
    }
  }, []);
  
  // Apply throttling outside of useCallback to avoid dependency issues
  const throttledMouseMove = createThrottle(handleThrottledMouseMove, 16); // Approximately 60fps

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (resizeHandleRef.current && resizeHandleRef.current.contains(e.target as Node)) {
        isDraggingRef.current = true;
        startXRef.current = e.clientX;
        startWidthRef.current = width;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
      }
    };

    const handleMouseUp = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', throttledMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', throttledMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [width, throttledMouseMove]);

  // Render the pool timing chart
  const renderPoolTimingChart = useCallback(() => {
    return (
      <div className="border border-border rounded-md p-2 bg-card h-[550px] w-full">
        <RealtimeChart 
          paused={paused} 
          filterBlockHeight={filterBlockHeight}
          timeWindow={timeWindow}
          pointSize={CHART_POINT_SIZES.REALTIME}
        />
      </div>
    );
  }, [timeWindow, paused, filterBlockHeight]);

  // Don't render visualization panel if toggled off
  if (!isPanelVisible) {
    return null;
  }

  // For historical blocks, don't render the side panel
  if (isHistoricalBlock) {
    return null;
  }

  return (
    <div 
      ref={panelRef}
      className="h-full bg-background border-r border-border relative flex-shrink-0"
      style={{ width: `${width}px`, color: '#9d9d9d' }}
    >

      {/* Resize handle */}
      <div 
        ref={resizeHandleRef}
        className="absolute top-0 left-0 w-4 h-full cursor-ew-resize z-10 group flex items-center justify-center"
        style={{ transform: 'translateX(-50%)' }}
      >
        <div className="w-1 h-full bg-gray-700/60 group-hover:bg-gray-400">
          {/* Resize grip indicator */}
          <div className="absolute left-1/2 top-1/2 transform -translate-y-1/2 -translate-x-1/2 flex flex-col gap-1.5">
            <div className="w-1 h-8 rounded-full bg-gray-400 group-hover:bg-gray-400"></div>
            <div className="w-1 h-8 rounded-full bg-gray-400 group-hover:bg-gray-400"></div>
          </div>
        </div>
      </div>
      
      {/* Visualization content */}
      <div className="pt-2 px-4 pb-4 h-[calc(100%-60px)] overflow-auto w-full">
        {/* Timing chart */}
        {renderPoolTimingChart()}
      </div>
    </div>
  );
} 