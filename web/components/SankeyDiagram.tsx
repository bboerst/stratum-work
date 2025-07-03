"use client";

import React, { useEffect, useRef } from "react";
import * as d3 from "d3";
import { sankey, sankeyLinkHorizontal } from "d3-sankey";

/**
 * SankeyDiagram Component
 * 
 * This component provides a Sankey diagram visualization using d3-sankey.
 * It displays a simple example of data flow between nodes.
 */

interface SankeyDiagramProps {
  width: number;
  height: number;
}

// Define the node and link types for the Sankey diagram
interface SankeyNode extends d3.SankeyNodeMinimal<SankeyNode, SankeyLink> {
  name: string;
}

interface SankeyLink extends d3.SankeyLinkMinimal<SankeyNode, SankeyLink> {
  value: number;
}

export function SankeyDiagram({
  width,
  height
}: SankeyDiagramProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  // Sample data for the Sankey diagram
  const data = {
    nodes: [
      { name: "Miner 1" },
      { name: "Miner 2" },
      { name: "Miner 3" },
      { name: "Pool 1" },
      { name: "Pool 2" },
      { name: "Network" }
    ],
    links: [
      { source: 0, target: 3, value: 20 },
      { source: 1, target: 3, value: 15 },
      { source: 1, target: 4, value: 5 },
      { source: 2, target: 4, value: 25 },
      { source: 3, target: 5, value: 35 },
      { source: 4, target: 5, value: 30 }
    ]
  };

  useEffect(() => {
    if (!svgRef.current) return;

    // Clear any existing content
    d3.select(svgRef.current).selectAll("*").remove();

    // Set up the Sankey generator
    const sankeyGenerator = sankey<SankeyNode, SankeyLink>()
      .nodeWidth(15)
      .nodePadding(10)
      .extent([[1, 5], [width - 1, height - 5]]);

    // Format the data to match the expected input
    const sankeyData = {
      nodes: data.nodes.map(d => Object.assign({}, d)),
      links: data.links.map(d => Object.assign({}, d))
    };

    // Generate the Sankey layout
    const { nodes, links } = sankeyGenerator(sankeyData);

    // Create the SVG container
    const svg = d3.select(svgRef.current);

    // Add links
    svg.append("g")
      .attr("fill", "none")
      .attr("stroke-opacity", 0.5)
      .selectAll("path")
      .data(links)
      .join("path")
      .attr("d", sankeyLinkHorizontal())
      .attr("stroke", d => {
        // Gradient color based on source and target
        return "#aaa";
      })
      .attr("stroke-width", d => Math.max(1, d.width || 0));

    // Add nodes
    const node = svg.append("g")
      .selectAll("rect")
      .data(nodes)
      .join("rect")
      .attr("x", d => d.x0 || 0)
      .attr("y", d => d.y0 || 0)
      .attr("height", d => (d.y1 || 0) - (d.y0 || 0))
      .attr("width", d => (d.x1 || 0) - (d.x0 || 0))
      .attr("fill", "#69b3a2")
      .attr("stroke", "#000");

    // Add node labels
    svg.append("g")
      .selectAll("text")
      .data(nodes)
      .join("text")
      .attr("x", d => (d.x0 || 0) < width / 2 ? (d.x1 || 0) + 6 : (d.x0 || 0) - 6)
      .attr("y", d => ((d.y1 || 0) + (d.y0 || 0)) / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", d => (d.x0 || 0) < width / 2 ? "start" : "end")
      .text(d => d.name)
      .style("font-size", "10px");

    // Add link value labels
    svg.append("g")
      .selectAll("text")
      .data(links)
      .join("text")
      .attr("x", d => ((d.source.x1 || 0) + (d.target.x0 || 0)) / 2)
      .attr("y", d => ((d.source.y1 || 0) + (d.source.y0 || 0)) / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", "middle")
      .text(d => d.value)
      .style("font-size", "9px")
      .style("fill", "#555");

  }, [width, height]);

  return (
    <div 
      className="w-full h-full border border-gray-200 rounded-md bg-white"
      style={{ width, height }}
    >
      <svg 
        ref={svgRef} 
        width={width} 
        height={height}
        className="overflow-visible"
      />
    </div>
  );
}