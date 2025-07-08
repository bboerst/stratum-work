"use client";

import React, { useRef, useState, useEffect, useMemo } from 'react';
import { StreamData, StreamDataType, StratumV1Data, BaseStreamData } from '@/lib/types';
import { useSankeyColors } from '@/hooks/useSankeyColors';
import { sankeyDataProcessor } from '@/lib/sankeyDataProcessor';
import { getBranchColor } from '@/utils/sankeyColors';
import { useTheme } from 'next-themes';
import { useRenderDiagram } from "@/hooks/useRenderDiagram";
import SankeyTooltip, { TooltipData } from './sankey/SankeyTooltip';
import SankeyStates from './sankey/SankeyStates';
import { useSankeyControls } from '@/hooks/useSankeyControls';

interface SankeyDiagramProps {
  height: number;
  data?: StreamData[]; // StreamData array (will extract StratumV1Data internally)
  showLabels?: boolean;
  onDataRendered?: (nodeCount: number, linkCount: number) => void;
}

export default function SankeyDiagram({ 
  height,
  data = [], 
  showLabels = false,
  onDataRendered,
}: SankeyDiagramProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(1000); 
  const [tooltipData, setTooltipData] = useState<TooltipData>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
  
  // Use our custom hooks
  const colors = useSankeyColors();
  const { 
    error, 
    setError, 
    isConnected, 
    paused, 
    stratumV1Data 
  } = useSankeyControls({ data });
  
  // Access theme for conditional rendering if needed
  const { theme } = useTheme();
  
  // Extract StratumV1Data from StreamData (handle type conversion at component boundary)
  const extractedStratumV1Data = useMemo(() => {
    if (data && data.length > 0) {
      // Extract StratumV1Data from provided StreamData
      return data
        .filter((item): item is BaseStreamData & { type: StreamDataType.STRATUM_V1, data: StratumV1Data } => 
          item.type === StreamDataType.STRATUM_V1
        )
        .map(item => item.data);
    }
    return [];
  }, [data]);
  
  // Auto-detect data source: use static data prop if provided, otherwise live EventSource data  
  const actualStratumV1Data = extractedStratumV1Data.length > 0 ? extractedStratumV1Data : stratumV1Data;
  
  // Update width when container size changes
  useEffect(() => {
    if (!containerRef.current) return;
    
    const updateWidth = () => {
      if (containerRef.current) {
        const newWidth = containerRef.current.clientWidth;
        setWidth(newWidth);
      }
    };
    
    // Initial width
    updateWidth();
    
    // Add resize listener
    window.addEventListener('resize', updateWidth);
    
    // Cleanup
    return () => {
      window.removeEventListener('resize', updateWidth);
    };
  }, []);
 
  // Use the custom hook for rendering
  const renderDiagram = useRenderDiagram({
    svgRef,
    containerRef,
    width,
    height,
    colors,
    theme,
    showLabels,
    onDataRendered,
    setTooltipData,
    setTooltipPosition,
    setError,
    sankeyDataProcessor,
    getBranchColor
  });
  
  // Consolidated useEffect for all rendering triggers
  useEffect(() => {
    if (actualStratumV1Data.length > 0) {
      // Clear tooltips when any major state changes to prevent stale tooltips
      setTooltipData(null);
      setTooltipPosition(null);
      renderDiagram();
    }
  }, [actualStratumV1Data, paused, showLabels, colors, renderDiagram]);
  
  return (
    <div 
      ref={containerRef} 
      className="w-full h-full relative bg-white dark:bg-gray-900 rounded-lg overflow-hidden"
      style={{ height: `${height}px` }} 
    >
      {/* Handle error, empty, and connection states */}
      <SankeyStates
        error={error}
        isConnected={isConnected}
        hasData={actualStratumV1Data.length > 0}
        svgRef={svgRef}
        width={width}
        height={height}
        colors={colors}
      />
      
      <svg 
        ref={svgRef} 
        width={width} 
        height={height}
        className="w-full h-full border border-gray-200 dark:border-gray-700 rounded-lg"
        style={{ display: 'block' }} 
      />
      
      {/* Render the SankeyTooltip component */}
      <SankeyTooltip 
        data={tooltipData}
        position={tooltipPosition}
        containerRef={containerRef as React.RefObject<HTMLDivElement>}
        colors={colors}
      />
    </div>
  );
}