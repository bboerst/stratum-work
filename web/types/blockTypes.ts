export interface MiningPool {
  id: number;
  name: string;
  tag?: string;
  datum_template_creator?: string;
  datum_gateway_default?: string;   // a DATUM gateway's default tag: miner-built, the miner unnamed
  link?: string;
  slug?: string;
  match_type?: string;
  identification_method?: 'address' | 'tag';
}

export interface Block { 
  height: number; 
  block_hash: string; 
  timestamp: number;
  mining_pool?: MiningPool;
  isRealtime?: boolean; // Flag to indicate if this block came from real-time updates
  /** Other blocks found at this height, now stale (from /api/blocks; absent when there are none). */
  stale_siblings?: Array<{ block_hash: string; pool: string | null }>;
  analysis?: {
    flags?: Array<{
      key: string;
      icon: 'fork' | 'error' | string;
      title?: string;
      tooltip?: string;
      details?: Record<string, unknown>;
    }>;
  };
} 