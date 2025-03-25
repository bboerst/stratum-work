"use client";

import React, { useState, useRef, useEffect } from 'react';
import { useVisualization } from './VisualizationContext';
import RealtimeChart from './RealtimeChart';
import { PlusIcon, MinusIcon } from 'lucide-react';

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
  const [pointsPerPool, setPointsPerPool] = useState(1); // Default to 1 point per pool
  
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  // Increment/decrement points per pool
  const incrementPointsPerPool = () => {
    setPointsPerPool(prev => Math.min(prev + 1, 10)); // Cap at 10 points
  };

  const decrementPointsPerPool = () => {
    setPointsPerPool(prev => Math.max(prev - 1, 1)); // Minimum 1 point
  };

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

    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingRef.current) {
        const delta = e.clientX - startXRef.current;
        let newWidth = startWidthRef.current + delta;
        
        // Apply constraints
        newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
        
        setWidth(newWidth);
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
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [width]);

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
          {isVisualizationActive('chart') && (
            <div className="border border-border rounded-md p-2 bg-card h-[320px] w-full">
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-medium">Timing</h3>
                <div className="flex items-center space-x-1 text-xs">
                  <span className="mr-1">Show last:</span>
                  <button 
                    onClick={decrementPointsPerPool}
                    className="p-1 rounded hover:bg-gray-700 text-gray-300" 
                    disabled={pointsPerPool <= 1}
                  >
                    <MinusIcon size={14} />
                  </button>
                  <span className="min-w-[18px] text-center">{pointsPerPool}</span>
                  <button 
                    onClick={incrementPointsPerPool}
                    className="p-1 rounded hover:bg-gray-700 text-gray-300"
                    disabled={pointsPerPool >= 10}
                  >
                    <PlusIcon size={14} />
                  </button>
                </div>
              </div>
              <div className="w-full h-[290px]">
                <RealtimeChart 
                  paused={paused} 
                  filterBlockHeight={filterBlockHeight}
                  height={290}
                  maxPointsPerPool={pointsPerPool}
                />
              </div>
            </div>
          )}
          
          {/* Future visualizations can be added here */}
        </div>
      </div>
    </div>
  );
} 