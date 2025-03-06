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
  private getOrCreateNode(name: string, type: 'pool' | 'branch'): number {
    if (!this.nodeIndex.has(name)) {
      this.nodeIndex.set(name, this.nodes.length);
      this.nodes.push({ name, type });
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
      const branchNode = this.getOrCreateNode(branch, 'branch');
      
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
    // Convert the Stratum V1 event to our internal format
    const miningEvent: MiningEvent = {
      poolName: event.data.pool_name,
      merkleBranches: event.data.merkle_branches
    };
    
    // Process the converted event
    this.processEvent(miningEvent);
  }

  /**
   * Generate Sankey data for visualization
   */
  public getSankeyData(): SankeyData {
    const links: SankeyLink[] = [];
    
    this.activeConnections.forEach((sources, connection) => {
      const [sourceIdx, targetIdx] = connection.split('-');
      links.push({
        source: parseInt(sourceIdx),
        target: parseInt(targetIdx),
        value: sources.size // Number of pools using this connection
      });
    });

    return { 
      nodes: [...this.nodes], 
      links 
    };
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
