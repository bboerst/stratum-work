import { useMemo } from "react";
import * as d3 from "d3";
import { sankey, sankeyLeft } from "d3-sankey";
import { SankeyData } from "@/lib/sankeyDataProcessor";

interface GridBranchData {
  branchIndex: number;
  avgX: number;
  labelText: string;
  branchNodes: any[];
}

interface LayoutMetrics {
  leftOffset: number;
  poolLabelPadding: number;
  topPadding: number;
  bottomPadding: number;
  rightExtent: number;
}

interface SankeyLayoutResult {
  nodes: any[];
  links: any[];
  gridData: {
    maxBranchIndex: number;
    branchPositions: GridBranchData[];
  };
  layoutMetrics: LayoutMetrics;
}

/**
 * Custom hook for calculating Sankey diagram layout
 * Handles D3 sankey generation, dynamic padding calculations, and grid positioning
 */
export function useSankeyLayout(
  width: number,
  height: number,
  data: SankeyData
): SankeyLayoutResult {
  // Calculate right padding to accommodate pool labels
  const poolLabelPadding = 150;

  // Calculate dynamic left offset based on widest pool name
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

  // Layout padding constants
  const topPadding = 60;
  const bottomPadding = 60;
  const rightExtent = width - poolLabelPadding + leftOffset / 2;

  // Create the Sankey generator - cast to any to avoid TypeScript errors  
  const sankeyGenerator = sankey() as any;
  sankeyGenerator
    .nodeWidth(20)
    .nodePadding(15)
    .extent([[5 + leftOffset, topPadding], [rightExtent, height - bottomPadding]])
    .nodeAlign(sankeyLeft); // Use left alignment for more natural depth

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

  // Find the maximum branch index to determine how many grid lines to draw
  const maxBranchIndex = Math.max(...nodes.map((node: any) => node.branchIndex || 0));

  // Calculate grid line positions for each branch index
  const branchPositions: GridBranchData[] = [];
  for (let i = 0; i <= maxBranchIndex; i++) {
    // Find all nodes with this branch index
    const branchNodes = nodes.filter((node: any) => node.branchIndex === i);
    
    if (branchNodes.length > 0) {
      // Calculate average x position for this branch
      const avgX = d3.mean(branchNodes, (d: any) => (d.x0 + d.x1) / 2);
      
      if (avgX !== undefined) {
        // Calculate label text based on available space
        const labelWidth = (width - leftOffset) / (maxBranchIndex + 1) * 0.8;
        const labelText = labelWidth < 100 ? `MB ${i}` : `Merkle Branch ${i}`;
        
        branchPositions.push({
          branchIndex: i,
          avgX,
          labelText,
          branchNodes
        });
      }
    }
  }

  const layoutMetrics: LayoutMetrics = {
    leftOffset,
    poolLabelPadding,
    topPadding,
    bottomPadding,
    rightExtent
  };

  return {
    nodes,
    links,
    gridData: {
      maxBranchIndex,
      branchPositions
    },
    layoutMetrics
  };
}
