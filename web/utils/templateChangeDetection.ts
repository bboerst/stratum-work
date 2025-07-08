import { StratumV1Data } from '@/lib/types';
import { processTemplateData, ProcessedTemplateData, clearProcessedDataCache as clearProcessorCache } from './templateDataProcessor';

export enum TemplateChangeType {
  // Core template fields
  AUXPOW_HASH = 'A', 
  MERKLE_BRANCHES = 'M',
  CLEAN_JOBS = 'C',
  PREV_HASH = 'P',
  HEIGHT = 'H',
  VERSION = 'V',
  NBITS = 'N',
  NTIME = 'T',
  EXTRANONCE2_LENGTH = 'E',
  
  // Transaction fields
  TX_VERSION = 'X',
  TX_LOCKTIME = 'L',
  INPUT_SEQUENCE = 'I',
  WITNESS_NONCE = 'W',
  COINBASE_ASCII = 'Z',
  COINBASE_OUTPUT_VALUE = 'Q',
  COINBASE_OUTPUTS = 'U',
  AUXPOW_MERKLE_SIZE = 'K',
  AUXPOW_NONCE = 'J',
  
  // Individual OP_RETURN protocol changes (struck-through letters representing protocol names)
  OP_RETURN_RSK = 'R̶',           // RSK Block (R with strikethrough)
  OP_RETURN_COREDAO = 'C̶',       // CoreDAO (C with strikethrough)
  OP_RETURN_SYSCOIN = 'S̶',       // Syscoin (S with strikethrough)
  OP_RETURN_HATHOR = 'H̶',        // Hathor Network (H with strikethrough)
  OP_RETURN_EXSAT = 'E̶',         // ExSat (E with strikethrough)
  OP_RETURN_OMNI = 'O̶',          // Omni (O with strikethrough)
  OP_RETURN_RUNESTONE = 'U̶',     // Runestone (U with strikethrough, avoiding R conflict)
  OP_RETURN_WITNESS = 'W̶',       // WitnessCommitment (W with strikethrough)
  OP_RETURN_STACKS = 'T̶',        // Stacks Block Commit (T with strikethrough, avoiding S conflict)
  OP_RETURN_BIP47 = 'B̶',         // BIP47 Payment Code (B with strikethrough)
  OP_RETURN_EMPTY = 'Ø̶',         // Empty OP_RETURN (Ø with strikethrough)
  OP_RETURN_OTHER = 'Ω̶',         // Other OP_RETURN protocols (Ω with strikethrough)
  
  // Generic fallback
  OTHER = 'O'
}

export interface TemplateChangeResult {
  hasChanges: boolean;
  changeTypes: TemplateChangeType[];
  changeDetails: {
    // AuxPOW hash (separate from OP_RETURN protocols)
    auxPowHash?: { old?: string; new?: string };
    
    // Core template fields
    merkleBranches?: { old: string[]; new: string[] };
    cleanJobs?: { old: boolean | string; new: boolean | string };
    prevHash?: { old: string; new: string };
    height?: { old: number; new: number };
    version?: { old: string; new: string };
    nbits?: { old?: string; new?: string };
    ntime?: { old?: string; new?: string };
    extranonce2Length?: { old: number; new: number };
    
    // Transaction fields
    txVersion?: { old?: number; new?: number };
    txLocktime?: { old?: number; new?: number };
    inputSequence?: { old?: number; new?: number };
    witnessNonce?: { old?: string | null; new?: string | null };
    coinbaseAscii?: { old: string; new: string };
    coinbaseOutputValue?: { old: number; new: number };
    coinbaseOutputs?: { old: any[]; new: any[] };
    auxPowMerkleSize?: { old?: number | null; new?: number | null };
    auxPowNonce?: { old?: number | null; new?: number | null };
    
    // Individual OP_RETURN protocol changes
    opReturnProtocols?: {
      old: Map<string, any>;
      new: Map<string, any>;
      changed: string[]; // List of protocol names that changed
    };
    
    otherChanges?: Array<{ field: string; old: any; new: any }>;
  };
}

// Use the ProcessedTemplateData interface from templateDataProcessor
type ProcessedTemplate = ProcessedTemplateData;

// Cache for last template per pool to enable comparison
const lastTemplateByPool = new Map<string, ProcessedTemplate>();

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, index) => val === b[index]);
}

// Deep comparison for objects
function objectsEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  
  if (keysA.length !== keysB.length) return false;
  
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!objectsEqual(a[key], b[key])) return false;
  }
  
  return true;
}

// Compare coinbase outputs for true structural changes only (not content/value/OP_RETURN data changes)
function coinbaseOutputsStructurallyEqual(a: any[], b: any[]): boolean {
  // Different number of outputs = structural change
  if (a.length !== b.length) return false;
  
  for (let i = 0; i < a.length; i++) {
    const outputA = a[i];
    const outputB = b[i];
    
    // Check if output type changed (address vs nulldata vs unknown)
    if (outputA.type !== outputB.type) return false;
    
    // For address outputs, check if the address changed (not value)
    if (outputA.type === 'address' && outputA.address !== outputB.address) return false;
    
    // For nulldata (OP_RETURN) outputs, only check if the protocol type changed
    // Don't check the actual data content since that's tracked separately by OP_RETURN protocol tracking
    if (outputA.type === 'nulldata') {
      const protocolA = outputA.decodedData?.protocol;
      const protocolB = outputB.decodedData?.protocol;
      if (protocolA !== protocolB) return false;
    }
    
    // For unknown outputs, check if the script type/hex changed significantly
    if (outputA.type === 'unknown' && outputA.hex !== outputB.hex) return false;
  }
  
  return true;
}

// Compare Maps for OP_RETURN protocols
function mapsEqual(a: Map<string, any>, b: Map<string, any>): boolean {
  if (a.size !== b.size) return false;
  
  for (const [key, value] of a) {
    if (!b.has(key) || !objectsEqual(value, b.get(key))) {
      return false;
    }
  }
  
  return true;
}

// Get protocol-specific change type
function getProtocolChangeType(protocol: string): TemplateChangeType {
  switch (protocol) {
    case 'RSK Block':
      return TemplateChangeType.OP_RETURN_RSK;
    case 'CoreDAO':
      return TemplateChangeType.OP_RETURN_COREDAO;
    case 'Syscoin':
      return TemplateChangeType.OP_RETURN_SYSCOIN;
    case 'Hathor Network':
      return TemplateChangeType.OP_RETURN_HATHOR;
    case 'ExSat':
      return TemplateChangeType.OP_RETURN_EXSAT;
    case 'Omni':
      return TemplateChangeType.OP_RETURN_OMNI;
    case 'Runestone':
      return TemplateChangeType.OP_RETURN_RUNESTONE;
    case 'WitnessCommitment':
      return TemplateChangeType.OP_RETURN_WITNESS;
    case 'Stacks Block Commit':
      return TemplateChangeType.OP_RETURN_STACKS;
    case 'BIP47 Payment Code':
      return TemplateChangeType.OP_RETURN_BIP47;
    case 'Empty OP_RETURN':
    case 'OP_RETURN (0 byte)':
      return TemplateChangeType.OP_RETURN_EMPTY;
    default:
      return TemplateChangeType.OP_RETURN_OTHER;
  }
}

// Cache for processed change detection results to prevent duplicate processing
const changeDetectionCache = new Map<string, TemplateChangeResult>();
const MAX_CHANGE_DETECTION_CACHE_SIZE = 200;

export function detectTemplateChanges(
  data: StratumV1Data
): TemplateChangeResult {
  // Create a unique key for this specific data point to prevent duplicate processing
  const changeDetectionKey = `${data.pool_name}-${data.job_id}-${data.height}-${data.timestamp}`;
  
  // Return cached result if we've already processed this exact data point
  if (changeDetectionCache.has(changeDetectionKey)) {
    return changeDetectionCache.get(changeDetectionKey)!;
  }
  
  const currentTemplate = processTemplateData(data);
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
  
  // Comprehensive field change detection
  
  // AuxPOW hash (separate from OP_RETURN protocols)
  if ((lastTemplate.auxPowHash || currentTemplate.auxPowHash) && 
      lastTemplate.auxPowHash !== currentTemplate.auxPowHash) {
    changeTypes.push(TemplateChangeType.AUXPOW_HASH);
    changeDetails.auxPowHash = {
      old: lastTemplate.auxPowHash,
      new: currentTemplate.auxPowHash
    };
  }
  
  // Individual OP_RETURN protocol changes
  if (!mapsEqual(lastTemplate.opReturnProtocols, currentTemplate.opReturnProtocols)) {
    const oldProtocols = lastTemplate.opReturnProtocols;
    const newProtocols = currentTemplate.opReturnProtocols;
    const changedProtocols: string[] = [];
    
    // Check for changed/removed protocols
    for (const [protocol, oldData] of oldProtocols) {
      const newData = newProtocols.get(protocol);
      if (!newData || !objectsEqual(oldData, newData)) {
        changedProtocols.push(protocol);
        changeTypes.push(getProtocolChangeType(protocol));
      }
    }
    
    // Check for new protocols
    for (const [protocol, newData] of newProtocols) {
      if (!oldProtocols.has(protocol)) {
        changedProtocols.push(protocol);
        changeTypes.push(getProtocolChangeType(protocol));
      }
    }
    
    if (changedProtocols.length > 0) {
      changeDetails.opReturnProtocols = {
        old: oldProtocols,
        new: newProtocols,
        changed: changedProtocols
      };
    }
  }
  
  // Merkle branches
  if (!arraysEqual(lastTemplate.merkleBranches, currentTemplate.merkleBranches)) {
    changeTypes.push(TemplateChangeType.MERKLE_BRANCHES);
    changeDetails.merkleBranches = {
      old: lastTemplate.merkleBranches,
      new: currentTemplate.merkleBranches
    };
  }
  
  // Clean jobs - only track when becoming true
  if (lastTemplate.cleanJobs !== currentTemplate.cleanJobs && currentTemplate.cleanJobs === true) {
    changeTypes.push(TemplateChangeType.CLEAN_JOBS);
    changeDetails.cleanJobs = {
      old: lastTemplate.cleanJobs,
      new: currentTemplate.cleanJobs
    };
  }
  
  // Core stratum fields
  if (lastTemplate.prevHash !== currentTemplate.prevHash) {
    changeTypes.push(TemplateChangeType.PREV_HASH);
    changeDetails.prevHash = {
      old: lastTemplate.prevHash,
      new: currentTemplate.prevHash
    };
  }
  
  if (lastTemplate.height !== currentTemplate.height) {
    changeTypes.push(TemplateChangeType.HEIGHT);
    changeDetails.height = {
      old: lastTemplate.height,
      new: currentTemplate.height
    };
  }
  
  if (lastTemplate.version !== currentTemplate.version) {
    changeTypes.push(TemplateChangeType.VERSION);
    changeDetails.version = {
      old: lastTemplate.version,
      new: currentTemplate.version
    };
  }
  
  if ((lastTemplate.nbits || currentTemplate.nbits) && 
      lastTemplate.nbits !== currentTemplate.nbits) {
    changeTypes.push(TemplateChangeType.NBITS);
    changeDetails.nbits = {
      old: lastTemplate.nbits,
      new: currentTemplate.nbits
    };
  }
  
  if ((lastTemplate.ntime || currentTemplate.ntime) && 
      lastTemplate.ntime !== currentTemplate.ntime) {
    changeTypes.push(TemplateChangeType.NTIME);
    changeDetails.ntime = {
      old: lastTemplate.ntime,
      new: currentTemplate.ntime
    };
  }
  
  if (lastTemplate.extranonce2Length !== currentTemplate.extranonce2Length) {
    changeTypes.push(TemplateChangeType.EXTRANONCE2_LENGTH);
    changeDetails.extranonce2Length = {
      old: lastTemplate.extranonce2Length,
      new: currentTemplate.extranonce2Length
    };
  }
  
  // Transaction fields
  if (lastTemplate.txVersion !== currentTemplate.txVersion) {
    changeTypes.push(TemplateChangeType.TX_VERSION);
    changeDetails.txVersion = {
      old: lastTemplate.txVersion,
      new: currentTemplate.txVersion
    };
  }
  
  if (lastTemplate.txLocktime !== currentTemplate.txLocktime) {
    changeTypes.push(TemplateChangeType.TX_LOCKTIME);
    changeDetails.txLocktime = {
      old: lastTemplate.txLocktime,
      new: currentTemplate.txLocktime
    };
  }
  
  if (lastTemplate.inputSequence !== currentTemplate.inputSequence) {
    changeTypes.push(TemplateChangeType.INPUT_SEQUENCE);
    changeDetails.inputSequence = {
      old: lastTemplate.inputSequence,
      new: currentTemplate.inputSequence
    };
  }
  
  if (lastTemplate.witnessCommitmentNonce !== currentTemplate.witnessCommitmentNonce) {
    changeTypes.push(TemplateChangeType.WITNESS_NONCE);
    changeDetails.witnessNonce = {
      old: lastTemplate.witnessCommitmentNonce,
      new: currentTemplate.witnessCommitmentNonce
    };
  }
  
  // Coinbase fields
  
  if (lastTemplate.coinbaseScriptASCII !== currentTemplate.coinbaseScriptASCII) {
    changeTypes.push(TemplateChangeType.COINBASE_ASCII);
    changeDetails.coinbaseAscii = {
      old: lastTemplate.coinbaseScriptASCII,
      new: currentTemplate.coinbaseScriptASCII
    };
  }
  
  if (lastTemplate.coinbaseOutputValue !== currentTemplate.coinbaseOutputValue) {
    changeTypes.push(TemplateChangeType.COINBASE_OUTPUT_VALUE);
    changeDetails.coinbaseOutputValue = {
      old: lastTemplate.coinbaseOutputValue,
      new: currentTemplate.coinbaseOutputValue
    };
  }
  
  if (!coinbaseOutputsStructurallyEqual(lastTemplate.coinbaseOutputs, currentTemplate.coinbaseOutputs)) {
    changeTypes.push(TemplateChangeType.COINBASE_OUTPUTS);
    changeDetails.coinbaseOutputs = {
      old: lastTemplate.coinbaseOutputs,
      new: currentTemplate.coinbaseOutputs
    };
  }
  
  // AuxPOW fields
  if (lastTemplate.auxPowMerkleSize !== currentTemplate.auxPowMerkleSize) {
    changeTypes.push(TemplateChangeType.AUXPOW_MERKLE_SIZE);
    changeDetails.auxPowMerkleSize = {
      old: lastTemplate.auxPowMerkleSize,
      new: currentTemplate.auxPowMerkleSize
    };
  }
  
  if (lastTemplate.auxPowNonce !== currentTemplate.auxPowNonce) {
    changeTypes.push(TemplateChangeType.AUXPOW_NONCE);
    changeDetails.auxPowNonce = {
      old: lastTemplate.auxPowNonce,
      new: currentTemplate.auxPowNonce
    };
  }
  
  // Only store current template if it's from the same height or newer (prevent out-of-order overwrites)
  if (currentTemplate.height >= lastTemplate.height) {
    lastTemplateByPool.set(data.pool_name, currentTemplate);
  }
  
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
  
  // Filter out change types that should not be displayed in circle plots
  const hiddenChangeTypes = new Set([
    TemplateChangeType.NTIME,              // nTime changes
    TemplateChangeType.COINBASE_OUTPUT_VALUE, // Output value changes  
    TemplateChangeType.OP_RETURN_WITNESS,  // Witness Commit changes
    TemplateChangeType.COINBASE_ASCII      // Coinbase ASCII tag changes
  ]);
  
  const visibleChangeTypes = changeTypes.filter(type => !hiddenChangeTypes.has(type));
  
  if (visibleChangeTypes.length === 0) return ''; // Empty string if only hidden changes
  if (visibleChangeTypes.length === 1) return visibleChangeTypes[0];
  
  // For multiple changes, combine them
  const sortedTypes = [...visibleChangeTypes].sort();
  return sortedTypes.join('');
}

export function getChangeTypeDescription(changeType: TemplateChangeType): string {
  switch (changeType) {
    // Core template fields
    case TemplateChangeType.AUXPOW_HASH:
      return 'AuxPOW hash updated';
    case TemplateChangeType.MERKLE_BRANCHES:
      return 'Transaction merkle branches changed';
    case TemplateChangeType.CLEAN_JOBS:
      return 'Clean jobs flag changed';
    case TemplateChangeType.PREV_HASH:
      return 'Previous block hash changed';
    case TemplateChangeType.HEIGHT:
      return 'Block height changed';
    case TemplateChangeType.VERSION:
      return 'Block version changed';
    case TemplateChangeType.NBITS:
      return 'Difficulty target (nBits) changed';
    case TemplateChangeType.NTIME:
      return 'Block timestamp (nTime) changed';
    case TemplateChangeType.EXTRANONCE2_LENGTH:
      return 'Extranonce2 length changed';
      
    // Transaction fields
    case TemplateChangeType.TX_VERSION:
      return 'Transaction version changed';
    case TemplateChangeType.TX_LOCKTIME:
      return 'Transaction locktime changed';
    case TemplateChangeType.INPUT_SEQUENCE:
      return 'Input sequence changed';
    case TemplateChangeType.WITNESS_NONCE:
      return 'Witness commitment nonce changed';
    case TemplateChangeType.COINBASE_ASCII:
      return 'Coinbase ASCII tag changed';
    case TemplateChangeType.COINBASE_OUTPUT_VALUE:
      return 'Coinbase output value changed';
    case TemplateChangeType.COINBASE_OUTPUTS:
      return 'Coinbase output structure changed';
    case TemplateChangeType.AUXPOW_MERKLE_SIZE:
      return 'AuxPOW merkle size changed';
    case TemplateChangeType.AUXPOW_NONCE:
      return 'AuxPOW nonce changed';
      
    // Individual OP_RETURN protocol changes
    case TemplateChangeType.OP_RETURN_RSK:
      return 'RSK Block OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_COREDAO:
      return 'CoreDAO OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_SYSCOIN:
      return 'Syscoin OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_HATHOR:
      return 'Hathor Network OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_EXSAT:
      return 'ExSat OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_OMNI:
      return 'Omni OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_RUNESTONE:
      return 'Runestone OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_WITNESS:
      return 'Witness Commitment OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_STACKS:
      return 'Stacks Block Commit OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_BIP47:
      return 'BIP47 Payment Code OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_EMPTY:
      return 'Empty OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_OTHER:
      return 'Other OP_RETURN protocol changed';
      
    case TemplateChangeType.OTHER:
      return 'Other template changes';
    default:
      return 'Template updated';
  }
}

// Utility to clear cache (useful for testing or memory management)
export function clearTemplateCache(): void {
  lastTemplateByPool.clear();
  changeDetectionCache.clear();
  clearProcessorCache();
}