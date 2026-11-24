import { StratumV1Data } from '@/lib/types';
import { processTemplateData, ProcessedTemplateData, templateContentKey, clearProcessedDataCache as clearProcessorCache } from './templateDataProcessor';

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

  // scriptSig bytes other than the height, AuxPoW and text tag (coinbaseParser's byte map)
  SCRIPTSIG_DATA = 'S',          // pushed binary data: counters, nonces, ids, or the push layout itself
  SCRIPTSIG_TIME = 'Y',          // a pushed Unix time (the pool's clock)

  // Our connection, not the template: extranonce1 changed (a reconnect, or the stream switched to another connection)
  SESSION = 'R',

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
  OP_RETURN_OCB1 = 'Ö̶',          // OCB1 marker (O with diaeresis and strikethrough, avoiding the Omni O̶)
  OP_RETURN_EMPTY = 'Ø̶',         // Empty OP_RETURN (Ø with strikethrough)
  OP_RETURN_OTHER = 'Ω̶',         // Unknown or malformed OP_RETURN (Ω with strikethrough)

  // Backstop: the coinbase bytes changed and none of the types above explains it (e.g. a coinbase that doesn't parse)
  OTHER = 'O'
}

/**
 * Change types computed but not drawn on the timing chart's bars, because they change on almost every template. On
 * 2 hours of production templates (27,132 consecutive pairs), scriptSig data (S) changed on 81% of them: most pools
 * write a fresh nonce or clock value into every job. They still show in the tooltip.
 */
export const HIDDEN_CHANGE_TYPES: ReadonlySet<TemplateChangeType> = new Set([
  TemplateChangeType.NTIME,
  TemplateChangeType.COINBASE_OUTPUT_VALUE,
  TemplateChangeType.OP_RETURN_WITNESS,
  TemplateChangeType.COINBASE_ASCII,
  TemplateChangeType.SCRIPTSIG_TIME,
  TemplateChangeType.SCRIPTSIG_DATA,
]);

/**
 * How a result came about:
 * - `first`: the pool's first template since the last reset; nothing to compare with (not the same as "identical").
 * - `compared`: compared with the pool's previous template; `changeTypes` empty means identical content.
 * - `outOfOrder`: received before the pool's latest template, so it isn't compared (a diff against the newer
 *   template would run backwards) and doesn't replace the baseline.
 */
export type ChangeStatus = 'first' | 'compared' | 'outOfOrder';

export interface TemplateChangeResult {
  status: ChangeStatus;
  /** True when at least one change type was found. */
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
    coinbaseOutputValue?: { old: number; new: number; oldValues?: number[]; newValues?: number[] };
    coinbaseOutputs?: { old: any[]; new: any[] };
    auxPowMerkleSize?: { old?: number | null; new?: number | null };
    auxPowNonce?: { old?: number | null; new?: number | null };

    // scriptSig
    scriptSigData?: { old: string; new: string };
    scriptSigTime?: { old: number | null; new: number | null };

    // Individual OP_RETURN protocol changes
    opReturnProtocols?: {
      old: Map<string, any>;
      new: Map<string, any>;
      changed: string[]; // List of protocol names that changed
    };

    otherChanges?: Array<{ field: string; old: any; new: any }>;
  };
  /** Same as status === 'outOfOrder' (kept for existing readers). */
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
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!objectsEqual(a[key], b[key])) return false;
  }

  return true;
}

const isOpReturnScript = (hex: string) => hex.startsWith('6a');

// Output structure: the number of outputs, which ones are OP_RETURN, and every non-OP_RETURN script (payout
// addresses and other scripts). OP_RETURN contents are compared per protocol, values separately (Q).
function coinbaseOutputsStructurallyEqual(a: ProcessedTemplate, b: ProcessedTemplate): boolean {
  if (a.coinbase.parsed && b.coinbase.parsed) {
    const sa = a.coinbase.outputScripts, sb = b.coinbase.outputScripts;
    if (sa.length !== sb.length) return false;
    for (let i = 0; i < sa.length; i++) {
      const opA = isOpReturnScript(sa[i]), opB = isOpReturnScript(sb[i]);
      if (opA !== opB) return false;
      if (!opA && sa[i] !== sb[i]) return false;
    }
    return true;
  }
  // Unparsed coinbase: the decoded outputs are all there is.
  const oa = a.coinbaseOutputs, ob = b.coinbaseOutputs;
  if (oa.length !== ob.length) return false;
  for (let i = 0; i < oa.length; i++) {
    if (oa[i].type !== ob[i].type) return false;
    if (oa[i].type !== 'nulldata' && oa[i].hex !== ob[i].hex) return false;
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

// Get protocol-specific change type. Map keys for repeated protocols carry " #2", " #3"...
function getProtocolChangeType(key: string): TemplateChangeType {
  const protocol = key.replace(/ #\d+$/, '');
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
    case 'OCB1':
      return TemplateChangeType.OP_RETURN_OCB1;
    case 'Empty OP_RETURN':
    case 'OP_RETURN (0 byte)':
      return TemplateChangeType.OP_RETURN_EMPTY;
    default:
      return TemplateChangeType.OP_RETURN_OTHER;
  }
}

// Types that account for a change in the coinbase bytes (for the OTHER backstop).
const COINBASE_TYPES: ReadonlySet<TemplateChangeType> = new Set(
  Object.values(TemplateChangeType).filter(t =>
    t !== TemplateChangeType.MERKLE_BRANCHES && t !== TemplateChangeType.CLEAN_JOBS && t !== TemplateChangeType.PREV_HASH &&
    t !== TemplateChangeType.VERSION && t !== TemplateChangeType.NBITS && t !== TemplateChangeType.NTIME &&
    t !== TemplateChangeType.OTHER
  ) as TemplateChangeType[]
);

const isCleanJobs = (v: boolean | string | undefined) => v === true || (typeof v === 'string' && v.toLowerCase() === 'true');

/**
 * The comparison is exhaustive: every field of the template is compared, and a change in the coinbase bytes that no
 * specific type explains is reported as OTHER, so two consecutive templates produce zero change types only when their
 * content is identical (extranonce bytes aside, which are per connection and per share). Display-level filtering of
 * noisy fields happens in getChangeTypeDisplay (HIDDEN_CHANGE_TYPES).
 */
export function compareTemplates(
  lastTemplate: ProcessedTemplate,
  currentTemplate: ProcessedTemplate
): Pick<TemplateChangeResult, 'changeTypes' | 'changeDetails'> {
  const changeTypes: TemplateChangeType[] = [];
  const changeDetails: TemplateChangeResult['changeDetails'] = {};
  const a = lastTemplate.coinbase, b = currentTemplate.coinbase;
  const bothParsed = a.parsed && b.parsed;

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

  // clean_jobs is a per-message flag ("drop earlier jobs"), false on most templates: flag every message that sets it,
  // including two in a row (e.g. two new blocks with no update between them).
  if (isCleanJobs(currentTemplate.cleanJobs)) {
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

  // Our connection: a new extranonce1 means a new session (or another connection's stream).
  if (a.extranonce1 !== b.extranonce1) {
    push(TemplateChangeType.SESSION);
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

  // scriptSig, from coinbaseParser's byte map: the text tag in full, a pushed time, the pool's other pushed bytes.
  const tagsChanged = bothParsed ? a.scriptSigTags !== b.scriptSigTags
    : lastTemplate.coinbaseScriptASCII !== currentTemplate.coinbaseScriptASCII;
  if (tagsChanged) {
    push(TemplateChangeType.COINBASE_ASCII);
    changeDetails.coinbaseAscii = {
      old: lastTemplate.coinbaseScriptASCII,
      new: currentTemplate.coinbaseScriptASCII
    };
  }

  if (bothParsed && a.scriptSigTime !== b.scriptSigTime) {
    push(TemplateChangeType.SCRIPTSIG_TIME);
    changeDetails.scriptSigTime = { old: a.scriptSigTime, new: b.scriptSigTime };
  }

  if (bothParsed && a.scriptSigData !== b.scriptSigData) {
    push(TemplateChangeType.SCRIPTSIG_DATA);
    changeDetails.scriptSigData = { old: a.scriptSigData, new: b.scriptSigData };
  }

  // Output values: any output's value, not only the total (a payout moving between outputs keeps the total).
  const valuesChanged = bothParsed ? !arraysEqual(a.outputValues, b.outputValues)
    : lastTemplate.coinbaseOutputValue !== currentTemplate.coinbaseOutputValue;
  if (valuesChanged) {
    push(TemplateChangeType.COINBASE_OUTPUT_VALUE);
    changeDetails.coinbaseOutputValue = {
      old: lastTemplate.coinbaseOutputValue,
      new: currentTemplate.coinbaseOutputValue,
      ...(bothParsed ? { oldValues: a.outputValues, newValues: b.outputValues } : {}),
    };
  }

  if (!coinbaseOutputsStructurallyEqual(lastTemplate, currentTemplate)) {
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

  // The rest of the scriptSig (push headers, the height push, the AuxPoW bytes): a change there that none of the
  // scriptSig types explains (a longer tag or extranonce moves its push header too) is a change in the push layout.
  if (bothParsed && a.scriptSigStructure !== b.scriptSigStructure) {
    const explained = [TemplateChangeType.HEIGHT, TemplateChangeType.AUXPOW_HASH, TemplateChangeType.AUXPOW_MERKLE_SIZE,
      TemplateChangeType.AUXPOW_NONCE, TemplateChangeType.COINBASE_ASCII, TemplateChangeType.SCRIPTSIG_TIME,
      TemplateChangeType.SCRIPTSIG_DATA, TemplateChangeType.EXTRANONCE2_LENGTH, TemplateChangeType.SESSION,
    ].some(t => changeTypes.includes(t));
    if (!explained) {
      push(TemplateChangeType.SCRIPTSIG_DATA);
      changeDetails.scriptSigData = { old: a.scriptSigStructure, new: b.scriptSigStructure };
    }
  }

  // Backstop: the coinbase bytes (extranonce aside) changed, but nothing above says how.
  const coinbaseBytesChanged = a.coinbase1 !== b.coinbase1 || a.coinbase2 !== b.coinbase2
    || a.extranonce1.length !== b.extranonce1.length;
  if (coinbaseBytesChanged && !changeTypes.some(t => COINBASE_TYPES.has(t))) {
    push(TemplateChangeType.OTHER);
    changeDetails.otherChanges = [{ field: 'coinbase', old: 'unparsed difference', new: 'unparsed difference' }];
  }

  return { changeTypes, changeDetails };
}

/**
 * Parse the stratum message timestamp into a millisecond number for
 * chronological ordering. Handles the collector's hex-nanosecond format,
 * ISO-like date strings, and plain numeric strings. Returns NaN when the
 * timestamp cannot be interpreted. Hex nanoseconds are read with BigInt and
 * kept to the microsecond (the stored precision), so order is exact.
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
  if (/^(0[xX])?[0-9a-fA-F]+$/.test(ts)) {
    const cleaned = ts.replace(/^0[xX]/, '');
    try {
      return Number(BigInt('0x' + cleaned) / BigInt(1000)) / 1000;
    } catch {
      return NaN;
    }
  }

  const asNumber = Number(ts);
  return isNaN(asNumber) ? NaN : asNumber;
}

interface PoolBaseline {
  template: ProcessedTemplate;
  timestampMs: number;
}

// Bound the per-pool result cache so long-running sessions don't grow without limit.
const MAX_RESULTS_PER_POOL = 500;

/**
 * Change detection is stateful: each message is compared with the previous message from the same pool, in receive
 * order. Callers feed each pool's messages sorted by receive time (`timestamp`, not the latency-adjusted time: that is
 * for drawing, and adjusting by each copy's own latency estimate could reorder them).
 *
 * One baseline per pool, the newest message seen. A message older than the baseline isn't compared (status
 * `outOfOrder`) and never replaces it. Results are cached by full message content, so feeding the same message again
 * returns the same result instead of comparing it with itself.
 */
export class TemplateChangeTracker {
  private baselineByPool = new Map<string, PoolBaseline>();
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
    const rawKey = templateContentKey(data);

    const cached = this.resultsByPool.get(pool)?.get(rawKey);
    if (cached) {
      return cached;
    }

    const currentTemplate = processTemplateData(data);
    const currentTimestampMs = parseMessageTimestampMs(data.timestamp);
    const baseline = this.baselineByPool.get(pool);

    // First template for this pool: establish the baseline.
    if (!baseline) {
      this.baselineByPool.set(pool, { template: currentTemplate, timestampMs: currentTimestampMs });
      return this.cacheResult(pool, rawKey, { status: 'first', hasChanges: false, changeTypes: [], changeDetails: {} });
    }

    const bothTimestampsValid = !isNaN(currentTimestampMs) && !isNaN(baseline.timestampMs);
    if (bothTimestampsValid && currentTimestampMs < baseline.timestampMs) {
      return this.cacheResult(pool, rawKey, {
        status: 'outOfOrder', hasChanges: false, changeTypes: [], changeDetails: {}, outOfOrder: true,
      });
    }

    // In order (a lower height too: a pool going back to an older tip is a change like any other).
    const { changeTypes, changeDetails } = compareTemplates(baseline.template, currentTemplate);
    this.baselineByPool.set(pool, { template: currentTemplate, timestampMs: currentTimestampMs });
    return this.cacheResult(pool, rawKey, { status: 'compared', hasChanges: changeTypes.length > 0, changeTypes, changeDetails });
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

  const visibleChangeTypes = changeTypes.filter(type => !HIDDEN_CHANGE_TYPES.has(type));

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
    case TemplateChangeType.SCRIPTSIG_DATA:
      return 'Coinbase scriptSig data changed';
    case TemplateChangeType.SCRIPTSIG_TIME:
      return 'Coinbase scriptSig time changed';
    case TemplateChangeType.SESSION:
      return 'New connection session (extranonce1 changed)';
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
    case TemplateChangeType.OP_RETURN_OCB1:
      return 'OCB1 OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_EMPTY:
      return 'Empty OP_RETURN changed';
    case TemplateChangeType.OP_RETURN_OTHER:
      return 'Unknown or malformed OP_RETURN changed';

    case TemplateChangeType.OTHER:
      return 'Coinbase changed (not otherwise classified)';
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
