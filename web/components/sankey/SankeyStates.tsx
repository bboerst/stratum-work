"use client";

import React, { useEffect } from "react";
import * as d3 from "d3";

interface SankeyStatesProps {
  // State flags
  error: string | null;
  isConnected: boolean;
  hasData: boolean;
  
  // Rendering props
  svgRef: React.RefObject<SVGSVGElement | null>;
  width: number;
  height: number;
  colors: {
    background: string;
    text: string;
    error: string;
  };
}

export default function SankeyStates({
  error,
  isConnected,
  hasData,
  svgRef,
  width,
  height,
  colors,
}: SankeyStatesProps) {
  
  // Effect to handle empty state rendering
  useEffect(() => {
    // Render empty diagram with message to SVG
    const renderEmptyDiagram = () => {
      if (!svgRef.current) return;
      
      // Clear the SVG
      d3.select(svgRef.current).selectAll("*").remove();
      
      // Set background color via d3
      d3.select(svgRef.current).style("background-color", colors.background);
      
      // Display a message if no data
      d3.select(svgRef.current)
        .append("text")
        .attr("x", width / 2)
        .attr("y", height / 2)
        .attr("text-anchor", "middle")
        .attr("fill", colors.text)
        .attr("font-size", "16px")
        .text("No data available");
    };

    if (!error && hasData === false) {
      renderEmptyDiagram();
    }
  }, [error, hasData, width, height, colors, svgRef]);

  return (
    <>
      {/* Error state */}
      {error && (
        <div className="absolute top-0 left-0 right-0 bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 p-2 text-sm z-10">
          {error}
        </div>
      )}
      
      {/* Connection status */}
      {!isConnected && !hasData && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 p-4 rounded-lg z-10">
          Connecting to data stream...
        </div>
      )}
    </>
  );
}
