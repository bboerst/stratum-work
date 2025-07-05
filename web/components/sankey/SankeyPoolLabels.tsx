"use client";

import React, { useEffect, useRef } from "react";
import * as d3 from "d3";

interface SankeyPoolLabelsProps {
  // Core data structures
  nodes: any[];
  sankeyDataProcessor: any;
  
  // Layout & positioning information
  width: number;
  height: number;
  
  // Styling
  theme: string;
  colors: {
    poolLabel: string;
    [key: string]: string;  // Allow for other color properties
  };
  
  // D3 selection for rendering
  svg: any;  // D3 selection of the SVG element
}

/**
 * SankeyPoolLabels Component
 * 
 * Renders pool labels next to their respective last merkle branch nodes.
 * Uses D3 for direct SVG manipulation to maintain compatibility with existing code.
 */
const SankeyPoolLabels: React.FC<SankeyPoolLabelsProps> = ({
  nodes,
  sankeyDataProcessor,
  width,
  height,
  theme,
  colors,
  svg
}) => {
  // Use effect to render labels when component mounts or inputs change
  useEffect(() => {
    renderPoolLabels();
  }, [nodes, sankeyDataProcessor, width, height, theme, colors, svg]);
  
  /**
   * Renders pool labels based on the pool-to-branch mapping from the data processor
   * @returns null - rendering is done via D3 directly to the SVG
   */
  const renderPoolLabels = () => {
    // Early exit if we don't have the required data
    if (!nodes || nodes.length === 0 || !svg || !sankeyDataProcessor) {
      console.warn("Missing required data for pool labels");
      return null;
    }
    
    try {
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
      
      // Early exit if we don't have any pools to show
      if (poolToLastBranchMap.size === 0) {
        console.warn('No pool to branch mappings found');
        return null;
      }
      
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
      
      // If we couldn't find any labels through the normal method, try the fallback approach
      if (poolLabelsToAdd.length === 0) {
        console.warn('No pool labels found through normal mapping, using fallback approach');
        
        // Calculate global max X for fallback alignment
        const globalMaxX = Math.max(...nodes.map((n: any) => n.x1 || 0)) + 5;
        
        // Get all pools directly from the data processor
        const poolToBranch = sankeyDataProcessor.getLastMerkleBranchesForPools();
        
        // Render labels directly using the pool information
        let verticalOffset = 50; // Start with an offset from top
        poolToBranch.forEach((branchName, poolName) => {
          console.log(`Direct pool label: ${poolName} (branch: ${branchName})`);
          
          poolLabelsToAdd.push({
            nodeX: globalMaxX - 10,
            nodeY: verticalOffset,
            poolName: poolName,
            branchName: branchName
          });
          
          verticalOffset += 25; // Space labels vertically
        });
        
        console.log(`Added ${poolLabelsToAdd.length} direct pool labels as fallback`);
      }
      
      // Sort labels by vertical position
      poolLabelsToAdd.sort((a, b) => a.nodeY - b.nodeY);
      
      // If we still have no labels to add, exit
      if (poolLabelsToAdd.length === 0) {
        console.warn('No pool labels could be created, not rendering any');
        return null;
      }
      
      // Remove any existing pool labels first
      svg.selectAll(".pool-labels-group").remove();
      
      // Create a new pool label group
      const poolLabelGroup = svg.append("g")
        .attr("class", "pool-labels-group");
      
      // Calculate vertical spacing for labels (if multiple pools share the same x-coordinate)
      const LINE_HEIGHT = 16; // Height per line of text
      const LABEL_PADDING = 6; // Padding inside label box
      const LABEL_OFFSET_X = 20; // Horizontal offset from the node
      const FONT_SIZE = 12;
      const TEXT_PADDING = 1; // Minimal padding between text and box edge
      const TEXT_PADDING_HORIZONTAL = 4; // Equal horizontal padding for both sides
      
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
        const rectWidth = maxLabelLength * 7.2 + (TEXT_PADDING_HORIZONTAL * 2); // Equal padding on both sides
        
        // Calculate total content height without extra spacing
        const contentHeight = poolNames.length * LINE_HEIGHT;
        const halfContentHeight = contentHeight / 2;
        
        // Set the vertical boundaries of our content
        const topEdge = -halfContentHeight;
        const bottomEdge = halfContentHeight;
        
        // Ensure the label stays within the visible height area
        if (y + (contentHeight / 2) > height) {
          // If label would extend below the bottom, move it up
          y = height - (contentHeight / 2) - 10; // 10px buffer from bottom edge
        }
        if (y - (contentHeight / 2) < 0) {
          // If label would extend above the top, move it down
          y = (contentHeight / 2) + 10; // 10px buffer from top edge
        }
        
        // Create the group element for this label
        const labelGroup = poolLabelGroup.append("g")
          .attr("class", "pool-label")
          .attr("transform", `translate(${x}, ${y})`);
        
        // Note: Connecting lines are now rendered in SankeyDiagram.tsx for proper z-order
          
        // Create the background rectangle with equal padding
        labelGroup.append("rect")
          .attr("x", -5)
          .attr("y", topEdge - TEXT_PADDING) // Top of content minus padding
          .attr("width", rectWidth)
          .attr("height", contentHeight + (TEXT_PADDING * 2)) // Content height plus padding top and bottom
          .attr("rx", 4)
          .attr("fill", theme === 'dark' ? '#333' : '#f0f0f0')
          .attr("stroke", colors.poolLabel)
          .attr("stroke-width", 1);
        
        // Position each line of text
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
      console.error("Error rendering pool labels:", err);
    }
    
    return null;
  };
  
  // This component doesn't render anything directly - it manipulates the SVG via D3
  return null;
};

export default SankeyPoolLabels;
