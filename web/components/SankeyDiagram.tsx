"use client";

import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import { sankey, sankeyLinkHorizontal, sankeyLeft } from "d3-sankey";
import { sankeyDataProcessor, SankeyData, StratumV1Event } from "@/lib/sankeyDataProcessor";
import { eventSourceService } from "@/lib/eventSourceService";
import { useGlobalDataStream } from "@/lib/DataStreamContext";
import { StreamDataType } from "@/lib/types";
import { useTheme } from "next-themes";
import { getMerkleColor } from '@/utils/colorUtils';

interface SankeyDiagramProps {
  height: number;
  data?: any[];
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
  const [error, setError] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const { filterByType, paused, setPaused } = useGlobalDataStream();
  const { theme, resolvedTheme } = useTheme();
  
  // Theme-specific colors - only use these after initial render
  const [colors, setColors] = useState({
    background: '#ffffff',
    text: '#1a202c',
    poolNode: '#2563eb',
    nodeStroke: '#2d3748',
    textStroke: '#000000',  
    link: 'rgba(100, 116, 139, 0.5)',
    statusLive: '#48bb78',
    statusPaused: '#ed8936',
    error: '#f56565',
    poolLabel: '#ff9500', // Color for pool labels next to last merkle branches
    gridLine: 'rgba(100, 116, 139, 0.3)', // Grid line color for merkle branch indicators
    gridText: 'rgba(26, 32, 44, 0.8)', // Grid text color for branch labels
  });
  
  // Update colors when theme changes
  useEffect(() => {
    const isDark = resolvedTheme === 'dark';
    setColors({
      background: isDark ? '#1e1e2f' : '#ffffff',
      text: isDark ? '#e2e8f0' : '#1a202c',
      poolNode: isDark ? '#3182ce' : '#2563eb',
      nodeStroke: isDark ? '#4a5568' : '#2d3748',
      textStroke: isDark ? '#000000' : '#000000',  
      link: isDark ? 'rgba(160, 174, 192, 0.5)' : 'rgba(100, 116, 139, 0.5)',
      statusLive: isDark ? '#68d391' : '#48bb78',
      statusPaused: isDark ? '#f6ad55' : '#ed8936',
      error: isDark ? '#fc8181' : '#f56565',
      poolLabel: isDark ? '#ff9d4d' : '#ff8000', // Brighter in dark mode, slightly darker in light mode
      gridLine: isDark ? 'rgba(160, 174, 192, 0.3)' : 'rgba(100, 116, 139, 0.3)', // Grid line color for merkle branch indicators
      gridText: isDark ? 'rgba(226, 232, 240, 0.8)' : 'rgba(26, 32, 44, 0.8)', // Grid text color for branch labels
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
    console.log("Processing data:", stratumV1Data.length, "events");
    try {
      if (stratumV1Data.length === 0) return;

      // Process the data for Sankey diagram
      stratumV1Data.forEach(event => {
        try {
          sankeyDataProcessor.processStratumV1Event(event);
        } catch (err) {
          console.error("Error processing event:", err);
        }
      });

      // Render the diagram with the processed data
      renderDiagram();
    } catch (err) {
      console.error("Error processing real data:", err);
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
    try {
      // Clear previous rendering
      if (svgRef.current) {
        d3.select(svgRef.current).selectAll("*").remove();
      }
      
      // Get data from the processor
      const data = sankeyDataProcessor.getSankeyData();
      
      // Remove any existing tooltips (but don't clear SVG again since we just did)
      d3.select(containerRef.current).selectAll(".sankey-tooltip").remove();
      
      // Check if we have data to render
      if (data.nodes.length === 0) {
        renderEmptyDiagram();
        return;
      }
      
      // Calculate right padding to accommodate pool labels
      const poolLabelPadding = 150; // Allocate more space for pool labels on the right

      // --- Dynamic left offset based on widest pool name ---
      let maxPoolNameWidth = 0;
      if (typeof window !== 'undefined') {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.font = '600 14px sans-serif'; // Match pool node label font
          data.nodes.forEach(node => {
            if (node.type === 'pool') {
              const metrics = ctx.measureText(node.name);
              if (metrics.width > maxPoolNameWidth) {
                maxPoolNameWidth = metrics.width;
              }
            }
          });
        }
      }
      const leftOffset = Math.ceil(maxPoolNameWidth * 0.35) + 10; // 10px padding
      
      // Create the Sankey generator - cast to any to avoid TypeScript errors
      const sankeyGenerator = sankey() as any;
      const topPadding = 60;
      const bottomPadding = 60;
      const rightExtent = width - poolLabelPadding + leftOffset / 2; // add half the offset to allow some extra space
      sankeyGenerator
        .nodeWidth(20)  
        .nodePadding(15)  
        .extent([[5 + leftOffset, topPadding], [rightExtent, height - bottomPadding]])  // Reserve space on the right for pool labels
        .nodeAlign(sankeyLeft);  // Use left alignment for more natural depth
        
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
      
      // Notify parent component about node/link counts
      if (onDataRendered && data.nodes && data.links) {
        onDataRendered(data.nodes.length, data.links.length);
      }
      
      // Create the SVG elements
      const svg = d3.select(svgRef.current);
      
      // Set background color via d3 after hydration
      svg.style("background-color", colors.background);
      
      // Find the maximum branch index to determine how many grid lines to draw
      const maxBranchIndex = Math.max(...nodes.map((node: any) => node.branchIndex || 0));
      
      // Calculate the horizontal spacing for grid lines
      const gridGroup = svg.append("g").attr("class", "merkle-branch-grid");
      
      // Add grid lines for each branch index
      for (let i = 0; i <= maxBranchIndex; i++) {
        // Find all nodes with this branch index
        const branchNodes = nodes.filter((node: any) => node.branchIndex === i);
        
        if (branchNodes.length > 0) {
          // Calculate average x position for this branch
          const avgX = d3.mean(branchNodes, (d: any) => (d.x0 + d.x1) / 2);
          
          if (avgX !== undefined) {
            // Add vertical grid line
            gridGroup.append("line")
              .attr("x1", avgX)
              .attr("y1", 0)
              .attr("x2", avgX)
              .attr("y2", height)
              .attr("stroke", colors.gridLine)
              .attr("stroke-dasharray", "3,3")
              .attr("stroke-width", 1);
            
            // Add branch label at the top
            const labelWidth = (width - leftOffset) / (maxBranchIndex + 1) * 0.8;
            
            // Adjust label text based on available space
            const labelText = labelWidth < 100 ? `MB ${i}` : `Merkle Branch ${i}`;
            
            gridGroup.append("text")
              .attr("x", avgX)
              .attr("y", 20) // Position at top with some padding
              .attr("text-anchor", "middle")
              .attr("fill", colors.gridText)
              .attr("font-size", "12px")
              .attr("font-weight", 500)
              .text(labelText);
          }
        }
      }
      
      
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
        .attr("class", "sankey-tooltip") 
        .style("position", "absolute")
        .style("visibility", "hidden")
        .style("background-color", "rgba(0, 0, 0, 0.8)")
        .style("color", "white")
        .style("padding", "5px 10px")
        .style("border-radius", "4px")
        .style("font-size", "12px")
        .style("pointer-events", "auto")
        .style("z-index", "100")
        .style("transition", "0.2s opacity");
      
      // Format node label
      const formatNodeLabel = (node: any): string => {
        if (node.type === 'pool') return node.name;
        // For merkle branches, just show the hash part without the MB prefix
        return node.name.substring(0, 6).toLowerCase();
      };
      
      // Find pools that use this node
      const findConnectedPools = (node: any): string[] => {
        // For pool nodes, there are no "used by pools" (they are pools themselves)
        if (node.type === 'pool') return [];
        
        // For branch nodes, get all pools that use this merkle branch
        if (node.type === 'branch') {
          try {
            // Use the comprehensive method we added to data processor
            // This checks both direct links and pool-to-branch relationships
            const poolsUsingBranch = sankeyDataProcessor.getPoolsUsingMerkleBranch(node.name);
            return poolsUsingBranch; // Already sorted in the method
          } catch (error) {
            console.error('Error finding connected pools:', error);
            return [];
          }
        }
        
        return [];
      };
      
      // Function to identify the last merkle branch for each pool using direct data from SankeyDataProcessor
      const findLastBranchesForPools = (): Map<number, string[]> => {
        const branchesToPools = new Map<number, string[]>();
        
        // Get pool to last merkle branch map directly from data processor
        const poolToLastBranch = sankeyDataProcessor.getLastMerkleBranchesForPools();
        
        // Create a map from branch name to node index for quick lookups
        const branchNameToIndex = new Map<string, number>();
        nodes.forEach((node: any, index: number) => {
          if (node.type === 'branch') {
            branchNameToIndex.set(node.name, index);
          }
        });

        // Get nodeIndex by name without case sensitivity
        const getNodeIndexByName = (name: string): number | undefined => {
          // Check for exact match first
          if (branchNameToIndex.has(name)) {
            return branchNameToIndex.get(name);
          }
          
          // If no exact match, try case-insensitive comparison
          const lowerName = name.toLowerCase();
          for (const [key, index] of branchNameToIndex.entries()) {
            if (key.toLowerCase() === lowerName) {
              return index;
            }
          }
          
          return undefined;
        };
        
        // Log what we're finding
        console.log("Last branches for pools:", Object.fromEntries(poolToLastBranch));
        
        // Map each pool's last branch to its node index
        poolToLastBranch.forEach((branchName, poolName) => {
          // Find the node index for this branch name
          const nodeIndex = getNodeIndexByName(branchName);
          
          if (nodeIndex !== undefined) {
            // If we find the node, associate it with this pool
            if (!branchesToPools.has(nodeIndex)) {
              branchesToPools.set(nodeIndex, [poolName]);
            } else {
              branchesToPools.get(nodeIndex)!.push(poolName);
            }
            console.log(`Found last branch for pool ${poolName}: ${branchName} (node index ${nodeIndex})`);
          } else {
            console.warn(`Could not find node index for branch ${branchName} (pool ${poolName})`);
          }
        });
        
        return branchesToPools;
      };
      
      // Get map of last branches to their pools
      const lastBranchesMap = findLastBranchesForPools();
      
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
          // Use the utility function to get a consistent color with caching
          return getMerkleColor(d.name);
        })
        .attr("stroke", colors.nodeStroke)
        .attr("cursor", "pointer")
        .on("click", function(event: MouseEvent, d: any) {
          // Only copy for merkle branch nodes, not pool nodes
          if (d.type !== 'pool') {
            const fullHash = d.name.toLowerCase();
            navigator.clipboard.writeText(fullHash).then(() => {
              // Provide visual feedback that hash was copied
              d3.select(this)
                .attr("stroke", "#00ff00") // Green stroke for visual feedback
                .attr("stroke-width", 2);
              
              // Reset after a short delay
              setTimeout(() => {
                d3.select(this)
                  .attr("stroke", colors.nodeStroke)
                  .attr("stroke-width", 1);
              }, 1000);
            });
          }
        })
        .on("mouseover", function(event: MouseEvent, d: any) {
          const label = formatNodeLabel(d);
          
          // Find pools connected to this node
          const connectedPools = findConnectedPools(d);
          
          // Create tooltip content
          let tooltipContent = '';
          
          if (d.type === 'pool') {
            tooltipContent = `<div style="font-weight: bold;">${label}</div>`;
          } else {
            // For Merkle branches, show formatted content with indentation
            const fullHash = d.name.toLowerCase();
            const hashStart = fullHash.substring(0, 6);
            
            tooltipContent = `
              <div style="font-weight: bold;">
                Merkle Branch ${d.branchIndex}:<br>
                <div style="padding-left: 10px; display: flex; align-items: center; margin: 2px 0;">
                  <span style="margin-right: 4px;">&gt;</span> ${hashStart}
                </div>
                <div style="font-size: 10px; margin-top: 2px; opacity: 0.8;">(Click to copy full hash)</div>
              </div>
            `;
          }
          
          // Only add pool connections section for branch nodes if there are actual connections
          if (d.type === 'branch') {
            if (connectedPools.length > 0) {
              tooltipContent += `<div style="margin-top: 8px; font-weight: bold;">Pool Connections:</div>`;
              // Display all connected pools
              connectedPools.forEach((pool: string) => {
                tooltipContent += `<div style="padding-left: 10px; display: flex; align-items: center; margin: 2px 0;">
                  <span style="margin-right: 4px;">-</span> ${pool}
                </div>`;
              });
            }
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
      
      // Render pool labels next to the respective last merkle branch nodes
      const renderPoolLabels = () => {
        // Get the direct mapping from pool name to last branch name
        const poolToLastBranchMap = sankeyDataProcessor.getLastMerkleBranchesForPools();
        
        if (poolToLastBranchMap.size === 0) {
          console.warn('No pool to branch mappings found');
          return null;
        }
        
        // Log all pools we're trying to render
        const allPoolNames = Array.from(poolToLastBranchMap.keys());
        console.log('Attempting to render labels for pools:', allPoolNames);
        
        // Create mapping from branch name to node index for quick lookups
        const branchNameToNodeIndex = new Map<string, number>();
        nodes.forEach((node: any, index: number) => {
          if (node.type === 'branch') {
            branchNameToNodeIndex.set(node.name, index);
            // Also add lowercase version for case-insensitive matching
            branchNameToNodeIndex.set(node.name.toLowerCase(), index);
          }
        });
        
        // Calculate global max X for fallback alignment
        const globalMaxX = Math.max(...nodes.map((n: any) => n.x1 || 0)) + 5;
        
        // For vertical spacing management
        const yPositionsByColumn: {[colX: number]: number[]} = {};
        
        // Create an array of pool label elements
        const poolLabels: React.ReactNode[] = [];
        let poolLabelCount = 0;
        
        // Process each pool
        poolToLastBranchMap.forEach((branchName, poolName) => {
          // Find the node index for this branch
          let nodeIndex = branchNameToNodeIndex.get(branchName);
          
          // Try case-insensitive match if needed
          if (nodeIndex === undefined) {
            nodeIndex = branchNameToNodeIndex.get(branchName.toLowerCase());
          }
          
          // Skip if we can't find the node
          if (nodeIndex === undefined) {
            console.warn(`Could not find node for branch ${branchName} (pool ${poolName})`);
            return;
          }
          
          const node = nodes[nodeIndex];
          if (!node) {
            console.warn(`Node index ${nodeIndex} not found for pool ${poolName}`);
            return;
          }
          
          // Calculate position for label - always place next to its actual branch node
          const nodeX = Math.round(node.x1 || 0);
          const labelX = nodeX + 10; // Fixed offset from node
          
          // Initialize the column's y-positions array if it doesn't exist
          if (!yPositionsByColumn[nodeX]) {
            yPositionsByColumn[nodeX] = [];
          }
          
          // Find the node's center y position
          const nodeCenterY = (node.y0 || 0) + ((node.y1 || 0) - (node.y0 || 0)) / 2;
          
          // Find a suitable y position that doesn't overlap with other labels
          let labelY = nodeCenterY;
          const minDistance = 25; // Minimum vertical distance between labels
          
          // Check if this position overlaps with any existing label in this column
          while (yPositionsByColumn[nodeX].some(y => Math.abs(y - labelY) < minDistance)) {
            labelY += minDistance; // Move label down if there would be overlap
          }
          
          // Store this position
          yPositionsByColumn[nodeX].push(labelY);
          
          console.log(`Adding pool label: ${poolName} at position (${labelX},${labelY}) for branch ${branchName} (node index: ${nodeIndex})`);
          
          // Create the label
          poolLabels.push(
            <g key={`pool-label-${poolName}`} className="pool-label">
              {/* Line connecting label to node */}
              <line
                x1={(node.x1 || 0) + 2}
                y1={nodeCenterY}
                x2={labelX - 4}
                y2={labelY}
                stroke={theme === 'dark' ? '#aaa' : '#666'}
                strokeWidth={1.5}
                strokeDasharray="3,2"
              />
              
              {/* Background rectangle for better readability */}
              <rect
                x={labelX - 4}
                y={labelY - 10}
                width={poolName.length * 8 + 10}
                height={20}
                rx={4}
                fill={theme === 'dark' ? '#333' : '#f0f0f0'}
                stroke={colors.poolLabel}
                strokeWidth={1}
              />
              
              {/* Pool name text */}
              <text
                x={labelX}
                y={labelY + 4}
                fontWeight="bold"
                fill={colors.poolLabel}
                fontSize="12"
                style={{
                  paintOrder: 'stroke',
                  stroke: theme === 'dark' ? '#222' : '#fff',
                  strokeWidth: '2px',
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                }}
              >
                {poolName}
              </text>
            </g>
          );
          poolLabelCount++;
        });
        
        console.log(`Rendered ${poolLabelCount} pool labels from ${poolToLastBranchMap.size} pools`);
        
        // If no pool labels were found via the usual method, try a direct approach as fallback
        if (poolLabelCount === 0) {
          console.warn('No pool labels were created via node mapping, using direct pool data');
          
          // Get all pools directly from the data processor
          const poolToBranch = sankeyDataProcessor.getLastMerkleBranchesForPools();
          const rightEdge = globalMaxX; // Use the previously defined max X
          
          // Render labels directly using the pool information
          let verticalOffset = 50; // Start with an offset from top
          poolToBranch.forEach((branchName, poolName) => {
            console.log(`Direct pool label: ${poolName} (branch: ${branchName})`);
            
            poolLabels.push(
              <g key={`direct-pool-label-${poolName}`} className="pool-label direct">
                {/* Background rectangle */}
                <rect
                  x={rightEdge - 4}
                  y={verticalOffset - 10}
                  width={poolName.length * 8 + 10}
                  height={20}
                  rx={4}
                  fill={theme === 'dark' ? '#333' : '#f0f0f0'}
                  stroke={colors.poolLabel}
                  strokeWidth={1}
                />
                
                {/* Pool name text */}
                <text
                  x={rightEdge}
                  y={verticalOffset + 4}
                  fontWeight="bold"
                  fill={colors.poolLabel}
                  fontSize="12"
                  style={{
                    paintOrder: 'stroke',
                    stroke: theme === 'dark' ? '#222' : '#fff',
                    strokeWidth: '2px',
                    strokeLinecap: 'round',
                    strokeLinejoin: 'round',
                  }}
                >
                  {poolName}
                </text>
              </g>
            );
            
            verticalOffset += 25; // Space labels vertically
            poolLabelCount++;
          });
          
          console.log(`Added ${poolLabelCount} direct pool labels as fallback`);
        }
        
        return <>{poolLabels}</>;
      };
      
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
      
      // Debug info - add this temporarily
      console.log(`Rendering ${nodes.length} nodes and ${links.length} links`);
      
      // Add node labels if enabled
      if (showLabels) {
        // Use individual text elements for each node for better visibility
        nodeGroup.each(function(d: any) {
          // Skip if no data or dimensions
          if (!d || d.x0 === undefined || d.y0 === undefined) return;
          
          const nodeWidth = (d.x1 || 0) - (d.x0 || 0);
          const nodeHeight = (d.y1 || 0) - (d.y0 || 0);
          
          // Skip nodes too small to show text
          if (nodeWidth < 10 || nodeHeight < 10) return;
          
          // Get label text
          const label = formatNodeLabel(d);
          
          // Detect if this is a left-edge or right-edge node
          const isLeftEdge = d.x0 < 30; // Node is within 30px of the left edge
          const isRightEdge = d.x1 > width - 30; // Node is within 30px of the right edge
          
          // Calculate position and text-anchor based on node position
          let xPosition, textAnchor, padding;
          
          if (isLeftEdge) {
            // For left edge nodes, position text inside the node with padding and align left
            xPosition = 5; // 5px padding from left edge of node
            textAnchor = "start";
          } else if (isRightEdge) {
            // For right edge nodes, position text inside the node with padding and align right
            xPosition = nodeWidth - 5; // 5px padding from right edge of node
            textAnchor = "end";
          } else {
            // For center nodes, keep centered
            xPosition = nodeWidth / 2;
            textAnchor = "middle";
          }
          
          // Create text element
          d3.select(this)
            .append("text")
            .attr("x", xPosition)
            .attr("y", nodeHeight / 2 + 4) // +4 for better vertical centering
            .attr("text-anchor", textAnchor)
            .attr("dominant-baseline", "middle")
            .attr("fill", "white") // White text for better contrast on colored nodes
            .attr("stroke", "black") // Add black stroke
            .attr("stroke-width", "0.5px") // Thin stroke width
            .attr("paint-order", "stroke") // Draw stroke behind text
            .attr("font-size", "11px")
            .attr("font-weight", "600")
            .attr("pointer-events", "none") // Prevent interfering with node click/hover events
            .attr("text-shadow", "0px 0px 3px rgba(0,0,0,0.7)") // Text shadow for better readability
            .text(label);
        });
      }
      
      // Find the absolute rightmost branch node position for alignment
      const branchNodes = nodes.filter((n: any) => n.type === 'branch');
      const rightmostBranchX1 = Math.max(...branchNodes.map((n: any) => n.x1 || 0));
      
      // Create a map from branch name to node index
      const branchNameToNode = new Map();
      branchNodes.forEach((node: any) => {
        branchNameToNode.set(node.name, node);
      });
      
      // Group branch nodes by their horizontal position to identify columns
      const branchNodesByX = new Map<number, any[]>();
      branchNodes.forEach((node: any) => {
        const x = Math.round(node.x1 || 0);
        if (!branchNodesByX.has(x)) {
          branchNodesByX.set(x, []);
        }
        branchNodesByX.get(x)!.push(node);
      });
      
      // Interface for pool label info collection
      interface PoolLabelInfo {
        nodeX: number;
        nodeY: number;
        poolName: string;
        branchName: string;
      }
      
      const poolLabelsToAdd: PoolLabelInfo[] = [];
      
      // Get the direct mapping from pool name to last branch name
      const poolToLastBranchMap = sankeyDataProcessor.getLastMerkleBranchesForPools();
      console.log("All pools with their last branches:", Object.fromEntries(poolToLastBranchMap));
      
      // Group pools by their last merkle branch
      const branchToPoolsMap = new Map<string, string[]>();
      
      poolToLastBranchMap.forEach((branchName, poolName) => {
        if (!branchToPoolsMap.has(branchName)) {
          branchToPoolsMap.set(branchName, []);
        }
        branchToPoolsMap.get(branchName)!.push(poolName);
      });
      
      // Sort pools alphabetically within each branch group
      branchToPoolsMap.forEach((pools, branch) => {
        pools.sort(); // Sort alphabetically
      });
      
      // Process each branch with its associated pools
      branchToPoolsMap.forEach((poolNames, branchName) => {
        // Find the node for this branch name
        let branchNode = undefined;
        
        // Try exact match first
        for (const node of branchNodes) {
          if (node.name === branchName) {
            branchNode = node;
            break;
          }
        }
        
        // Try case-insensitive match if needed
        if (!branchNode) {
          const lowerBranchName = branchName.toLowerCase();
          for (const node of branchNodes) {
            if (node.name.toLowerCase() === lowerBranchName) {
              branchNode = node;
              break;
            }
          }
        }
        
        // Skip if we can't find the node
        if (!branchNode) {
          console.warn(`Could not find node for branch ${branchName} (pools: ${poolNames.join(', ')})`);
          return;
        }
        
        // Get the position for this node
        const nodeX = branchNode.x1; // right edge
        const nodeY = branchNode.y0 + ((branchNode.y1 - branchNode.y0) / 2); // vertical center
        
        console.log(`Found node for branch ${branchName} at position (${nodeX}, ${nodeY}) with pools: ${poolNames.join(', ')}`);
        
        // Add to our labels list
        poolLabelsToAdd.push({
          nodeX,
          nodeY,
          poolName: poolNames.join('\n'), // We'll split this later when rendering
          branchName
        });
      });
      
      // Sort labels by vertical position
      poolLabelsToAdd.sort((a, b) => a.nodeY - b.nodeY);
      
      // Remove any existing pool labels first
      svg.selectAll(".pool-labels-group").remove();
      
      // Create a new pool label group
      const poolLabelGroup = svg.append("g")
        .attr("class", "pool-labels-group");
      
      // Calculate vertical spacing for labels (if multiple pools share the same x-coordinate)
      const LINE_HEIGHT = 16; // Height per line of text
      const LABEL_PADDING = 6; // Padding inside label box
      const LABEL_OFFSET_X = 20; // Horizontal offset from the node
      
      // Add pool labels with nice styling and connecting lines
      poolLabelsToAdd.forEach((labelInfo, index) => {
        // Calculate horizontal position to the right of the node
        const x = labelInfo.nodeX + LABEL_OFFSET_X;
        
        // Base vertical position at node center
        let y = labelInfo.nodeY;
        
        // Split the pool names (they're joined with newlines)
        const poolNames = labelInfo.poolName.split('\n');
        
        // Calculate background rectangle dimensions
        const maxLabelLength = Math.max(...poolNames.map(name => name.length));
        const TEXT_PADDING_HORIZONTAL = 4; // Equal horizontal padding for both sides
        const rectWidth = maxLabelLength * 7.2 + (TEXT_PADDING_HORIZONTAL * 2); // Equal padding on both sides
        
        // More precise height calculation to ensure equal padding top and bottom
        // BASE_TEXT_SIZE is the actual height of the font (not the same as LINE_HEIGHT)
        const BASE_TEXT_SIZE = 12; // Font size in pixels
        // LINE_HEIGHT is space between lines
        
        // Calculate total content height needed
        const textContentHeight = poolNames.length * LINE_HEIGHT - (LINE_HEIGHT - BASE_TEXT_SIZE);
        
        // Add the same padding to top and bottom
        const rectHeight = textContentHeight + (LABEL_PADDING * 2);
        
        // Ensure the label stays within the visible height area
        if (y + (rectHeight / 2) > height) {
          // If label would extend below the bottom, move it up
          y = height - (rectHeight / 2) - 10; // 10px buffer from bottom edge
        }
        if (y - (rectHeight / 2) < 0) {
          // If label would extend above the top, move it down
          y = (rectHeight / 2) + 10; // 10px buffer from top edge
        }
        
        // Use a completely different approach with explicit positioning
        // First figure out how much total vertical space we need
        const FONT_SIZE = 12;
        const TEXT_PADDING = 1; // Minimal padding between text and box edge
        
        // Create the group element for this label
        const labelGroup = poolLabelGroup.append("g")
          .attr("class", "pool-label")
          .attr("transform", `translate(${x}, ${y})`);
        
        // Add connecting line
        labelGroup.append("line")
          .attr("x1", -LABEL_OFFSET_X) // Connect from the node edge
          .attr("y1", 0) // Center of node
          .attr("x2", -5) // Small offset before the label
          .attr("y2", 0)
          .attr("stroke", theme === 'dark' ? '#aaa' : '#666')
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "3,2");
          
        // This will be used to build our label from scratch
        // with precise control over padding
        
        // Step 1: Calculate total content height without extra spacing
        const contentHeight = poolNames.length * LINE_HEIGHT;
        const halfContentHeight = contentHeight / 2;
        
        // Step 2: Set the vertical boundaries of our content
        const topEdge = -halfContentHeight;
        const bottomEdge = halfContentHeight;
        
        // Step 3: Create the background rectangle with equal padding
        labelGroup.append("rect")
          .attr("x", -5)
          .attr("y", topEdge - TEXT_PADDING) // Top of content minus padding
          .attr("width", rectWidth)
          .attr("height", contentHeight + (TEXT_PADDING * 2)) // Content height plus padding top and bottom
          .attr("rx", 4)
          .attr("fill", theme === 'dark' ? '#333' : '#f0f0f0')
          .attr("stroke", colors.poolLabel)
          .attr("stroke-width", 1);
        
        // Step 4: Position each line of text
        poolNames.forEach((name, i) => {
          // Calculate center position for each text line
          // First line starts at the top edge of content area
          // Each subsequent line is positioned LINE_HEIGHT below the previous
          const textY = topEdge + (i * LINE_HEIGHT) + (LINE_HEIGHT / 2);
          
          // Add the text directly (not using tspan)
          labelGroup.append("text")
            .attr("x", TEXT_PADDING_HORIZONTAL - 5) // Account for rect x offset with new padding
            .attr("y", textY) // Center of this text line
            .attr("text-anchor", "start")
            .attr("dominant-baseline", "middle") // Center text vertically on its position
            .attr("fill", colors.poolLabel)
            .attr("stroke", theme === 'dark' ? '#222' : '#fff')
            .attr("stroke-width", 0.5)
            .attr("paint-order", "stroke")
            .attr("font-size", `${FONT_SIZE}px`)
            .attr("font-weight", "600")
            .text(name);
        });
      });
      
      // Log for debugging
      console.log(`Added ${poolLabelsToAdd.length} pool labels to the diagram`);
      
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
  
  // Process global data stream events when they change
  useEffect(() => {
    if (stratumV1Data.length > 0) {
      // Reset data processor first
      sankeyDataProcessor.reset();
      // First remove any lingering tooltips
      d3.select(containerRef.current).selectAll(".sankey-tooltip").remove();
      processRealData();
    }
  }, [stratumV1Data]);
  
  // Re-render when paused state changes
  useEffect(() => {
    // Ensure tooltips are cleared when paused state changes
    d3.select(containerRef.current).selectAll(".sankey-tooltip").remove();
    // Preserve the showLabels state when re-rendering due to paused state changes
    renderDiagram();
  }, [paused]);
  
  // Re-render when showLabels changes
  useEffect(() => {
    renderDiagram();
  }, [showLabels]);
  
  // Re-render when theme/colors change
  useEffect(() => {
    // Ensure tooltips are cleared when colors change
    d3.select(containerRef.current).selectAll(".sankey-tooltip").remove();
    renderDiagram();
  }, [colors]);
  
  // Handle events from the EventSource
  const handleEvent = (event: any) => {
    try {
      if (paused) return;
      
      // Process the new event
      sankeyDataProcessor.processStratumV1Event(event);
      
      // Render with the updated data, ensuring pool labels are maintained
      renderDiagram();
      
    } catch (err) {
      console.error("Error processing event:", err);
      setError(`Error processing event: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  
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
      style={{ height: `${height}px` }} 
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
        style={{ display: 'block' }} 
      />
      {!isConnected && stratumV1Data.length === 0 && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 p-4 rounded-lg z-10">
          Connecting to data stream...
        </div>
      )}
    </div>
  );
}