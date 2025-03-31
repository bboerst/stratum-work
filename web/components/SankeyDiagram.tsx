"use client";

import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { sankey, sankeyLinkHorizontal } from "d3-sankey";
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
    nodeStroke: '#2d3748',
    textStroke: '#000000',  // Add text stroke color
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
      nodeStroke: isDark ? '#4a5568' : '#2d3748',
      textStroke: isDark ? '#000000' : '#000000',  // Keep black stroke in both themes
      link: isDark ? 'rgba(160, 174, 192, 0.5)' : 'rgba(100, 116, 139, 0.5)',
      statusLive: isDark ? '#68d391' : '#48bb78',
      statusPaused: isDark ? '#f6ad55' : '#ed8936',
      error: isDark ? '#fc8181' : '#f56565',
    });
  }, [resolvedTheme]);
  
  // Generate a color from a hash string
  const getColorFromHash = (hash: string): string => {
    // Use first 6 characters of the hash for color
    const truncatedHash = hash.substring(0, 6).toLowerCase();
    // Convert to HSL for better control over lightness
    const hue = parseInt(truncatedHash.substring(0, 2), 16) * 360 / 255;
    const saturation = 70; // Fixed saturation for consistency
    const lightness = resolvedTheme === 'dark' ? 65 : 45; // Adjust lightness based on theme
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  };
  
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
      
      // Clear the SVG and remove any existing tooltips
      d3.select(svgRef.current).selectAll("*").remove();
      d3.select(containerRef.current).selectAll(".sankey-tooltip").remove();
      
      // Check if we have data to render
      if (data.nodes.length === 0) {
        renderEmptyDiagram();
        return;
      }
      
      // Create the Sankey generator - cast to any to avoid TypeScript errors
      const sankeyGenerator = sankey() as any;
      sankeyGenerator
        .nodeWidth(20)  // Increased from 15 to accommodate labels better
        .nodePadding(15)  // Increased from 10 for better spacing
        .extent([[1, 5], [width - 1, height - 5]]);  // Remove left margin
      
      // Convert our data format to D3's expected format
      const sankeyData = {
        nodes: data.nodes.map((node, i) => ({
          name: node.name,
          type: node.type,
          id: i,
          branchIndex: node.branchIndex
        })),
        links: data.links.map(link => ({
          source: typeof link.source === 'string' ? parseInt(link.source) : link.source,
          target: typeof link.target === 'string' ? parseInt(link.target) : link.target,
          value: link.value
        }))
      };
      
      // Generate the layout - cast to any to avoid TypeScript errors
      const { nodes, links } = sankeyGenerator(sankeyData) as any;
      
      // Create the SVG elements
      const svg = d3.select(svgRef.current);
      
      // Set background color via d3 after hydration
      svg.style("background-color", colors.background);
      
      // Add links
      svg.append("g")
        .selectAll("path")
        .data(links)
        .join("path")
        .attr("d", sankeyLinkHorizontal() as any)
        .attr("stroke", colors.link)
        .attr("stroke-width", (d: any) => Math.max(1, d.width))
        .attr("fill", "none")
        .attr("opacity", 0.7);
      
      // Create a tooltip div that is hidden by default
      const tooltip = d3.select(containerRef.current)
        .append("div")
        .attr("class", "sankey-tooltip") // Add a class for easier selection/removal
        .style("position", "absolute")
        .style("visibility", "hidden")
        .style("background-color", "rgba(0, 0, 0, 0.8)")
        .style("color", "white")
        .style("padding", "5px 10px")
        .style("border-radius", "4px")
        .style("font-size", "12px")
        .style("pointer-events", "none")
        .style("z-index", "100")
        .style("transition", "0.2s opacity");
      
      // Format node label
      const formatNodeLabel = (node: any): string => {
        if (node.type === 'pool') return node.name;
        // For merkle branches, format as MB{index}-{first 6 chars}
        const hashStart = node.name.substring(0, 6).toLowerCase();
        return `MB${node.branchIndex}-${hashStart}`;
      };
      
      // Find pools that use this node
      const findConnectedPools = (node: any): string[] => {
        // For pool nodes, there are no "used by pools" (they are pools themselves)
        if (node.type === 'pool') return [];
        
        // For branch nodes, find all pools that use this branch
        const connectedPools = new Set<string>();
        
        // Check all links for connections to this node
        links.forEach((link: any) => {
          // This node could be either source or target in the link
          if (link.source.index === node.index || link.target.index === node.index) {
            // Get the source and target indices from the link
            const sourceIdx = link.source.index;
            const targetIdx = link.target.index;
            
            // Get pools from sankey processor
            const pools = sankeyDataProcessor.getPoolsForConnection(sourceIdx, targetIdx);
            pools.forEach((pool: string) => connectedPools.add(pool));
          }
        });
        
        return Array.from(connectedPools).sort();
      };
      
      // Find the rightmost x position to identify final column
      const maxX = Math.max(...nodes.map((n: any) => n.x0 || 0));
      
      // Add nodes
      const nodeGroup = svg.append("g")
        .selectAll("g")
        .data(nodes)
        .join("g")
        .attr("transform", (d: any) => `translate(${d.x0 || 0},${d.y0 || 0})`);
      
      // Add node rectangles with hover functionality
      nodeGroup.append("rect")
        .attr("width", (d: any) => (d.x1 || 0) - (d.x0 || 0))
        .attr("height", (d: any) => (d.y1 || 0) - (d.y0 || 0))
        .attr("fill", (d: any) => {
          if (d.type === 'pool') return colors.poolNode;
          // Use hash-based color for merkle branch nodes
          return getColorFromHash(d.name);
        })
        .attr("stroke", colors.nodeStroke)
        .attr("cursor", "pointer")
        .on("mouseover", function(event: MouseEvent, d: any) {
          const label = formatNodeLabel(d);
          
          // Find pools connected to this node
          const connectedPools = findConnectedPools(d);
          
          // Create tooltip content
          let tooltipContent = `<div style="font-weight: bold;">${label}</div>`;
          
          // Add pool list if there are any
          if (connectedPools.length > 0) {
            tooltipContent += `<div style="margin-top: 5px;">Used by pools:</div>`;
            tooltipContent += `<ul style="margin: 2px 0 0 -25px; padding-left: 20px;">`;
            connectedPools.forEach((pool: string) => {
              tooltipContent += `<li>${pool}</li>`;
            });
            tooltipContent += `</ul>`;
          }
          
          tooltip
            .style("visibility", "visible")
            .style("opacity", 1)
            .html(tooltipContent);
            
          // Position the tooltip with smart boundary detection
          positionTooltip(event);
        })
        .on("mousemove", function(event: MouseEvent) {
          // Update tooltip position with smart boundary detection
          positionTooltip(event);
        })
        .on("mouseout", function() {
          tooltip
            .style("visibility", "hidden")
            .style("opacity", 0);
        });
      
      // Function to position tooltip with boundary detection
      function positionTooltip(event: MouseEvent) {
        const [x, y] = d3.pointer(event, containerRef.current);
        
        // Get container and tooltip dimensions
        const containerRect = containerRef.current?.getBoundingClientRect();
        if (!containerRect) return;
        
        // Show the tooltip to calculate its dimensions
        tooltip.style("visibility", "visible");
        const tooltipRect = tooltip.node()?.getBoundingClientRect();
        if (!tooltipRect) return;
        
        // Default offset
        let xOffset = 10;
        let yOffset = -25;
        
        // Check if tooltip would go off the right edge
        if (x + xOffset + tooltipRect.width > containerRect.width) {
          // Position to the left of the cursor instead
          xOffset = -tooltipRect.width - 10;
        }
        
        // Check if tooltip would go off the bottom edge
        if (y + yOffset + tooltipRect.height > containerRect.height) {
          // Position above the cursor, or at least fully in view
          yOffset = -Math.min(y, tooltipRect.height + 10);
        }
        
        // Check if tooltip would go off the top edge
        if (y + yOffset < 0) {
          // Position below the cursor
          yOffset = 10;
        }
        
        // Apply the calculated position
        tooltip
          .style("left", `${x + xOffset}px`)
          .style("top", `${y + yOffset}px`);
      }
      
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
      // First remove any lingering tooltips
      d3.select(containerRef.current).selectAll(".sankey-tooltip").remove();
      processRealData();
    }
  }, [stratumV1Data, paused]);
  
  // Re-render when paused state changes
  useEffect(() => {
    // Ensure tooltips are cleared when paused state changes
    d3.select(containerRef.current).selectAll(".sankey-tooltip").remove();
    renderDiagram();
  }, [paused]);
  
  // Re-render when theme/colors change
  useEffect(() => {
    // Ensure tooltips are cleared when colors change
    d3.select(containerRef.current).selectAll(".sankey-tooltip").remove();
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