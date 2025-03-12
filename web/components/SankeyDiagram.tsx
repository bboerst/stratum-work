"use client";

import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { sankey, sankeyLinkHorizontal, SankeyNode as D3SankeyNode, SankeyLink as D3SankeyLink } from "d3-sankey";
import { sankeyDataProcessor, SankeyData, StratumV1Event } from "@/lib/sankeyDataProcessor";
import { eventSourceService } from "@/lib/eventSourceService";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from "@/lib/types";
import { useTheme } from "next-themes";

interface SankeyDiagramProps {
  height: number;
  data?: any[]; // Optional data prop
}

export function SankeyDiagram({ 
  height,
  data = [] // Default to empty array
}: SankeyDiagramProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(1000); // Default width
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const { filterByType, paused } = useGlobalDataStream();
  const { theme, resolvedTheme } = useTheme();
  
  // Theme-specific colors - only use these after initial render
  const [colors, setColors] = useState({
    background: '#ffffff',
    text: '#1a202c',
    poolNode: '#2563eb',
    branchNode: '#7c3aed',
    nodeStroke: '#2d3748',
    link: 'rgba(100, 116, 139, 0.5)',
    statusLive: '#48bb78',
    statusPaused: '#ed8936',
    error: '#f56565',
  });
  
  // Update colors when theme changes
  useEffect(() => {
    const isDark = resolvedTheme === 'dark';
    setColors({
      background: isDark ? '#1e1e2f' : '#ffffff',
      text: isDark ? '#e2e8f0' : '#1a202c',
      poolNode: isDark ? '#3182ce' : '#2563eb',
      branchNode: isDark ? '#9f7aea' : '#7c3aed',
      nodeStroke: isDark ? '#4a5568' : '#2d3748',
      link: isDark ? 'rgba(160, 174, 192, 0.5)' : 'rgba(100, 116, 139, 0.5)',
      statusLive: isDark ? '#68d391' : '#48bb78',
      statusPaused: isDark ? '#f6ad55' : '#ed8936',
      error: isDark ? '#fc8181' : '#f56565',
    });
  }, [resolvedTheme]);
  
  // Get stratum V1 data from the global data stream if not provided via props
  const stratumV1Data = data.length > 0 ? data : filterByType(StreamDataType.STRATUM_V1);
  
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
  
  // Initialize or reset the diagram
  const initializeDiagram = () => {
    try {
      // Reset any previous data
      sankeyDataProcessor.reset();
      
      // Process real data if available
      if (stratumV1Data.length > 0) {
        processRealData();
      } else {
        // Display "no data" message
        renderEmptyDiagram();
      }
      
      // Clear any previous errors
      setError(null);
    } catch (err) {
      console.error("Error initializing diagram:", err);
      setError(`Error initializing diagram: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  
  // Process data from the global data stream
  const processRealData = () => {
    try {
      console.log("Processing data:", stratumV1Data);
      // Process each event
      stratumV1Data.forEach((event: StratumV1Event) => {
        sankeyDataProcessor.processStratumV1Event(event);
      });
      renderDiagram();
      setIsConnected(true);
    } catch (err) {
      console.error("Error processing data:", err);
      setError(`Error processing data: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  
  // Render an empty diagram with a message
  const renderEmptyDiagram = () => {
    if (!svgRef.current) return;
    
    // Clear the SVG
    d3.select(svgRef.current).selectAll("*").remove();
    
    // Display a message if no data
    d3.select(svgRef.current)
      .append("text")
      .attr("x", width / 2)
      .attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("fill", colors.text)
      .text("No data available. Waiting for events...");
  };
  
  // Render the Sankey diagram
  const renderDiagram = () => {
    if (!svgRef.current) return;
    
    try {
      // Get data from the processor
      const data = sankeyDataProcessor.getSankeyData();
      
      // Clear the SVG
      d3.select(svgRef.current).selectAll("*").remove();
      
      // Check if we have data to render
      if (data.nodes.length === 0) {
        renderEmptyDiagram();
        return;
      }
      
      // Create the Sankey generator
      const sankeyGenerator = sankey<D3SankeyNode, D3SankeyLink>()
        .nodeWidth(15)
        .nodePadding(10)
        .extent([[1, 5], [width - 1, height - 5]]);
      
      // Convert our data format to D3's expected format
      const sankeyData = {
        nodes: data.nodes.map((node, i) => ({
          name: node.name,
          type: node.type,
          id: i
        })),
        links: data.links.map(link => ({
          source: typeof link.source === 'string' ? parseInt(link.source) : link.source,
          target: typeof link.target === 'string' ? parseInt(link.target) : link.target,
          value: link.value
        }))
      };
      
      // Generate the layout
      const { nodes, links } = sankeyGenerator(sankeyData);
      
      // Create the SVG elements
      const svg = d3.select(svgRef.current);
      
      // Set background color via d3 after hydration
      svg.style("background-color", colors.background);
      
      // Add links
      svg.append("g")
        .selectAll("path")
        .data(links)
        .join("path")
        .attr("d", sankeyLinkHorizontal())
        .attr("stroke", colors.link)
        .attr("stroke-width", d => Math.max(1, d.width))
        .attr("fill", "none")
        .attr("opacity", 0.7);
      
      // Add nodes
      const nodeGroup = svg.append("g")
        .selectAll("g")
        .data(nodes)
        .join("g")
        .attr("transform", d => `translate(${d.x0},${d.y0})`);
      
      // Add node rectangles
      nodeGroup.append("rect")
        .attr("width", d => d.x1 - d.x0)
        .attr("height", d => d.y1 - d.y0)
        .attr("fill", d => (d as any).type === 'pool' ? colors.poolNode : colors.branchNode)
        .attr("stroke", colors.nodeStroke);
      
      // Add node labels
      nodeGroup.append("text")
        .attr("x", d => (d.x1 - d.x0) / 2)
        .attr("y", d => (d.y1 - d.y0) / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", "middle")
        .text(d => d.name)
        .attr("font-size", "10px")
        .attr("fill", "white") // Keep text white for better contrast on colored nodes
        .attr("pointer-events", "none"); // Prevent text from interfering with interactions
      
      // Add status indicators
      svg.append("text")
        .attr("x", 10)
        .attr("y", 20)
        .attr("font-size", "12px")
        .attr("fill", paused ? colors.statusPaused : colors.statusLive)
        .text(paused ? "Data stream paused" : "Live data stream");
      
      // Add data count indicator
      svg.append("text")
        .attr("x", 10)
        .attr("y", 40)
        .attr("font-size", "12px")
        .attr("fill", colors.text)
        .text(`Nodes: ${data.nodes.length}, Links: ${data.links.length}`);
      
    } catch (err) {
      console.error("Error rendering diagram:", err);
      setError(`Error rendering diagram: ${err instanceof Error ? err.message : String(err)}`);
      
      if (svgRef.current) {
        d3.select(svgRef.current).selectAll("*").remove();
        d3.select(svgRef.current)
          .append("text")
          .attr("x", width / 2)
          .attr("y", height / 2)
          .attr("text-anchor", "middle")
          .attr("fill", colors.error)
          .text(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  
  // Handle events from the EventSource
  const handleEvent = (event: any) => {
    try {
      if (paused) return;
      sankeyDataProcessor.processEvent(event);
      renderDiagram();
    } catch (err) {
      console.error("Error processing event:", err);
      setError(`Error processing event: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  
  // Process global data stream events when they change
  useEffect(() => {
    if (paused) return;
    if (stratumV1Data.length > 0) {
      // Reset data processor first
      sankeyDataProcessor.reset();
      processRealData();
    }
  }, [stratumV1Data, paused]);
  
  // Re-render when paused state changes
  useEffect(() => {
    renderDiagram();
  }, [paused]);
  
  // Re-render when theme/colors change
  useEffect(() => {
    renderDiagram();
  }, [colors]);
  
  // Connect to EventSource API
  useEffect(() => {
    try {
      // Register event handler
      eventSourceService.onEvent(handleEvent);
      setIsConnected(true);
    } catch (err) {
      console.error("Error connecting to EventSource:", err);
      setError(`Error connecting to EventSource: ${err instanceof Error ? err.message : String(err)}`);
      setIsConnected(false);
    }
    
    // Initialize the diagram
    initializeDiagram();
    
    // Cleanup
    return () => {
      try {
        eventSourceService.offEvent(handleEvent);
      } catch (err) {
        console.error("Error disconnecting from EventSource:", err);
      }
    };
  }, []);
  
  return (
    <div 
      ref={containerRef} 
      className="w-full h-full relative bg-white dark:bg-gray-900 rounded-lg overflow-hidden"
      style={{ minHeight: `${height}px` }}
    >
      {error && (
        <div className="absolute top-0 left-0 right-0 bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 p-2 text-sm z-10">
          {error}
        </div>
      )}
      <svg 
        ref={svgRef} 
        width={width} 
        height={height}
        className="w-full h-full border border-gray-200 dark:border-gray-700 rounded-lg"
      />
      {!isConnected && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 p-4 rounded-lg z-10">
          Connecting to data stream...
        </div>
      )}
    </div>
  );
}