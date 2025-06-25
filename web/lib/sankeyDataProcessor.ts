/**
 * Data processing utilities for the Sankey diagram
 */

// Original mining event interface
export interface MiningEvent {
  poolName: string;
  merkleBranches: string[];
}

// Real event data format from the global data stream
export interface StratumV1Event {
  type: string;
  id: string;
  timestamp: string;
  data: {
    _id: string;
    timestamp: string;
    pool_name: string;
    height: number;
    job_id: string;
    prev_hash: string;
    coinbase1: string;
    coinbase2: string;
    merkle_branches: string[];
    version: string;
    nbits: string;
    ntime: string;
    clean_jobs: boolean;
    extranonce1: string;
    extranonce2_length: number;
  };
}

export interface SankeyNode {
  name: string;
  type: 'pool' | 'branch';
  branchIndex?: number;
}

export interface SankeyLink {
  source: number | string;
  target: number | string;
  value: number;
}

export interface SankeyData {
  nodes: SankeyNode[];
  links: SankeyLink[];
}

export class SankeyDataProcessor {
  // State management
  private lastPoolEvents = new Map<string, string[]>(); // Tracks last known branches per pool
  private activeConnections = new Map<string, Set<string>>(); // Tracks current connections

  // Node management
  private nodes: SankeyNode[] = [];
  private nodeIndex = new Map<string, number>(); // nodeName -> index

  constructor() {}

  /**
   * Get or create a node and return its index
   */
  private getOrCreateNode(name: string, type: 'pool' | 'branch', branchIndex?: number): number {
    if (!this.nodeIndex.has(name)) {
      this.nodeIndex.set(name, this.nodes.length);
      this.nodes.push({ name, type, branchIndex });
    }
    return this.nodeIndex.get(name)!;
  }

  /**
   * Remove all connections for a pool
   */
  private removePoolConnections(poolName: string): number[] {
    const connectionsToRemove = new Set<number>();

    // Find all connections involving this pool
    this.activeConnections.forEach((targets, connectionKey) => {
      const [source, target] = connectionKey.split('-');
      
      // If this pool is the source or is in the targets set
      if (source === poolName || targets.has(poolName)) {
        // Mark for removal
        if (source === poolName) {
          connectionsToRemove.add(parseInt(target));
        }
        
        // Remove pool from targets if it's there
        if (targets.has(poolName)) {
          targets.delete(poolName);
          // If no more targets, remove the connection entirely
          if (targets.size === 0) {
            this.activeConnections.delete(connectionKey);
          }
        }
      }
    });

    // Remove direct connections where pool is the source
    Array.from(this.activeConnections.keys()).forEach(key => {
      if (key.startsWith(`${poolName}-`)) {
        this.activeConnections.delete(key);
      }
    });
    
    return Array.from(connectionsToRemove);
  }

  /**
   * Check if adding a connection would create a cycle
   */
  private wouldCreateCycle(sourceIdx: number, targetIdx: number): boolean {
    // Quick check: self-loop
    if (sourceIdx === targetIdx) {
      return true;
    }
    
    // Build a directed graph from current connections
    const graph = new Map<number, Set<number>>();
    
    // Initialize graph with all nodes
    for (let i = 0; i < this.nodes.length; i++) {
      graph.set(i, new Set<number>());
    }
    
    // Add existing edges
    this.activeConnections.forEach((_, connectionKey) => {
      const [source, target] = connectionKey.split('-').map(Number);
      graph.get(source)?.add(target);
    });
    
    // Temporarily add the new edge
    graph.get(sourceIdx)?.add(targetIdx);
    
    // Check for cycles using DFS
    const visited = new Set<number>();
    const recursionStack = new Set<number>();
    
    function hasCycle(node: number): boolean {
      if (recursionStack.has(node)) return true;
      if (visited.has(node)) return false;
      
      visited.add(node);
      recursionStack.add(node);
      
      const neighbors = graph.get(node) || new Set();
      for (const neighbor of neighbors) {
        if (hasCycle(neighbor)) return true;
      }
      
      recursionStack.delete(node);
      return false;
    }
    
    return hasCycle(sourceIdx);
  }

  /**
   * Process a mining event
   */
  public processEvent(event: MiningEvent): void {
    // Remove old connections if pool exists
    if (this.lastPoolEvents.has(event.poolName)) {
      this.removePoolConnections(event.poolName);
    }

    // Update with new branches
    this.lastPoolEvents.set(event.poolName, [...event.merkleBranches]);
    
    // Process new branches
    let previousBranch: string | null = null;
    const poolNode = this.getOrCreateNode(event.poolName, 'pool');
    
    event.merkleBranches.forEach((branch, index) => {
      const branchNode = this.getOrCreateNode(branch, 'branch', index);
      
      if (index === 0) {
        // Connect pool to first branch
        const connectionKey = `${poolNode}-${branchNode}`;
        
        // Check for cycles before adding
        if (!this.wouldCreateCycle(poolNode, branchNode)) {
          if (!this.activeConnections.has(connectionKey)) {
            this.activeConnections.set(connectionKey, new Set([event.poolName]));
          } else {
            this.activeConnections.get(connectionKey)!.add(event.poolName);
          }
        } else {
          console.warn(`Skipping connection ${poolNode}-${branchNode} to avoid cycle`);
        }
      } else if (previousBranch) {
        // Connect previous branch to current branch
        const prevBranchNode = this.getOrCreateNode(previousBranch, 'branch');
        const connectionKey = `${prevBranchNode}-${branchNode}`;
        
        // Check for cycles before adding
        if (!this.wouldCreateCycle(prevBranchNode, branchNode)) {
          if (!this.activeConnections.has(connectionKey)) {
            this.activeConnections.set(connectionKey, new Set([event.poolName]));
          } else {
            this.activeConnections.get(connectionKey)!.add(event.poolName);
          }
        } else {
          console.warn(`Skipping connection ${prevBranchNode}-${branchNode} to avoid cycle`);
        }
      }
      
      previousBranch = branch;
    });
  }

  /**
   * Process a Stratum V1 event from the global data stream
   */
  public processStratumV1Event(event: StratumV1Event): void {
    const poolName = event.data.pool_name;
    
    // Remove old connections if pool exists
    if (this.lastPoolEvents.has(poolName)) {
      this.removePoolConnections(poolName);
    }

    // Update with new branches
    this.lastPoolEvents.set(poolName, [...event.data.merkle_branches]);
    
    // Process new branches
    let previousBranch: string | null = null;
    const poolNode = this.getOrCreateNode(poolName, 'pool');
    
    event.data.merkle_branches.forEach((branch, index) => {
      const branchNode = this.getOrCreateNode(branch, 'branch', index);
      
      if (index === 0) {
        // Connect pool to first branch
        const connectionKey = `${poolNode}-${branchNode}`;
        
        // Check for cycles before adding
        if (!this.wouldCreateCycle(poolNode, branchNode)) {
          if (!this.activeConnections.has(connectionKey)) {
            this.activeConnections.set(connectionKey, new Set([poolName]));
          } else {
            this.activeConnections.get(connectionKey)!.add(poolName);
          }
        }
      } else if (previousBranch) {
        // Connect previous branch to current branch
        const prevBranchNode = this.getOrCreateNode(previousBranch, 'branch');
        const connectionKey = `${prevBranchNode}-${branchNode}`;
        
        // Check for cycles before adding
        if (!this.wouldCreateCycle(prevBranchNode, branchNode)) {
          if (!this.activeConnections.has(connectionKey)) {
            this.activeConnections.set(connectionKey, new Set([poolName]));
          } else {
            this.activeConnections.get(connectionKey)!.add(poolName);
          }
        }
      }
      
      previousBranch = branch;
    });
  }

  /**
   * Generate Sankey data for visualization
   */
  public getSankeyData(): SankeyData {
    // Find all nodes that have active connections
    const activeNodeIndices = new Set<number>();
    
    // Collect all node indices that appear in at least one connection
    this.activeConnections.forEach((_, key) => {
      const [source, target] = key.split('-').map(Number);
      activeNodeIndices.add(source);
      activeNodeIndices.add(target);
    });
    
    // Filter nodes to only include those with active connections
    const filteredNodes: SankeyNode[] = [];
    const oldToNewIndices = new Map<number, number>(); // Map to track index changes
    
    // Build the filtered nodes array and index mapping
    this.nodes.forEach((node, oldIndex) => {
      if (activeNodeIndices.has(oldIndex)) {
        oldToNewIndices.set(oldIndex, filteredNodes.length);
        filteredNodes.push(node);
      }
    });
    
    // Create links with updated indices
    const links: SankeyLink[] = [];
    this.activeConnections.forEach((pools, key) => {
      const [oldSource, oldTarget] = key.split('-').map(Number);
      // Use the new indices
      links.push({
        source: oldToNewIndices.get(oldSource)!, 
        target: oldToNewIndices.get(oldTarget)!,
        value: pools.size,
      });
    });
    
    // Log node reduction info if we filtered out any nodes
    if (this.nodes.length !== filteredNodes.length) {
      console.log(`Filtered out ${this.nodes.length - filteredNodes.length} unused nodes. ` +
                  `Reduced from ${this.nodes.length} to ${filteredNodes.length} nodes.`);
    }
    
    return { nodes: filteredNodes, links };
  }
  
  /**
   * Get the pools that are using a specific connection
   */
  public getPoolsForConnection(sourceId: number, targetId: number): string[] {
    const connectionKey = `${sourceId}-${targetId}`;
    const pools = this.activeConnections.get(connectionKey);
    return pools ? Array.from(pools) : [];
  }

  /**
   * Get all pools that use a specific merkle branch
   * This is more comprehensive than just checking direct links
   */
  public getPoolsUsingMerkleBranch(merkleBranchId: string): string[] {
    const connectedPools = new Set<string>();
    
    try {
      // First, find the node index that matches this merkle branch name
      let branchNodeIndex = -1;
      for (let i = 0; i < this.nodes.length; i++) {
        const node = this.nodes[i];
        if (node.type === 'branch' && node.name.toLowerCase() === merkleBranchId.toLowerCase()) {
          branchNodeIndex = i;
          break;
        }
      }
      
      if (branchNodeIndex >= 0) {
        // Check all active connections for this node
        this.activeConnections.forEach((pools, connectionKey) => {
          // Connection keys are in format "sourceId-targetId"
          const [sourceId, targetId] = connectionKey.split('-').map(Number);
          
          // If this branch appears in the connection, add all pools using it
          if (sourceId === branchNodeIndex || targetId === branchNodeIndex) {
            pools.forEach(pool => connectedPools.add(pool));
          }
        });
      }
      
      // Also check if any pools have this as their last merkle branch
      const lastBranchesForPools = this.getLastMerkleBranchesForPools();
      lastBranchesForPools.forEach((branchName, poolName) => {
        if (branchName.toLowerCase() === merkleBranchId.toLowerCase()) {
          connectedPools.add(poolName);
        }
      });
    } catch (error) {
      console.error('Error finding pools using merkle branch:', error);
    }
    
    return Array.from(connectedPools).sort();
  }
  
  /**
   * Get the last merkle branch for each pool
   * @returns Map of pool names to their last merkle branch names
   */
  public getLastMerkleBranchesForPools(): Map<string, string> {
    const lastBranches = new Map<string, string>();
    
    // Log all the pool events we're tracking
    console.log(`Processing ${this.lastPoolEvents.size} pool events for label rendering`);
    
    // Store all branch names for reference and debugging
    const allBranchNodes = new Set<string>();
    this.nodes.forEach(node => {
      if (node.type === 'branch') {
        allBranchNodes.add(node.name);
      }
    });
    console.log(`Total branch nodes in the system: ${allBranchNodes.size}`);
    
    this.lastPoolEvents.forEach((branches, poolName) => {
      if (branches.length > 0) {
        // Last branch is the last element in the array
        const lastBranch = branches[branches.length - 1];
        
        // Verify the branch exists in our nodes
        if (this.nodeIndex.has(lastBranch)) {
          lastBranches.set(poolName, lastBranch);
          console.log(`Pool ${poolName}: last branch = ${lastBranch} (verified in nodes)`);
        } else {
          // Try to find a matching node with different case
          let foundMatch = false;
          const lowerLastBranch = lastBranch.toLowerCase();
          
          for (const [nodeName, nodeId] of this.nodeIndex.entries()) {
            if (nodeName.toLowerCase() === lowerLastBranch && this.nodes[nodeId].type === 'branch') {
              // Use the actual case from the node index for better matching
              lastBranches.set(poolName, nodeName);
              console.log(`Pool ${poolName}: last branch = ${lastBranch} (case-insensitive match to ${nodeName})`);
              foundMatch = true;
              break;
            }
          }
          
          if (!foundMatch) {
            // If we still couldn't find a match, use any branch from this pool as a fallback
            for (let i = branches.length - 1; i >= 0; i--) {
              const altBranch = branches[i];
              if (this.nodeIndex.has(altBranch)) {
                lastBranches.set(poolName, altBranch);
                console.log(`Pool ${poolName}: using alternative branch = ${altBranch} (last branch ${lastBranch} not found)`);
                foundMatch = true;
                break;
              }
            }
            
            if (!foundMatch) {
              console.warn(`Pool ${poolName}: could not find any matching branch node for branches: ${branches.join(', ')}`);
            }
          }
        }
      } else {
        console.warn(`Pool ${poolName} has no merkle branches`);
      }
    });
    
    console.log(`Found ${lastBranches.size} pools with last branches out of ${this.lastPoolEvents.size} total pools`);
    
    // Ensure we have data to work with
    if (lastBranches.size === 0) {
      console.warn('No pools with last branches found. This may indicate an issue with data processing.');
      
      // Emergency fallback - directly map pools to any branch node
      this.lastPoolEvents.forEach((_, poolName) => {
        // Find any connection from this pool
        for (const [connectionKey, pools] of this.activeConnections.entries()) {
          if (pools.has(poolName)) {
            const [sourceId, targetId] = connectionKey.split('-').map(id => parseInt(id));
            const targetNode = this.nodes[targetId];
            
            if (targetNode && targetNode.type === 'branch') {
              lastBranches.set(poolName, targetNode.name);
              console.log(`EMERGENCY FALLBACK: Pool ${poolName} mapped to branch ${targetNode.name} via connection`);
              break;
            }
          }
        }
      });
    }
    
    return lastBranches;
  }

  /**
   * Reset all data
   */
  public reset(): void {
    this.lastPoolEvents.clear();
    this.activeConnections.clear();
    this.nodes = [];
    this.nodeIndex.clear();
  }
}

// Create a singleton instance
export const sankeyDataProcessor = new SankeyDataProcessor();
