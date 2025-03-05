"use client";

import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { sankey, sankeyLinkHorizontal, SankeyNode as D3SankeyNode, SankeyLink as D3SankeyLink } from "d3-sankey";
import { sankeyDataProcessor, SankeyData, StratumV1Event } from "@/lib/sankeyDataProcessor";
import { eventSourceService } from "@/lib/eventSourceService";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from "@/lib/types";

interface SankeyDiagramProps {
  width: number;
  height: number;
  useSampleData: boolean;
  eventSourceUrl: string;
  data?: any[]; 
}

export function SankeyDiagram({ 
  width, 
  height,
  useSampleData,
  eventSourceUrl,
  data = [] 
}: SankeyDiagramProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const { filterByType } = useGlobalDataStream();
  
  const stratumV1Data = data.length > 0 ? data : filterByType(StreamDataType.STRATUM_V1);
  
  const initializeDiagram = () => {
    try {
      sankeyDataProcessor.reset();
      
      if (useSampleData) {
        sankeyDataProcessor.processSampleData();
        renderDiagram();
      } else if (stratumV1Data.length > 0) {
        processRealData();
      }
      
      setError(null);
    } catch (err) {
      console.error("Error initializing diagram:", err);
      setError(`Error initializing diagram: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  
  const processRealData = () => {
    try {
      console.log("Processing real data:", stratumV1Data);
      
      stratumV1Data.forEach((event: StratumV1Event) => {
        sankeyDataProcessor.processStratumV1Event(event);
      });
      
      renderDiagram();
      
      setIsConnected(true);
    } catch (err) {
      console.error("Error processing real data:", err);
      setError(`Error processing real data: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  
  const renderDiagram = () => {
    if (!svgRef.current) return;
    
    try {
      const data = sankeyDataProcessor.getSankeyData();
      
      d3.select(svgRef.current).selectAll("*").remove();
      
      if (data.nodes.length === 0) {
        d3.select(svgRef.current)
          .append("text")
          .attr("x", width / 2)
          .attr("y", height / 2)
          .attr("text-anchor", "middle")
          .text("No data available. Try connecting to a data source.");
        return;
      }
      
      const sankeyGenerator = sankey<D3SankeyNode, D3SankeyLink>()
        .nodeWidth(15)
        .nodePadding(10)
        .extent([[1, 5], [width - 1, height - 5]]);
      
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
      
      const { nodes, links } = sankeyGenerator(sankeyData);
      
      const svg = d3.select(svgRef.current);
      
      svg.append("g")
        .selectAll("path")
        .data(links)
        .join("path")
        .attr("d", sankeyLinkHorizontal())
        .attr("stroke", "#aaa")
        .attr("stroke-width", d => Math.max(1, d.width))
        .attr("fill", "none")
        .attr("opacity", 0.5);
      
      const nodeGroup = svg.append("g")
        .selectAll("g")
        .data(nodes)
        .join("g")
        .attr("transform", d => `translate(${d.x0},${d.y0})`);
      
      nodeGroup.append("rect")
        .attr("width", d => d.x1 - d.x0)
        .attr("height", d => d.y1 - d.y0)
        .attr("fill", d => (d as any).type === 'pool' ? "#1f77b4" : "#ff7f0e")
        .attr("stroke", "#000");
      
      nodeGroup.append("text")
        .attr("x", d => (d.x1 - d.x0) / 2)
        .attr("y", d => (d.y1 - d.y0) / 2)
        .attr("dy", "0.35em")
        .attr("text-anchor", "middle")
        .text(d => d.name)
        .attr("font-size", "10px")
        .attr("fill", "white");
      
      svg.append("text")
        .attr("x", 10)
        .attr("y", 20)
        .attr("font-size", "12px")
        .attr("fill", isConnected ? "green" : "gray")
        .text(isConnected ? "Connected to live data" : "Using sample data");
      
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
  
  const handleEvent = (event: any) => {
    try {
      console.log("Received event:", event);
      sankeyDataProcessor.processEvent(event);
      renderDiagram();
    } catch (err) {
      console.error("Error processing event:", err);
      setError(`Error processing event: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  
  useEffect(() => {
    if (!useSampleData && stratumV1Data.length > 0) {
      sankeyDataProcessor.reset();
      processRealData();
    }
  }, [useSampleData, stratumV1Data]);
  
  useEffect(() => {
    if (!useSampleData) {
      try {
        eventSourceService.onEvent(handleEvent);
        setIsConnected(!useSampleData);
      } catch (err) {
        console.error("Error connecting to EventSource:", err);
        setError(`Error connecting to EventSource: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    return () => {
      eventSourceService.offEvent(handleEvent);
    };
  }, [useSampleData, eventSourceUrl]);
  
  useEffect(() => {
    initializeDiagram();
  }, []);
  
  return (
    <div className="relative">
      {error && (
        <div className="absolute top-0 left-0 right-0 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
          <strong className="font-bold">Error: </strong>
          <span className="block sm:inline">{error}</span>
        </div>
      )}
      <svg 
        ref={svgRef} 
        width={width} 
        height={height}
        className="border border-gray-300 rounded-lg bg-white"
      />
    </div>
  );
}