import { StratumV1Data } from '@/lib/types';
import { CoinbaseOutputDetail, OpReturnData, AuxPowData } from './bitcoinUtils';

export enum TemplateChangeType {
  RSK_HASH = 'R',
  AUXPOW_HASH = 'A', 
  MERKLE_BRANCHES = 'M',
  SYSCOIN_HASH = 'S',
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
    merkleBranches: [...data.merkle_branches]
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

export function detectTemplateChanges(
  data: StratumV1Data,
  coinbaseOutputs?: CoinbaseOutputDetail[],
  auxPowData?: AuxPowData | null
): TemplateChangeResult {
  const currentTemplate = processTemplate(data, coinbaseOutputs, auxPowData);
  const lastTemplate = lastTemplateByPool.get(data.pool_name);
  
  // Store current template as the last template for this pool
  lastTemplateByPool.set(data.pool_name, currentTemplate);
  
  // If no previous template, this is the first one (no changes to detect)
  if (!lastTemplate) {
    return {
      hasChanges: false,
      changeTypes: [],
      changeDetails: {}
    };
  }
  
  // Skip comparison if it's the same job ID (duplicate message)
  if (lastTemplate.jobId === currentTemplate.jobId) {
    return {
      hasChanges: false,
      changeTypes: [],
      changeDetails: {}
    };
  }
  
  const changeTypes: TemplateChangeType[] = [];
  const changeDetails: TemplateChangeResult['changeDetails'] = {};
  
  // Check RSK hash changes
  if (lastTemplate.rskHash !== currentTemplate.rskHash) {
    changeTypes.push(TemplateChangeType.RSK_HASH);
    changeDetails.rskHash = {
      old: lastTemplate.rskHash,
      new: currentTemplate.rskHash
    };
  }
  
  // Check AuxPOW hash changes
  if (lastTemplate.auxPowHash !== currentTemplate.auxPowHash) {
    changeTypes.push(TemplateChangeType.AUXPOW_HASH);
    changeDetails.auxPowHash = {
      old: lastTemplate.auxPowHash,
      new: currentTemplate.auxPowHash
    };
  }
  
  // Check Syscoin hash changes
  if (lastTemplate.syscoinHash !== currentTemplate.syscoinHash) {
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
  
  return {
    hasChanges: changeTypes.length > 0,
    changeTypes,
    changeDetails
  };
}

export function getChangeTypeDisplay(changeTypes: TemplateChangeType[]): string {
  if (changeTypes.length === 0) return '';
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
}