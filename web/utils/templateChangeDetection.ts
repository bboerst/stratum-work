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
  /**
   * True when this message was received out of chronological order for its
   * pool (i.e. it is older than the pool's current baseline). Out-of-order
   * messages are compared against the in-order baseline for context but never
   * replace it, so a late arrival cannot corrupt subsequent comparisons.
   */
  outOfOrder?: boolean;
}

type ProcessedTemplate = ProcessedTemplateData;

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

/**
 * The comparison is intentionally exhaustive: every field that ends up in
 * ProcessedTemplateData is compared. Nothing is ignored at comparison time;
 * display-level filtering of noisy fields (nTime, output value, witness
 * commitment, coinbase ASCII tag) happens in getChangeTypeDisplay. Keeping
 * comparison exhaustive means researchers see true content equality — two
 * consecutive templates with identical content produce zero change types.
 */
function compareTemplates(
  lastTemplate: ProcessedTemplate,
  currentTemplate: ProcessedTemplate
): Pick<TemplateChangeResult, 'changeTypes' | 'changeDetails'> {
  const changeTypes: TemplateChangeType[] = [];
  const changeDetails: TemplateChangeResult['changeDetails'] = {};

  const push = (type: TemplateChangeType) => {
    if (!changeTypes.includes(type)) changeTypes.push(type);
  };

  // AuxPOW hash (separate from OP_RETURN protocols)
  if ((lastTemplate.auxPowHash || currentTemplate.auxPowHash) &&
      lastTemplate.auxPowHash !== currentTemplate.auxPowHash) {
    push(TemplateChangeType.AUXPOW_HASH);
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
        push(getProtocolChangeType(protocol));
      }
    }

    // Check for new protocols
    for (const [protocol] of newProtocols) {
      if (!oldProtocols.has(protocol)) {
        changedProtocols.push(protocol);
        push(getProtocolChangeType(protocol));
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
    push(TemplateChangeType.MERKLE_BRANCHES);
    changeDetails.merkleBranches = {
      old: lastTemplate.merkleBranches,
      new: currentTemplate.merkleBranches
    };
  }

  // Clean jobs - only track when becoming true
  if (lastTemplate.cleanJobs !== currentTemplate.cleanJobs && currentTemplate.cleanJobs === true) {
    push(TemplateChangeType.CLEAN_JOBS);
    changeDetails.cleanJobs = {
      old: lastTemplate.cleanJobs,
      new: currentTemplate.cleanJobs
    };
  }

  // Core stratum fields
  if (lastTemplate.prevHash !== currentTemplate.prevHash) {
    push(TemplateChangeType.PREV_HASH);
    changeDetails.prevHash = {
      old: lastTemplate.prevHash,
      new: currentTemplate.prevHash
    };
  }

  if (lastTemplate.height !== currentTemplate.height) {
    push(TemplateChangeType.HEIGHT);
    changeDetails.height = {
      old: lastTemplate.height,
      new: currentTemplate.height
    };
  }

  if (lastTemplate.version !== currentTemplate.version) {
    push(TemplateChangeType.VERSION);
    changeDetails.version = {
      old: lastTemplate.version,
      new: currentTemplate.version
    };
  }

  if ((lastTemplate.nbits || currentTemplate.nbits) &&
      lastTemplate.nbits !== currentTemplate.nbits) {
    push(TemplateChangeType.NBITS);
    changeDetails.nbits = {
      old: lastTemplate.nbits,
      new: currentTemplate.nbits
    };
  }

  if ((lastTemplate.ntime || currentTemplate.ntime) &&
      lastTemplate.ntime !== currentTemplate.ntime) {
    push(TemplateChangeType.NTIME);
    changeDetails.ntime = {
      old: lastTemplate.ntime,
      new: currentTemplate.ntime
    };
  }

  if (lastTemplate.extranonce2Length !== currentTemplate.extranonce2Length) {
    push(TemplateChangeType.EXTRANONCE2_LENGTH);
    changeDetails.extranonce2Length = {
      old: lastTemplate.extranonce2Length,
      new: currentTemplate.extranonce2Length
    };
  }

  // Transaction fields
  if (lastTemplate.txVersion !== currentTemplate.txVersion) {
    push(TemplateChangeType.TX_VERSION);
    changeDetails.txVersion = {
      old: lastTemplate.txVersion,
      new: currentTemplate.txVersion
    };
  }

  if (lastTemplate.txLocktime !== currentTemplate.txLocktime) {
    push(TemplateChangeType.TX_LOCKTIME);
    changeDetails.txLocktime = {
      old: lastTemplate.txLocktime,
      new: currentTemplate.txLocktime
    };
  }

  if (lastTemplate.inputSequence !== currentTemplate.inputSequence) {
    push(TemplateChangeType.INPUT_SEQUENCE);
    changeDetails.inputSequence = {
      old: lastTemplate.inputSequence,
      new: currentTemplate.inputSequence
    };
  }

  if (lastTemplate.witnessCommitmentNonce !== currentTemplate.witnessCommitmentNonce) {
    push(TemplateChangeType.WITNESS_NONCE);
    changeDetails.witnessNonce = {
      old: lastTemplate.witnessCommitmentNonce,
      new: currentTemplate.witnessCommitmentNonce
    };
  }

  // Coinbase fields
  if (lastTemplate.coinbaseScriptASCII !== currentTemplate.coinbaseScriptASCII) {
    push(TemplateChangeType.COINBASE_ASCII);
    changeDetails.coinbaseAscii = {
      old: lastTemplate.coinbaseScriptASCII,
      new: currentTemplate.coinbaseScriptASCII
    };
  }

  if (lastTemplate.coinbaseOutputValue !== currentTemplate.coinbaseOutputValue) {
    push(TemplateChangeType.COINBASE_OUTPUT_VALUE);
    changeDetails.coinbaseOutputValue = {
      old: lastTemplate.coinbaseOutputValue,
      new: currentTemplate.coinbaseOutputValue
    };
  }

  if (!coinbaseOutputsStructurallyEqual(lastTemplate.coinbaseOutputs, currentTemplate.coinbaseOutputs)) {
    push(TemplateChangeType.COINBASE_OUTPUTS);
    changeDetails.coinbaseOutputs = {
      old: lastTemplate.coinbaseOutputs,
      new: currentTemplate.coinbaseOutputs
    };
  }

  // AuxPOW fields
  if (lastTemplate.auxPowMerkleSize !== currentTemplate.auxPowMerkleSize) {
    push(TemplateChangeType.AUXPOW_MERKLE_SIZE);
    changeDetails.auxPowMerkleSize = {
      old: lastTemplate.auxPowMerkleSize,
      new: currentTemplate.auxPowMerkleSize
    };
  }

  if (lastTemplate.auxPowNonce !== currentTemplate.auxPowNonce) {
    push(TemplateChangeType.AUXPOW_NONCE);
    changeDetails.auxPowNonce = {
      old: lastTemplate.auxPowNonce,
      new: currentTemplate.auxPowNonce
    };
  }

  return { changeTypes, changeDetails };
}

/**
 * Parse the stratum message timestamp into a millisecond number for
 * chronological ordering. Handles the collector's hex-nanosecond format,
 * ISO-like date strings, and plain numeric strings. Returns NaN when the
 * timestamp cannot be interpreted.
 */
export function parseMessageTimestampMs(ts: string | number | undefined): number {
  if (ts === undefined || ts === null) return NaN;
  if (typeof ts === 'number') return ts;

  // Strict ISO 8601 shape only. This keeps the parser in the millisecond
  // domain and prevents numeric strings from being misread as hex, while also
  // rejecting values like "1001" that Date.parse would treat as a year.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(ts)) {
    const asDate = new Date(ts.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(ts) ? ts : ts + 'Z').getTime();
    if (!isNaN(asDate)) return asDate;
  }

  // Collector format: hex nanoseconds, optionally 0x-prefixed.
  if (/^(0x)?[0-9a-fA-F]+$/.test(ts)) {
    const cleaned = ts.replace(/^0x/, '');
    const asHexNs = parseInt(cleaned, 16);
    if (!isNaN(asHexNs)) return asHexNs / 1e6;
  }

  const asNumber = Number(ts);
  return isNaN(asNumber) ? NaN : asNumber;
}

/**
 * A lightweight per-pool key used only to recognize the exact message most
 * recently processed, so duplicate ingestion of the identical message is a
 * stable no-op rather than a second comparison against an updated baseline.
 */
function messageKey(data: StratumV1Data): string {
  return [
    data.job_id,
    data.height,
    data.timestamp,
    data.prev_hash,
    data.merkle_branches.join(','),
    data.coinbase1,
    data.extranonce1,
    data.extranonce2_length,
    data.coinbase2,
  ].join('|');
}

interface PoolBaseline {
  template: ProcessedTemplate;
  timestampMs: number;
  rawKey: string;
}

// Bound the per-pool result cache so long-running sessions don't grow without
// limit. Each pool emits a template at most a few times per second, so a few
// hundred entries is far more than the visible chart window ever needs.
const MAX_RESULTS_PER_POOL = 500;

/**
 * Change detection is inherently stateful: each message must be compared
 * against the chronologically-previous message from the same pool. The old
 * module-level implementation broke this invariant in several ways:
 *
 *  1. Duplicate job_ids were short-circuited as "no changes" even when the
 *     template content had changed (pools sometimes re-send a job id after
 *     modifying the transaction set), silently dropping real changes.
 *  2. An out-of-order older template was compared against the newer baseline
 *     but then blocked from replacing it only by a height guard — which let
 *     same-height regressions through and produced reversed diffs.
 *  3. A global FIFO result cache could evict an entry and cause a message to
 *     be re-compared against the *current* baseline instead of the baseline
 *     it originally saw, yielding different results on re-render.
 *
 * This class keeps exactly one baseline per pool — the newest message seen,
 * by timestamp — and compares each incoming message against it. Duplicate or
 * older messages never replace the baseline.
 */
export class TemplateChangeTracker {
  private baselineByPool = new Map<string, PoolBaseline>();
  // Per-pool cache of already-computed results, keyed by full message content.
  // The live stream only retains the latest template per pool+height and
  // re-feeds it to the chart on every render, so the same message is processed
  // many times. Caching by content makes processing idempotent: each unique
  // template always reports the diff computed against its chronological
  // predecessor, instead of being re-diffed against a newer baseline (or
  // against itself) on replay.
  private resultsByPool = new Map<string, Map<string, TemplateChangeResult>>();

  private getPoolResults(pool: string): Map<string, TemplateChangeResult> {
    let results = this.resultsByPool.get(pool);
    if (!results) {
      results = new Map();
      this.resultsByPool.set(pool, results);
    }
    return results;
  }

  private cacheResult(pool: string, rawKey: string, result: TemplateChangeResult): TemplateChangeResult {
    const results = this.getPoolResults(pool);
    if (results.size >= MAX_RESULTS_PER_POOL) {
      const firstKey = results.keys().next().value;
      if (firstKey !== undefined) results.delete(firstKey);
    }
    results.set(rawKey, result);
    return result;
  }

  process(data: StratumV1Data): TemplateChangeResult {
    const pool = data.pool_name;
    const rawKey = messageKey(data);

    // Idempotency: if we've already computed this exact template's diff,
    // return it verbatim regardless of how the baseline has since moved.
    const cached = this.resultsByPool.get(pool)?.get(rawKey);
    if (cached) {
      return cached;
    }

    const currentTemplate = processTemplateData(data);
    const currentTimestampMs = parseMessageTimestampMs(data.timestamp);
    const baseline = this.baselineByPool.get(pool);

    // First template for this pool: establish the baseline.
    if (!baseline) {
      this.baselineByPool.set(pool, { template: currentTemplate, timestampMs: currentTimestampMs, rawKey });
      return this.cacheResult(pool, rawKey, { hasChanges: true, changeTypes: [], changeDetails: {} });
    }

    const bothTimestampsValid = !isNaN(currentTimestampMs) && !isNaN(baseline.timestampMs);
    const regressed = bothTimestampsValid && currentTimestampMs < baseline.timestampMs;

    // A regressed height means we switched to a different chain tip (e.g. the
    // user navigated to a historical block, or a new block was found). Treat
    // this message as a fresh baseline rather than diffing across heights.
    // When the message is also chronologically older than the baseline it is
    // additionally flagged as out-of-order.
    if (currentTemplate.height < baseline.template.height) {
      this.baselineByPool.set(pool, { template: currentTemplate, timestampMs: currentTimestampMs, rawKey });
      return this.cacheResult(pool, rawKey, { hasChanges: true, changeTypes: [], changeDetails: {}, ...(regressed ? { outOfOrder: true } : {}) });
    }

    // Out-of-order delivery: the message is older than the baseline. Compare
    // for context but never let it replace the baseline, so a late arrival
    // cannot corrupt subsequent comparisons.
    if (regressed) {
      const { changeTypes, changeDetails } = compareTemplates(baseline.template, currentTemplate);
      return this.cacheResult(pool, rawKey, { hasChanges: true, changeTypes, changeDetails, outOfOrder: true });
    }

    // In-order message: compare against the baseline and advance it.
    const { changeTypes, changeDetails } = compareTemplates(baseline.template, currentTemplate);
    this.baselineByPool.set(pool, { template: currentTemplate, timestampMs: currentTimestampMs, rawKey });
    return this.cacheResult(pool, rawKey, { hasChanges: true, changeTypes, changeDetails });
  }

  /** Reset one pool's baseline and cached results, or every pool's when no pool is given. */
  reset(poolName?: string): void {
    if (poolName) {
      this.baselineByPool.delete(poolName);
      this.resultsByPool.delete(poolName);
    } else {
      this.baselineByPool.clear();
      this.resultsByPool.clear();
    }
  }
}

export function createTemplateChangeTracker(): TemplateChangeTracker {
  return new TemplateChangeTracker();
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

  // For multiple changes, combine them (deduplicated, sorted for determinism)
  const uniqueTypes = [...new Set(visibleChangeTypes)].sort();
  return uniqueTypes.join('');
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

/**
 * Testing / memory-management helper: clears the template processor's derived
 * -data cache. Tracker instances own their own baselines, so there is no
 * global change-detection state left to clear — instantiate a fresh tracker
 * (or call tracker.reset()) for a clean slate.
 */
export function clearTemplateProcessorCache(): void {
  clearProcessorCache();
}
