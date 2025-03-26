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
  const { isPanelVisible, isVisualizationActive } = useVisualization();
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
      const delta = e.clientX - startXRef.current;
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

  // Memoized content to avoid unnecessary re-renders
  const chartComponent = useCallback(() => {
    if (!isVisualizationActive('chart')) return null;
    
    return (
      <div className="border border-border rounded-md p-2 bg-card h-[320px] w-full">
        <div className="flex justify-between items-center mb-2">
          <h3 className="text-sm font-medium">Timing</h3>
          <div className="flex items-center space-x-1 text-xs">
            <span className="mr-1">Show last:</span>
            <button 
              onClick={decrementTimeWindow}
              className="p-1 rounded hover:bg-gray-700 text-gray-300" 
              disabled={timeWindow <= 15}
            >
              <MinusIcon size={14} />
            </button>
            <span className="min-w-[36px] text-center">{formatTimeWindow(timeWindow)}</span>
            <button 
              onClick={incrementTimeWindow}
              className="p-1 rounded hover:bg-gray-700 text-gray-300"
            >
              <PlusIcon size={14} />
            </button>
          </div>
        </div>
        <div className="w-full h-[290px]">
          <RealtimeChart 
            paused={paused} 
            filterBlockHeight={filterBlockHeight}
            timeWindow={timeWindow}
          />
        </div>
      </div>
    );
  }, [isVisualizationActive, decrementTimeWindow, incrementTimeWindow, formatTimeWindow, timeWindow, paused, filterBlockHeight]);

  if (!isPanelVisible) {
    return null;
  }

  return (
    <div 
      ref={panelRef}
      className="h-full bg-background border-r border-border relative flex-shrink-0"
      style={{ width: `${width}px` }}
    >
      <div 
        ref={resizeHandleRef}
        className="absolute top-0 right-0 w-2 h-full bg-gray-500/25 cursor-ew-resize hover:bg-primary/50 active:bg-primary z-10 flex items-center justify-center"
        style={{ transform: 'translateX(50%)' }}
      >
        <div className="h-16 w-full flex flex-col justify-center items-center gap-1">
          <div className="w-0.5 h-6 bg-gray-400"></div>
          <div className="w-0.5 h-6 bg-gray-400"></div>
        </div>
      </div>
      
      <div className="p-4 h-full overflow-auto w-full viz-column-wrapper">
        <div className="space-y-4 w-full">
          {chartComponent()}
          
          {/* Future visualizations can be added here */}
        </div>
      </div>
    </div>
  );
} 