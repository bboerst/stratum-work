export interface MiningPool {
  id: number;
  name: string;
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