import React, { useRef, useState, useEffect } from 'react';
import { getMerkleColor } from '@/utils/colorUtils';

interface MerkleTreeVisualizationProps {
  coinbaseTxHash?: string;
  merkleBranches?: string[];
}

interface TreeNode {
  hash: string;
  label: string;
  type: 'coinbase' | 'branch' | 'intermediate' | 'root';
  x: number;
  y: number;
  children?: [TreeNode?, TreeNode?];
}

// Define constants for layout
const defaultNodeWidth = 100;
const defaultNodeHeight = 32;
const branchNodeWidth = 120; // Larger width for branches
const branchNodeHeight = 40; // Larger height for branches
const rootNodeWidth = 140;   // Larger width for the root
const rootNodeHeight = 48;  // Larger height for the root
const horizontalSpacing = 10; // Reduced spacing from 30
const levelHeight = 70; // Increased vertical space slightly

const MerkleTreeVisualization: React.FC<MerkleTreeVisualizationProps> = ({
  coinbaseTxHash,
  merkleBranches = [],
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  // Effect to measure container width
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      if (entries[0]) {
        setContainerWidth(entries[0].contentRect.width);
      }
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
      // Set initial width
      setContainerWidth(containerRef.current.offsetWidth);
    }

    return () => {
      observer.disconnect();
    };
  }, []); // Empty dependency array ensures this runs once on mount

  const buildTree = (): { root: TreeNode; width: number; height: number } | null => {
    if (!coinbaseTxHash) return null;

    const numBranches = merkleBranches.length;
    if (numBranches === 0) {
        // Handle case with only coinbase (becomes the root)
        const rootNode: TreeNode = {
            hash: coinbaseTxHash,
            label: 'coinbase', // Or 'root'? User might expect 'root' if no branches
            type: 'root', // Treat as root if it's the only node
            x: 0,
            y: 0,
        };
        // Base width/height for a single node
        return { root: rootNode, width: defaultNodeWidth, height: defaultNodeHeight };
    }


    // Create the initial coinbase node (will be at the deepest level)
    let currentNode: TreeNode = {
        hash: coinbaseTxHash,
        label: 'coinbase',
        type: 'coinbase',
        x: 0, // Placeholder, calculated later
        y: 0  // Placeholder, calculated later
    };

    // Iteratively build the tree upwards
    for (let i = 0; i < numBranches; i++) {
        const branchNode: TreeNode = {
            hash: merkleBranches[i],
            label: `branch${i}`,
            type: 'branch',
            x: 0, // Placeholder
            y: 0  // Placeholder
        };

        const parentNode: TreeNode = {
            // Don't simulate hash, just use placeholder. Keep unique for potential key usage if needed.
            hash: `intermediate-${i}`, 
            label: '', // Intermediate nodes show 'Hash' label later
            type: 'intermediate',
            x: 0, // Placeholder
            y: 0, // Placeholder
            // Left child is the result of previous hashes, right child is the new branch
            children: [currentNode, branchNode]
        };
        currentNode = parentNode; // Move up to the parent for the next iteration
    }

    // The final node after all iterations is the root
    currentNode.type = 'root';
    currentNode.label = 'merkle root';


    // --- Calculate Positions ---

    // 1. Assign levels/depth (y coordinate) starting from root=0
    const assignLevels = (node: TreeNode, level: number) => {
        node.y = level;
        if (node.children) {
            node.children.forEach(child => {
                if (child) assignLevels(child, level + 1);
            });
        }
    };
    assignLevels(currentNode, 0);

    // 2. Find max depth to calculate tree height
    let maxDepth = 0;
    const findMaxDepth = (node: TreeNode) => {
        maxDepth = Math.max(maxDepth, node.y);
        if (node.children) {
            node.children.forEach(child => {
                if (child) findMaxDepth(child);
            });
        }
    };
    findMaxDepth(currentNode);
    // Calculate base height needed for the drawing content - use max of branch/root height
    const treeContentHeight = (maxDepth * levelHeight) + Math.max(branchNodeHeight, rootNodeHeight);

    // 3. Assign X coordinates based on leaf positions and track max extent
    let leafCounter = 0;
    let maxNodeX = 0; // Track the rightmost edge

    const assignXPositions = (node: TreeNode): number => { // Returns the CENTER x of the node
        const isLargeNode = node.type === 'branch' || node.type === 'coinbase';
        const currentWidth = isLargeNode ? branchNodeWidth : defaultNodeWidth;
        // Check if it's a leaf in *this specific* tree structure
        // Leaves are the 'coinbase' node and all 'branch' nodes
        const isLeaf = node.type === 'coinbase' || node.type === 'branch';

        if (isLeaf) {
            // Assign X position based on the order leaves are encountered (left-to-right)
            node.x = leafCounter * (currentWidth + horizontalSpacing);
            leafCounter++;
            maxNodeX = Math.max(maxNodeX, node.x + currentWidth); // Update max extent
            return node.x + currentWidth / 2; // Return center for parent calculation
        } else {
            // Intermediate or root node: Center above its children
            let totalX = 0;
            let validChildrenCount = 0; // Count only non-null children
            if (node.children?.[0]) {
                totalX += assignXPositions(node.children[0]);
                validChildrenCount++;
            }
            if (node.children?.[1]) {
                 totalX += assignXPositions(node.children[1]);
                 validChildrenCount++;
            }
             // Avoid division by zero if a node unexpectedly has no children processed
            node.x = validChildrenCount > 0 ? totalX / validChildrenCount : 0;
            // Assign the node's top-left X based on its center and width
            const parentWidth = node.type === 'root' ? rootNodeWidth : defaultNodeWidth;
            node.x = node.x - parentWidth / 2;
            // Update max extent based on the parent node itself
            maxNodeX = Math.max(maxNodeX, node.x + parentWidth);
            return node.x + parentWidth / 2; // Return the calculated center X
        }
    };

    assignXPositions(currentNode); // Start assignment from the root

    // 4. Calculate required content width based on the maximum extent found
    const treeContentWidth = maxNodeX; // The width is the rightmost edge reached

    return { root: currentNode, width: treeContentWidth, height: treeContentHeight };
  };

  // --- Helper function to find specific nodes by condition ---
  const findNode = (node: TreeNode | null, condition: (n: TreeNode) => boolean): TreeNode | null => {
    if (!node) return null;
    if (condition(node)) return node;
    if (node.children) {
        for (const child of node.children) {
            const found = findNode(child || null, condition);
            if (found) return found;
        }
    }
    return null;
  };

  const treeData = buildTree();

  // Find the nodes needed for the line calculation
  const coinbaseNode = treeData ? findNode(treeData.root, n => n.type === 'coinbase') : null;
  const branch0Node = treeData ? findNode(treeData.root, n => n.label === 'branch0') : null;

  // Conditional rendering if tree can't be built or container width not measured yet
  if (!treeData || !coinbaseNode || !branch0Node) { // Ensure nodes are found
    return (
      <div ref={containerRef} className="w-full min-h-[100px] flex items-center justify-center">
         <div className="text-center text-muted-foreground">
           {coinbaseTxHash ? "Building tree..." : "No merkle tree data available (missing coinbase hash)"} 
         </div>
      </div>
    );
  }
  if (containerWidth === null) {
      return (
          <div ref={containerRef} className="w-full min-h-[100px]"></div>
      );
  }


  const { root: tree, width: treeContentWidth, height: treeContentHeight } = treeData;

  // Calculate line coordinates
  const linePadding = 15;
  const lineVerticalSpacing = 15;
  const lineY = (coinbaseNode.y * levelHeight) - lineVerticalSpacing;
  const lineX1 = coinbaseNode.x - linePadding;
  // Use branch0's specific width (branchNodeWidth)
  const lineX2 = branch0Node.x + branchNodeWidth + linePadding; 

  // --- Calculate SVG Dimensions based on Container --- 
  const padding = defaultNodeWidth / 2; // Add some padding around the content
  const viewBoxWidth = Math.max(treeContentWidth, lineX2 + padding); // Ensure viewBox includes the line
  const viewBoxHeight = treeContentHeight + 2 * padding;

  // Restore conditional sizing logic
  let svgWidth: number | string;
  let svgHeight: number;

  if (containerWidth === null) { // Handle case where container width isn't measured yet
      svgWidth = "100%";
      svgHeight = 150; // Default height or min-height
  } else if (viewBoxWidth - 2 * padding <= containerWidth) { // Check if content width (including line) fits
    svgWidth = viewBoxWidth - 2 * padding;
    svgHeight = viewBoxHeight - 2 * padding;
  } else {
    svgWidth = "100%";
    svgHeight = (viewBoxHeight - 2 * padding) * (containerWidth / (viewBoxWidth - 2 * padding));
  }

  const renderNode = (node: TreeNode) => {
    const isLargeNode = node.type === 'branch' || node.type === 'coinbase';
    let currentWidth = isLargeNode ? branchNodeWidth : defaultNodeWidth;
    let currentHeight = isLargeNode ? branchNodeHeight : defaultNodeHeight;
    if (node.type === 'root') {
        currentWidth = rootNodeWidth;
        currentHeight = rootNodeHeight;
    }
    // Adjust xPos to center potentially wider nodes around the calculated center point
    const xPos = node.x; // Node X is already top-left based on assignXPositions
    const yPos = node.y * levelHeight;

    // Determine color and style based on node type
    let bgColorClass = '';
    let inlineStyle = {};
    let textColorClass = 'text-white';
    if (node.type === 'branch') {
      const nodeColor = getMerkleColor(node.hash);
      inlineStyle = { backgroundColor: nodeColor };
      textColorClass = 'text-black';
    } else if (node.type === 'root') {
      bgColorClass = 'bg-red-500';
    } else if (node.type === 'coinbase') {
      bgColorClass = 'bg-green-500';
    } else { // Intermediate node
      bgColorClass = 'bg-gray-500';
    }

    // Determine if title should be shown (only for leaves)
    const showTitle = node.type === 'coinbase' || node.type === 'branch';

    // Define border class based on whether it's a transaction - Back to Border approach
    const borderStyleClass = 'border border-solid border-black/20 dark:border-white/20'; // Standard border for all nodes

    // Define dummy node dimensions here
    const dummyWidth = defaultNodeWidth * 0.5; // Smaller than real nodes
    const dummyHeight = defaultNodeHeight * 0.5;
    const dummySpacing = 8;

    return (
      <React.Fragment key={`${node.hash}-${node.y}-${node.x}`}>
        {/* Draw lines to children */}
        {node.children?.map((child, index) => {
          if (!child) return null;
          // Child position from its own pre-calculated data
          const childYPos = child.y * levelHeight;

          return (
            <line
              // Unique key for the line
              key={`line-${node.hash}-${child.hash}-${index}`}
              x1={xPos + currentWidth / 2}       // Bottom-center of parent
              y1={yPos + currentHeight}
              // Adjust child connection point based on its actual width
              x2={child.x + ((child.type === 'branch' || child.type === 'coinbase') ? branchNodeWidth : (child.type === 'root' ? rootNodeWidth : defaultNodeWidth)) / 2}
              y2={childYPos}
              stroke="white"
              strokeOpacity="0.8"
              strokeWidth="1"
              // Ensure lines scale visually if SVG scales
              vectorEffect="non-scaling-stroke"
            />
          );
        })}

        {/* Draw node */}
        <g transform={`translate(${xPos}, ${yPos})`}> {/* Use adjusted xPos */}
          <foreignObject width={currentWidth} height={currentHeight}>
            <div
               style={inlineStyle}
               // Use dynamic border style class
               className={`h-full px-1 py-0.5 ${bgColorClass} rounded flex items-center justify-center ${textColorClass} ${node.type === 'branch' ? 'text-sm' : 'text-xs'} whitespace-nowrap overflow-hidden text-ellipsis ${borderStyleClass}`}
               title={showTitle ? node.hash : undefined}
             >
               {/* Custom content based on node type */}
               {node.type === 'branch' ? (
                 <div className="flex flex-col items-center justify-center text-center leading-tight">
                   <span>{node.label}</span>
                   <span className="opacity-80">{node.hash.substring(0, 8)}...</span> {/* Show first 8 chars + ... */}
                 </div>
               ) : (
                 // Original label logic for other types
                 (node.label || (node.type === 'intermediate' ? 'Hash' : ''))
               )}
            </div>
          </foreignObject>
        </g>

        {/* Add "Transactions" label next to branch0 */}
        {node.label === 'branch0' && (
            <text
                x={xPos + branchNodeWidth + 10} // Position to the right of the node + spacing
                y={yPos + branchNodeHeight / 2} // Vertically center with the node
                fill="currentColor" // Use theme text color
                fontSize="30"
                dominantBaseline="middle" // Vertical alignment
                textAnchor="start" // Horizontal alignment (start of text at x)
            >
                ← Transactions
            </text>
        )}

        {/* Draw dummy nodes below branches (but not branch0) */}
        {node.type === 'branch' && node.label !== 'branch0' && (
            <g>
                {/* First dummy rect */}
                <rect
                    x={xPos + (currentWidth - dummyWidth) / 2}
                    y={yPos + currentHeight + dummySpacing}
                    width={dummyWidth}
                    height={dummyHeight}
                    rx="2"
                    ry="2"
                    fill="white"
                    fillOpacity="0.3"
                    stroke="white"
                    strokeOpacity="0.3"
                    strokeWidth="0.5"
                    vectorEffect="non-scaling-stroke"
                />
                {/* Second dummy rect */}
                <rect
                    x={xPos + (currentWidth - dummyWidth) / 2}
                    y={yPos + currentHeight + dummySpacing * 2 + dummyHeight}
                    width={dummyWidth}
                    height={dummyHeight}
                    rx="2"
                    ry="2"
                    fill="white"
                    fillOpacity="0.2"
                    stroke="white"
                    strokeOpacity="0.2"
                    strokeWidth="0.5"
                    vectorEffect="non-scaling-stroke"
                />
                {/* Third dummy rect */}
                <rect
                    x={xPos + (currentWidth - dummyWidth) / 2}
                    y={yPos + currentHeight + dummySpacing * 3 + dummyHeight * 2}
                    width={dummyWidth}
                    height={dummyHeight}
                    rx="2"
                    ry="2"
                    fill="white"
                    fillOpacity="0.1"
                    stroke="white"
                    strokeOpacity="0.1"
                    strokeWidth="0.5"
                    vectorEffect="non-scaling-stroke"
                />
            </g>
        )}

        {/* Render children recursively */}
        {node.children?.map(child => child && renderNode(child))}
      </React.Fragment>
    );
  };


  return (
    <div ref={containerRef} className="w-full py-4 relative overflow-hidden min-h-[150px]"> 
      <svg
          width={svgWidth}
          height={svgHeight}
          viewBox={`-${padding} -${padding} ${viewBoxWidth} ${viewBoxHeight}`}
          preserveAspectRatio="xMidYMid meet"
      >
          {/* Render the dashed line */}
          <line
              x1={lineX1}
              y1={lineY}
              x2={lineX2}
              y2={lineY}
              stroke="white"
              strokeOpacity="0.7"
              strokeWidth="1"
              strokeDasharray="5,5"
              vectorEffect="non-scaling-stroke"
          />
          {/* Render the tree nodes */}
          {renderNode(tree)}
      </svg>
    </div>
  );
};

export default MerkleTreeVisualization; 