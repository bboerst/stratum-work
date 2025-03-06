"use client";

import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { sankey, sankeyLinkHorizontal, SankeyNode as D3SankeyNode, SankeyLink as D3SankeyLink } from "d3-sankey";
import { sankeyDataProcessor, SankeyData, StratumV1Event } from "@/lib/sankeyDataProcessor";
import { eventSourceService } from "@/lib/eventSourceService";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from "@/lib/types";

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
      
      // Add links
      svg.append("g")
        .selectAll("path")
        .data(links)
        .join("path")
        .attr("d", sankeyLinkHorizontal())
        .attr("stroke", "#aaa")
        .attr("stroke-width", d => Math.max(1, d.width))
        .attr("fill", "none")
        .attr("opacity", 0.5);
      
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
        .attr("fill", d => (d as any).type === 'pool' ? "#1f77b4" : "#ff7f0e")
        .attr("stroke", "#000");
      
      // Add node labels
      nodeGroup.append("text")
        .attr("x", d => (d.x1 - d.x0) / 2)
        .attr("y", d => (d.y1 - d.y0) / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", "middle")
        .text(d => d.name)
        .attr("font-size", "10px")
        .attr("fill", "white");
      
      // Add status indicators
      svg.append("text")
        .attr("x", 10)
        .attr("y", 20)
        .attr("font-size", "12px")
        .attr("fill", paused ? "orange" : "green")
        .text(paused ? "Data stream paused" : "Live data stream");
      
      // Add data count indicator
      svg.append("text")
        .attr("x", 10)
        .attr("y", 40)
        .attr("font-size", "12px")
        .attr("fill", "#333")
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
          .attr("fill", "red")
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
  
  // Connect to EventSource API
  useEffect(() => {
    try {
      // Register event handler
      eventSourceService.onEvent(handleEvent);
      setIsConnected(true);
    } catch (err) {
      console.error("Error connecting to EventSource:", err);
      setError(`Error connecting to EventSource: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // Clean up on unmount
    return () => {
      eventSourceService.offEvent(handleEvent);
    };
  }, []);
  
  // Initialize the diagram when the component mounts
  useEffect(() => {
    initializeDiagram();
  }, []);
  
  return (
    <div className="relative w-full" ref={containerRef}>
      {error && (
        <div className="absolute top-0 left-0 right-0 bg-red-100 border border-red-400 text-red-700 rounded">
          <strong className="font-bold">Error: </strong>
          <span className="block sm:inline">{error}</span>
        </div>
      )}
      <div className="w-full">
        <svg 
          ref={svgRef} 
          width="100%"
          height={height}
          className="border border-gray-300 rounded-lg bg-white w-full"
          preserveAspectRatio="xMinYMin meet"
        />
      </div>
    </div>
  );
}