import { useCallback, RefObject } from 'react';
import * as d3 from 'd3';
import { sankeyLinkHorizontal } from 'd3-sankey';
import React from 'react';
import { useSankeyLayout } from './useSankeyLayout';
import SankeyPoolLabels from '../components/sankey/SankeyPoolLabels';

interface UseRenderDiagramOptions {
  svgRef: RefObject<SVGSVGElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  width: number;
  height: number;
  colors: any;
  theme: string | undefined;
  showLabels: boolean;
  onDataRendered?: (nodeCount: number, linkCount: number) => void;
  setTooltipData: (data: any) => void;
  setTooltipPosition: (position: { x: number; y: number } | null) => void;
  setError: (error: string | null) => void;
  sankeyDataProcessor: any;
  getBranchColor: (name: string) => string;
}

// Type definition for nodes with required properties
interface NodeWithTypeAndName {
  type: string;
  name: string;
  branchIndex?: number;
  // D3 Sankey node positioning properties
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
}

export function useRenderDiagram({
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
}: UseRenderDiagramOptions) {
  
  return useCallback(() => {
    try {
      // Clear previous rendering
      if (svgRef.current) {
        d3.select(svgRef.current).selectAll("*").remove();
      }
      
      // Get data from the processor
      const data = sankeyDataProcessor.getSankeyData();
      
      // Remove any existing tooltips (but don't clear SVG again since we just did)
      setTooltipData(null);
      setTooltipPosition(null);
      
      // Format node label
      const formatNodeLabel = (node: NodeWithTypeAndName): string => {
        if (node.type === 'pool') return node.name;
        // For merkle branches, just show the hash part without the MB prefix
        return node.name.substring(0, 6).toLowerCase();
      };
      
      // Find pools that use this node
      const findConnectedPools = (node: NodeWithTypeAndName): string[] => {
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
      
      // Check if we have data to render
      if (data.nodes.length === 0) {
        // SankeyStates component handles empty state display
        return;
      }
      
      // Use the layout hook to calculate sankey layout
      const { nodes, links, gridData } = useSankeyLayout(width, height, data);
      
      // Notify parent component about node/link counts
      if (onDataRendered && data.nodes && data.links) {
        onDataRendered(data.nodes.length, data.links.length);
      }
      
      // Create the SVG elements
      const svg = d3.select(svgRef.current);
      
      // Set background color via d3 after hydration
      svg.style("background-color", colors.background);
      
      // Render grid lines using calculated positions
      const gridGroup = svg.append("g").attr("class", "merkle-branch-grid");
      
      // Add grid lines for each branch position
      gridData.branchPositions.forEach(({ avgX, labelText }) => {
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
        gridGroup.append("text")
          .attr("x", avgX)
          .attr("y", 20) // Position at top with some padding
          .attr("text-anchor", "middle")
          .attr("fill", colors.gridText)
          .attr("font-size", "12px")
          .attr("font-weight", 500)
          .text(labelText);
      });
      
      // Add links
      svg.append("g")
        .selectAll("path")
        .data(links)
        .join("path")
        .attr("d", sankeyLinkHorizontal())
        .attr("stroke", colors.link)
        .attr("stroke-width", (d: unknown) => Math.max(1, (d as { width: number }).width))
        .attr("fill", "none")
        .attr("opacity", 0.7);
            
      // Add nodes
      const nodeGroup = svg.append("g")
        .selectAll("g")
        .data(nodes)
        .join("g")
        .attr("transform", (d: unknown) => `translate(${(d as { x0?: number; y0?: number }).x0 || 0},${(d as { x0?: number; y0?: number }).y0 || 0})`);
      
      // Add node rectangles with hover functionality
      nodeGroup.append("rect")
        .attr("width", (d: unknown) => ((d as { x1?: number; x0?: number }).x1 || 0) - ((d as { x1?: number; x0?: number }).x0 || 0))
        .attr("height", (d: unknown) => ((d as { y1?: number; y0?: number }).y1 || 0) - ((d as { y1?: number; y0?: number }).y0 || 0))
        .attr("fill", (d: NodeWithTypeAndName) => {
          if (d.type === 'pool') return colors.poolNode;
          // Use the utility function to get a consistent color with caching
          return getBranchColor(d.name);
        })
        .attr("stroke", colors.nodeStroke)
        .attr("cursor", "pointer")
        .on("click", function(event: MouseEvent, d: NodeWithTypeAndName) {
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
        .on("mouseover", function(event: MouseEvent, d: NodeWithTypeAndName) {
          const label = formatNodeLabel(d);
          
          // Find pools connected to this node
          const connectedPools = findConnectedPools(d);
          
          // Create tooltip data for SankeyTooltip component
          if (d.type === 'pool') {
            setTooltipData({
              type: 'pool',
              name: d.name,
              label: label
            });
          } else { // branch type
            setTooltipData({
              type: 'branch',
              name: d.name,
              branchIndex: d.branchIndex || 0,
              connectedPools: connectedPools
            });
          }
          
          // Set tooltip position from mouse event
          const [x, y] = d3.pointer(event, containerRef.current);
          setTooltipPosition({ x, y });
        })
        .on("mousemove", function(event: MouseEvent) {
          // Update tooltip position with mouse movement
          const [x, y] = d3.pointer(event, containerRef.current);
          setTooltipPosition({ x, y });
        })
        .on("mouseout", function() {
          setTooltipData(null);
          setTooltipPosition(null);
        });
      
      // Render connecting lines BEFORE node labels to ensure proper z-order
      if (svg && nodes && sankeyDataProcessor) {
        // Create a group specifically for connecting lines (behind everything else)
        const connectingLinesGroup = svg.append("g")
          .attr("class", "connecting-lines-group");
        
        // Get pool-to-branch mapping
        const poolToLastBranchMap = sankeyDataProcessor.getLastMerkleBranchesForPools();
        
        if (poolToLastBranchMap.size > 0) {
          // Group pools by their last merkle branch
          const branchToPoolsMap = new Map<string, string[]>();
          
          poolToLastBranchMap.forEach((branchName: string, poolName: string) => {
            if (!branchToPoolsMap.has(branchName)) {
              branchToPoolsMap.set(branchName, []);
            }
            branchToPoolsMap.get(branchName)!.push(poolName);
          });
          
          // Find branch nodes
          const branchNodes = nodes.filter((n: NodeWithTypeAndName) => n.type === 'branch');
          
          // Add connecting lines for each branch with pools
          branchToPoolsMap.forEach((poolNames, branchName) => {
            // Find the node for this branch
            let branchNode = branchNodes.find((node: NodeWithTypeAndName) => node.name === branchName);
            if (!branchNode) {
              branchNode = branchNodes.find((node: NodeWithTypeAndName) => 
                node.name.toLowerCase() === branchName.toLowerCase()
              );
            }
            
            if (branchNode) {
              const nodeX = branchNode.x1; // right edge
              const nodeY = branchNode.y0 + ((branchNode.y1 - branchNode.y0) / 2); // center
              const LABEL_OFFSET_X = 20;
              
              // Add the connecting line
              connectingLinesGroup.append("line")
                .attr("x1", nodeX)
                .attr("y1", nodeY)
                .attr("x2", nodeX + LABEL_OFFSET_X - 5)
                .attr("y2", nodeY)
                .attr("stroke", theme === 'dark' ? '#aaa' : '#666')
                .attr("stroke-width", 1.5)
                .attr("stroke-dasharray", "3,2");
            }
          });
        }
      }
      
      // Add node labels if enabled - using separate group for proper z-order
      if (showLabels) {
        // Create a separate group for all merkle branch labels (renders after connecting lines)
        const labelsGroup = svg.append("g")
          .attr("class", "merkle-branch-labels-group");
        
        // Process each node for labels
        nodes.forEach((d: unknown) => {
          // Skip if no data or dimensions
          if (!d || (d as NodeWithTypeAndName).x0 === undefined || (d as NodeWithTypeAndName).y0 === undefined) return;
          
          const nodeWidth = ((d as NodeWithTypeAndName).x1 || 0) - ((d as NodeWithTypeAndName).x0 || 0);
          const nodeHeight = ((d as NodeWithTypeAndName).y1 || 0) - ((d as NodeWithTypeAndName).y0 || 0);
          
          // Skip nodes too small to show text
          if (nodeWidth < 10 || nodeHeight < 10) return;
          
          // Get label text
          const label = formatNodeLabel(d as NodeWithTypeAndName);
          
          // Detect if this is a left-edge or right-edge node
          const isLeftEdge = (d as NodeWithTypeAndName).x0! < 30; // Node is within 30px of the left edge
          const isRightEdge = (d as NodeWithTypeAndName).x1! > width - 30; // Node is within 30px of the right edge
          
          // Calculate position and text-anchor based on node position
          let xPosition, textAnchor;
          
          if (isLeftEdge) {
            // For left edge nodes, position text inside the node with padding and align left
            xPosition = (d as NodeWithTypeAndName).x0! + 5; // 5px padding from left edge of node
            textAnchor = "start";
          } else if (isRightEdge) {
            // For right edge nodes, position text inside the node with padding and align right
            xPosition = (d as NodeWithTypeAndName).x1! - 5; // 5px padding from right edge of node
            textAnchor = "end";
          } else {
            // For center nodes, keep centered
            xPosition = (d as NodeWithTypeAndName).x0! + nodeWidth / 2;
            textAnchor = "middle";
          }
          
          // Create text element in the labels group
          labelsGroup.append("text")
            .attr("x", xPosition)
            .attr("y", (d as NodeWithTypeAndName).y0! + nodeHeight / 2) // Perfect vertical center using dominant-baseline
            .attr("text-anchor", textAnchor)
            .attr("dominant-baseline", "middle")
            .attr("fill", "white") // White text for better contrast on colored nodes
            .attr("stroke", "black") // Black stroke for outline
            .attr("stroke-width", "1.2px") // Enhanced stroke width for better visibility
            .attr("stroke-linejoin", "round") // Smooth stroke corners
            .attr("paint-order", "stroke")
            .attr("font-size", "11px")
            .attr("font-weight", "600")
            .attr("pointer-events", "none") // Prevent interfering with node click/hover events
            .style("text-shadow", "0px 0px 3px rgba(0,0,0,0.6), 1px 1px 1px rgba(0,0,0,0.4)") // Subtle shadow for enhanced readability
            .text(label);
        });
      }
      
      // Render pool labels using the extracted SankeyPoolLabels component
      // The component uses D3 for direct SVG manipulation, so we need to trigger it here
      if (svg && nodes && sankeyDataProcessor) {
        // Create a temporary container for the React component that will handle D3 rendering
        const poolLabelsContainer = document.createElement('div');
        poolLabelsContainer.style.display = 'none'; // Hidden since it's just for triggering rendering
        document.body.appendChild(poolLabelsContainer);
        
        // Use React.createElement to instantiate SankeyPoolLabels
        // This will trigger the useEffect inside the component to render pool labels via D3
        const poolLabelsElement = React.createElement(SankeyPoolLabels, {
          nodes,
          sankeyDataProcessor,
          width,
          height,
          theme: theme || 'light',
          colors: {
            poolLabel: colors.poolLabel,
            ...(colors as unknown as Record<string, string>)  // Cast via unknown to satisfy index signature
          },
          svg: svg as any // Type assertion to resolve D3 selection compatibility
        });
        
        // Render the component to trigger its D3 rendering logic
        import('react-dom/client').then(({ createRoot }) => {
          const root = createRoot(poolLabelsContainer);
          root.render(poolLabelsElement);
          
          // Clean up after a short delay to allow rendering to complete
          setTimeout(() => {
            root.unmount();
            document.body.removeChild(poolLabelsContainer);
          }, 100);
        }).catch(err => {
          console.error('Error loading React DOM:', err);
          // Fallback: Clean up container
          if (document.body.contains(poolLabelsContainer)) {
            document.body.removeChild(poolLabelsContainer);
          }
        });
      }
      
    } catch (err) {
      console.error("Error rendering diagram:", err);
      setError(`Error rendering diagram: ${err instanceof Error ? err.message : String(err)}`);
      
      if (svgRef.current) {
        // Show error message in the SVG
        d3.select(svgRef.current)
          .append("text")
          .attr("x", width / 2)
          .attr("y", height / 2)
          .attr("text-anchor", "middle")
          .attr("fill", colors.error)
          .text(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, [width, height, colors, theme, showLabels]);
}
