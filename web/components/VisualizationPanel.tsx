"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useVisualization } from './VisualizationContext';
import RealtimeChart from './RealtimeChart';
import { PlusIcon, MinusIcon } from 'lucide-react';

// Updated throttle helper function with correct typing
function throttle<T extends (e: MouseEvent) => void>(
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
  const [timeWindow, setTimeWindow] = useState(30); // Default to 30 seconds
  
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // Increment/decrement time window
  const incrementTimeWindow = useCallback(() => {
    setTimeWindow(prev => {
      if (prev < 60) return prev + 15; // Increment by 15 seconds if < 1 minute
      if (prev < 300) return prev + 60; // Increment by 1 minute if < 5 minutes
      return prev + 300; // Increment by 5 minutes otherwise
    });
  }, []);

  const decrementTimeWindow = useCallback(() => {
    setTimeWindow(prev => {
      if (prev <= 15) return 15; // Minimum 15 seconds
      if (prev <= 60) return prev - 15; // Decrement by 15 seconds if <= 1 minute
      if (prev <= 300) return prev - 60; // Decrement by 1 minute if <= 5 minutes
      return prev - 300; // Decrement by 5 minutes otherwise
    });
  }, []);

  // Format time window for display
  const formatTimeWindow = useCallback((seconds: number): string => {
    if (seconds < 60) {
      return `${seconds}s`;
    } else if (seconds < 3600) {
      return `${Math.floor(seconds / 60)}m`;
    } else {
      return `${Math.floor(seconds / 3600)}h`;
    }
  }, []);

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
  const throttledMouseMove = throttle(handleThrottledMouseMove, 16); // Approximately 60fps

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
      <div className="border border-border rounded-md p-2 bg-card h-[320px] w-full mb-4">
        <RealtimeChart 
          paused={paused} 
          filterBlockHeight={filterBlockHeight}
          timeWindow={timeWindow}
        />
      </div>
    );
  }, [timeWindow, paused, filterBlockHeight]);

  // Check if we should hide the panel for historical blocks
  // When filterBlockHeight exists and is not -1, it's a historical block
  const isHistoricalBlock = filterBlockHeight !== undefined && filterBlockHeight !== -1;

  // Don't render if panel is toggled off or if viewing a historical block
  if (!isPanelVisible || isHistoricalBlock) {
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
      <div className="p-4 h-[calc(100%-60px)] overflow-auto w-full">
        {/* Timing chart */}
        {renderPoolTimingChart()}
      </div>
    </div>
  );
} 