import { StratumV1Data } from '@/lib/types';
import { CoinbaseOutputDetail, OpReturnData, AuxPowData } from './bitcoinUtils';

export enum TemplateChangeType {
  RSK_HASH = 'R',
  AUXPOW_HASH = 'A', 
  MERKLE_BRANCHES = 'M',
  SYSCOIN_HASH = 'S',
  CLEAN_JOBS = 'C',
  PREV_HASH = 'P',
  HEIGHT = 'H',
  OTHER = 'O'
}

export interface TemplateChangeResult {
  hasChanges: boolean;
  changeTypes: TemplateChangeType[];
  changeDetails: {
    rskHash?: { old?: string; new?: string };
    auxPowHash?: { old?: string; new?: string };
    syscoinHash?: { old?: string; new?: string };
    merkleBranches?: { old: string[]; new: string[] };
    cleanJobs?: { old: boolean | string; new: boolean | string };
    prevHash?: { old: string; new: string };
    height?: { old: number; new: number };
    otherChanges?: Array<{ field: string; old: any; new: any }>;
  };
}

interface ProcessedTemplate {
  poolName: string;
  jobId: string;
  height: number;
  rskHash?: string;
  auxPowHash?: string;
  syscoinHash?: string;
  merkleBranches: string[];
  cleanJobs: boolean | string;
  prevHash: string;
  version: string;
  nbits?: string;
  ntime?: string;
}

// Cache for processed templates to avoid re-processing
const templateCache = new Map<string, ProcessedTemplate>();
const MAX_TEMPLATE_CACHE_SIZE = 100;

// Cache for last template per pool to enable comparison
const lastTemplateByPool = new Map<string, ProcessedTemplate>();


function extractRskHash(coinbaseOutputs?: CoinbaseOutputDetail[]): string | undefined {
  if (!coinbaseOutputs) return undefined;
  
  for (const output of coinbaseOutputs) {
    if (output.type === 'nulldata' && output.decodedData?.protocol === 'RSK Block') {
      return output.decodedData.details?.rskBlockHash;
    }
  }
  return undefined;
}

function extractSyscoinHash(coinbaseOutputs?: CoinbaseOutputDetail[]): string | undefined {
  if (!coinbaseOutputs) return undefined;
  
  for (const output of coinbaseOutputs) {
    if (output.type === 'nulldata' && output.decodedData?.protocol === 'Syscoin') {
      return output.decodedData.details?.relatedHash;
    }
  }
  return undefined;
}

function extractAuxPowHash(auxPowData?: AuxPowData | null): string | undefined {
  return auxPowData?.auxHashOrRoot;
}

function processTemplate(
  data: StratumV1Data, 
  coinbaseOutputs?: CoinbaseOutputDetail[],
  auxPowData?: AuxPowData | null
): ProcessedTemplate {
  const cacheKey = `${data.pool_name}-${data.job_id}-${data.height}`;
  
  if (templateCache.has(cacheKey)) {
    return templateCache.get(cacheKey)!;
  }
  
  const processed: ProcessedTemplate = {
    poolName: data.pool_name,
    jobId: data.job_id,
    height: data.height,
    rskHash: extractRskHash(coinbaseOutputs),
    auxPowHash: extractAuxPowHash(auxPowData),
    syscoinHash: extractSyscoinHash(coinbaseOutputs),
    merkleBranches: [...data.merkle_branches],
    cleanJobs: data.clean_jobs,
    prevHash: data.prev_hash,
    version: data.version,
    nbits: data.nbits,
    ntime: data.ntime
  };
  
  // Manage cache size
  if (templateCache.size >= MAX_TEMPLATE_CACHE_SIZE) {
    const firstKey = templateCache.keys().next().value;
    if (firstKey !== undefined) {
      templateCache.delete(firstKey);
    }
  }
  
  templateCache.set(cacheKey, processed);
  return processed;
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, index) => val === b[index]);
}

// Cache for processed change detection results to prevent duplicate processing
const changeDetectionCache = new Map<string, TemplateChangeResult>();
const MAX_CHANGE_DETECTION_CACHE_SIZE = 200;

export function detectTemplateChanges(
  data: StratumV1Data,
  coinbaseOutputs?: CoinbaseOutputDetail[],
  auxPowData?: AuxPowData | null
): TemplateChangeResult {
  // Create a unique key for this specific data point to prevent duplicate processing
  const changeDetectionKey = `${data.pool_name}-${data.job_id}-${data.height}-${data.timestamp}`;
  
  // Return cached result if we've already processed this exact data point
  if (changeDetectionCache.has(changeDetectionKey)) {
    return changeDetectionCache.get(changeDetectionKey)!;
  }
  
  const currentTemplate = processTemplate(data, coinbaseOutputs, auxPowData);
  const lastTemplate = lastTemplateByPool.get(data.pool_name);
  
  // If no previous template, this is the first one (show large circle but no change indicators)
  if (!lastTemplate) {
    // Store current template as the last template for this pool
    lastTemplateByPool.set(data.pool_name, currentTemplate);
    const result = {
      hasChanges: true, // Always show large circles
      changeTypes: [],
      changeDetails: {}
    };
    
    // Cache the result and manage cache size
    if (changeDetectionCache.size >= MAX_CHANGE_DETECTION_CACHE_SIZE) {
      const firstKey = changeDetectionCache.keys().next().value;
      if (firstKey !== undefined) {
        changeDetectionCache.delete(firstKey);
      }
    }
    changeDetectionCache.set(changeDetectionKey, result);
    return result;
  }
  
  // For duplicate job IDs, still show large circles but no change indicators
  if (lastTemplate.jobId === currentTemplate.jobId) {
    // Update the stored template even for duplicates to prevent stale comparisons
    lastTemplateByPool.set(data.pool_name, currentTemplate);
    const result = {
      hasChanges: true, // Always show large circles
      changeTypes: [],
      changeDetails: {}
    };
    
    // Cache the result and manage cache size
    if (changeDetectionCache.size >= MAX_CHANGE_DETECTION_CACHE_SIZE) {
      const firstKey = changeDetectionCache.keys().next().value;
      if (firstKey !== undefined) {
        changeDetectionCache.delete(firstKey);
      }
    }
    changeDetectionCache.set(changeDetectionKey, result);
    return result;
  }
  
  const changeTypes: TemplateChangeType[] = [];
  const changeDetails: TemplateChangeResult['changeDetails'] = {};
  
  // Check RSK hash changes - only if both values are defined or one changes from/to defined
  if ((lastTemplate.rskHash || currentTemplate.rskHash) && 
      lastTemplate.rskHash !== currentTemplate.rskHash) {
    changeTypes.push(TemplateChangeType.RSK_HASH);
    changeDetails.rskHash = {
      old: lastTemplate.rskHash,
      new: currentTemplate.rskHash
    };
  }
  
  // Check AuxPOW hash changes - only if both values are defined or one changes from/to defined
  if ((lastTemplate.auxPowHash || currentTemplate.auxPowHash) && 
      lastTemplate.auxPowHash !== currentTemplate.auxPowHash) {
    changeTypes.push(TemplateChangeType.AUXPOW_HASH);
    changeDetails.auxPowHash = {
      old: lastTemplate.auxPowHash,
      new: currentTemplate.auxPowHash
    };
  }
  
  // Check Syscoin hash changes - only if both values are defined or one changes from/to defined
  if ((lastTemplate.syscoinHash || currentTemplate.syscoinHash) && 
      lastTemplate.syscoinHash !== currentTemplate.syscoinHash) {
    changeTypes.push(TemplateChangeType.SYSCOIN_HASH);
    changeDetails.syscoinHash = {
      old: lastTemplate.syscoinHash,
      new: currentTemplate.syscoinHash
    };
  }
  
  // Check merkle branches changes
  if (!arraysEqual(lastTemplate.merkleBranches, currentTemplate.merkleBranches)) {
    changeTypes.push(TemplateChangeType.MERKLE_BRANCHES);
    changeDetails.merkleBranches = {
      old: lastTemplate.merkleBranches,
      new: currentTemplate.merkleBranches
    };
  }
  
  // Check clean jobs changes - only track when clean jobs becomes true
  if (lastTemplate.cleanJobs !== currentTemplate.cleanJobs && currentTemplate.cleanJobs === true) {
    changeTypes.push(TemplateChangeType.CLEAN_JOBS);
    changeDetails.cleanJobs = {
      old: lastTemplate.cleanJobs,
      new: currentTemplate.cleanJobs
    };
  }
  
  // Check prev hash changes
  if (lastTemplate.prevHash !== currentTemplate.prevHash) {
    changeTypes.push(TemplateChangeType.PREV_HASH);
    changeDetails.prevHash = {
      old: lastTemplate.prevHash,
      new: currentTemplate.prevHash
    };
  }
  
  // Check height changes
  if (lastTemplate.height !== currentTemplate.height) {
    changeTypes.push(TemplateChangeType.HEIGHT);
    changeDetails.height = {
      old: lastTemplate.height,
      new: currentTemplate.height
    };
  }
  
  // Detect other template changes not covered by specific tracked types
  const otherChanges: Array<{ field: string; old: any; new: any }> = [];
  
  // Check all fields for changes (except those already tracked above)
  const fieldsToCheck = [
    { field: 'version', old: lastTemplate.version, new: currentTemplate.version },
    { field: 'nbits', old: lastTemplate.nbits, new: currentTemplate.nbits },
    { field: 'ntime', old: lastTemplate.ntime, new: currentTemplate.ntime }
  ];
  
  // Add clean jobs changes if not already tracked (when it's not becoming true)
  if (lastTemplate.cleanJobs !== currentTemplate.cleanJobs && currentTemplate.cleanJobs !== true) {
    fieldsToCheck.push({ field: 'cleanJobs', old: lastTemplate.cleanJobs as any, new: currentTemplate.cleanJobs as any });
  }
  
  fieldsToCheck.forEach(({ field, old, new: newVal }) => {
    if (old !== newVal) {
      otherChanges.push({ field, old, new: newVal });
    }
  });
  
  // Add other changes to details if any exist
  if (otherChanges.length > 0) {
    changeDetails.otherChanges = otherChanges;
    // Add OTHER type if no other specific changes were detected
    if (changeTypes.length === 0) {
      changeTypes.push(TemplateChangeType.OTHER);
    }
  }
  
  // Store current template as the last template for this pool (after all comparisons)
  lastTemplateByPool.set(data.pool_name, currentTemplate);
  
  const result = {
    hasChanges: true, // Always true if we reach here (different job ID means template changed)
    changeTypes,
    changeDetails
  };
  
  // Cache the result and manage cache size
  if (changeDetectionCache.size >= MAX_CHANGE_DETECTION_CACHE_SIZE) {
    const firstKey = changeDetectionCache.keys().next().value;
    if (firstKey !== undefined) {
      changeDetectionCache.delete(firstKey);
    }
  }
  changeDetectionCache.set(changeDetectionKey, result);
  return result;
}

export function getChangeTypeDisplay(changeTypes: TemplateChangeType[]): string {
  if (changeTypes.length === 0) return ''; // Empty string for untracked changes (will show empty circle)
  if (changeTypes.length === 1) return changeTypes[0];
  
  // For multiple changes, combine them
  const sortedTypes = [...changeTypes].sort();
  return sortedTypes.join('');
}

export function getChangeTypeDescription(changeType: TemplateChangeType): string {
  switch (changeType) {
    case TemplateChangeType.RSK_HASH:
      return 'RSK merge mining hash updated';
    case TemplateChangeType.AUXPOW_HASH:
      return 'AuxPOW hash updated';
    case TemplateChangeType.MERKLE_BRANCHES:
      return 'Transaction merkle branches changed';
    case TemplateChangeType.SYSCOIN_HASH:
      return 'Syscoin merge mining hash updated';
    case TemplateChangeType.CLEAN_JOBS:
      return 'Clean jobs flag changed';
    case TemplateChangeType.PREV_HASH:
      return 'Previous block hash changed';
    case TemplateChangeType.HEIGHT:
      return 'Block height changed';
    case TemplateChangeType.OTHER:
      return 'Other template changes';
    default:
      return 'Template updated';
  }
}

// Utility to clear cache (useful for testing or memory management)
export function clearTemplateCache(): void {
  templateCache.clear();
  lastTemplateByPool.clear();
  changeDetectionCache.clear();
}