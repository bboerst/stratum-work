import { StratumV1Data } from '@/lib/types';
import { processTemplateData, ProcessedTemplateData, CoinbaseContent, OpReturnEntry, templateContentKey, clearProcessedDataCache as clearProcessorCache } from './templateDataProcessor';

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

  // Our connection, not the template: extranonce1 changed (a reconnect; another connection isn't compared at all)
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
 * - `gap`: templates from the pool weren't received just before this one (the stream throttled a burst, the page was
 *   paused, the stream reconnected, or the live stream started after the history pre-fill), so it isn't compared: the
 *   diff wouldn't be with its predecessor.
 * - `otherConnection`: received on another of our connections than the pool's previous template (the stream or a
 *   history read switched connection, e.g. during a reconnect). Some pools give each connection its own jobs, so a
 *   diff would show differences between connections, not changes to the work. Not compared.
 * - `compared`: compared with the pool's previous template; `changeTypes` empty means identical content.
 * - `outOfOrder`: received before the pool's latest template, so it isn't compared (a diff against the newer
 *   template would run backwards) and doesn't replace the baseline.
 */
export type ChangeStatus = 'first' | 'gap' | 'otherConnection' | 'compared' | 'outOfOrder';

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
    cleanJobs?: { old: boolean; new: boolean };
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
    coinbaseOutputs?: { old: string[]; new: string[] }; // each output's script (hex, extranonce bytes as "..")
    auxPowMerkleSize?: { old?: number | null; new?: number | null };
    auxPowNonce?: { old?: number | null; new?: number | null };

    // scriptSig
    scriptSigData?: { old: string; new: string };
    scriptSigTime?: { old: number | null; new: number | null };

    // Individual OP_RETURN protocol changes
    opReturnProtocols?: {
      old: Map<string, OpReturnEntry>;
      new: Map<string, OpReturnEntry>;
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

// Output structure: the number of outputs, which are OP_RETURN (and of which protocol, by position), and every other
// output's script (payout addresses and other scripts). OP_RETURN contents are compared per protocol, values as Q.
function outputStructureEqual(a: CoinbaseContent, b: CoinbaseContent): boolean {
  if (a.outputScripts.length !== b.outputScripts.length) return false;
  for (let i = 0; i < a.outputScripts.length; i++) {
    if (a.outputProtocols[i] !== b.outputProtocols[i]) return false;
    if (a.outputProtocols[i] === null && a.outputScripts[i] !== b.outputScripts[i]) return false;
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

/**
 * The comparison is exhaustive. Every mining.notify field is compared (job id and receive time aside), after
 * normalising them the way the collector stores them. The coinbase is compared field by field, from coinbaseParser's
 * byte map. A coinbase that doesn't parse on either side is compared as a whole and reported as OTHER.
 *
 * So two consecutive templates produce zero change types only when their content is identical. There are two
 * exceptions:
 *  - the extranonce bytes, which belong to the connection and the miner (a new extranonce1 is reported as SESSION);
 *  - clean_jobs going back to false, its default.
 *
 * Display-level filtering of noisy fields happens in getChangeTypeDisplay (HIDDEN_CHANGE_TYPES).
 */
export function compareTemplates(
  lastTemplate: ProcessedTemplate,
  currentTemplate: ProcessedTemplate
): Pick<TemplateChangeResult, 'changeTypes' | 'changeDetails'> {
  const changeTypes: TemplateChangeType[] = [];
  const changeDetails: TemplateChangeResult['changeDetails'] = {};
  const a = lastTemplate.coinbase, b = currentTemplate.coinbase;
  const fired = (t: TemplateChangeType) => changeTypes.includes(t);

  const push = (type: TemplateChangeType) => {
    if (!changeTypes.includes(type)) changeTypes.push(type);
  };

  // --- mining.notify fields ---

  if (!arraysEqual(lastTemplate.merkleBranches, currentTemplate.merkleBranches)) {
    push(TemplateChangeType.MERKLE_BRANCHES);
    changeDetails.merkleBranches = { old: lastTemplate.merkleBranches, new: currentTemplate.merkleBranches };
  }

  // clean_jobs is a per-message flag ("drop earlier jobs"), false on most templates: flag every message that sets it,
  // including two in a row (e.g. two new blocks with no update between them).
  if (currentTemplate.cleanJobs) {
    push(TemplateChangeType.CLEAN_JOBS);
    changeDetails.cleanJobs = { old: lastTemplate.cleanJobs, new: currentTemplate.cleanJobs };
  }

  if (lastTemplate.prevHash !== currentTemplate.prevHash) {
    push(TemplateChangeType.PREV_HASH);
    changeDetails.prevHash = { old: lastTemplate.prevHash, new: currentTemplate.prevHash };
  }

  if (lastTemplate.height !== currentTemplate.height) {
    push(TemplateChangeType.HEIGHT);
    changeDetails.height = { old: lastTemplate.height, new: currentTemplate.height };
  }

  if (lastTemplate.version !== currentTemplate.version) {
    push(TemplateChangeType.VERSION);
    changeDetails.version = { old: lastTemplate.version, new: currentTemplate.version };
  }

  if (lastTemplate.nbits !== currentTemplate.nbits) {
    push(TemplateChangeType.NBITS);
    changeDetails.nbits = { old: lastTemplate.nbits, new: currentTemplate.nbits };
  }

  if (lastTemplate.ntime !== currentTemplate.ntime) {
    push(TemplateChangeType.NTIME);
    changeDetails.ntime = { old: lastTemplate.ntime, new: currentTemplate.ntime };
  }

  if (lastTemplate.extranonce2Length !== currentTemplate.extranonce2Length) {
    push(TemplateChangeType.EXTRANONCE2_LENGTH);
    changeDetails.extranonce2Length = { old: lastTemplate.extranonce2Length, new: currentTemplate.extranonce2Length };
  }

  // Our connection: a new extranonce1 on the same connection means a new session (a reconnect).
  if (a.extranonce1 !== b.extranonce1) {
    push(TemplateChangeType.SESSION);
  }

  // --- the coinbase ---

  if (!(a.parsed && b.parsed)) {
    // No byte map on at least one side: compare the pool's bytes as a whole, and don't guess which field changed.
    if (a.coinbase1 !== b.coinbase1 || a.coinbase2 !== b.coinbase2) {
      push(TemplateChangeType.OTHER);
      changeDetails.otherChanges = [{
        field: 'coinbase (not parsed)',
        old: a.parsed ? 'parsed' : 'unparsed',
        new: b.parsed ? 'parsed' : 'unparsed',
      }];
    }
    return { changeTypes, changeDetails };
  }

  if (a.version !== b.version) {
    push(TemplateChangeType.TX_VERSION);
    changeDetails.txVersion = { old: a.version ?? undefined, new: b.version ?? undefined };
  }
  if (a.locktime !== b.locktime) {
    push(TemplateChangeType.TX_LOCKTIME);
    changeDetails.txLocktime = { old: a.locktime ?? undefined, new: b.locktime ?? undefined };
  }
  if (a.sequenceMasked !== b.sequenceMasked) {
    push(TemplateChangeType.INPUT_SEQUENCE);
    changeDetails.inputSequence = { old: a.sequence ?? undefined, new: b.sequence ?? undefined };
  }
  if (a.witness !== b.witness) {
    push(TemplateChangeType.WITNESS_NONCE);
    changeDetails.witnessNonce = { old: a.witness || null, new: b.witness || null };
  }
  if (a.prevout !== b.prevout) {
    // Always null in a valid coinbase; no type of its own.
    push(TemplateChangeType.OTHER);
    changeDetails.otherChanges = [{ field: 'coinbase prevout', old: a.prevout, new: b.prevout }];
  }

  // scriptSig. Nothing is reported when the pool's bytes are the same, so a byte that the parser files differently
  // in the next template (a pushed time moving out of the ±2 h window, binary that happens to look like text) can't
  // show as a change.
  if (a.scriptSigPool !== b.scriptSigPool) {
    const ar = a.auxpow, br = b.auxpow;
    if ((ar?.root ?? null) !== (br?.root ?? null)) {
      push(TemplateChangeType.AUXPOW_HASH);
      changeDetails.auxPowHash = { old: ar?.root, new: br?.root };
    }
    if ((ar?.merkleSize ?? null) !== (br?.merkleSize ?? null)) {
      push(TemplateChangeType.AUXPOW_MERKLE_SIZE);
      changeDetails.auxPowMerkleSize = { old: ar?.merkleSize, new: br?.merkleSize };
    }
    if ((ar?.nonce ?? null) !== (br?.nonce ?? null)) {
      push(TemplateChangeType.AUXPOW_NONCE);
      changeDetails.auxPowNonce = { old: ar?.nonce, new: br?.nonce };
    }
    if (a.scriptSigTags !== b.scriptSigTags) {
      push(TemplateChangeType.COINBASE_ASCII);
      changeDetails.coinbaseAscii = { old: a.scriptSigTags, new: b.scriptSigTags };
    }
    if (a.scriptSigTime !== null && b.scriptSigTime !== null && a.scriptSigTime !== b.scriptSigTime) {
      push(TemplateChangeType.SCRIPTSIG_TIME);
      changeDetails.scriptSigTime = { old: a.scriptSigTime, new: b.scriptSigTime };
    }
    if (a.scriptSigData !== b.scriptSigData || (a.scriptSigTime === null) !== (b.scriptSigTime === null)) {
      push(TemplateChangeType.SCRIPTSIG_DATA);
      changeDetails.scriptSigData = { old: a.scriptSigData, new: b.scriptSigData };
    }
    // Only push headers or the height push changed: the push layout (unless a longer extranonce or height moved it).
    const explained = [TemplateChangeType.HEIGHT, TemplateChangeType.AUXPOW_HASH, TemplateChangeType.AUXPOW_MERKLE_SIZE,
      TemplateChangeType.AUXPOW_NONCE, TemplateChangeType.COINBASE_ASCII, TemplateChangeType.SCRIPTSIG_TIME,
      TemplateChangeType.SCRIPTSIG_DATA, TemplateChangeType.EXTRANONCE2_LENGTH, TemplateChangeType.SESSION].some(fired);
    if (!explained) {
      push(TemplateChangeType.SCRIPTSIG_DATA);
      changeDetails.scriptSigData = { old: a.scriptSigPool, new: b.scriptSigPool };
    }
  }

  // Outputs: every value (a payout moving between outputs keeps the total), the structure, every OP_RETURN.
  if (!arraysEqual(a.outputValues, b.outputValues)) {
    push(TemplateChangeType.COINBASE_OUTPUT_VALUE);
    const sum = (v: number[]) => v.reduce((x, y) => x + y, 0);
    changeDetails.coinbaseOutputValue = {
      old: sum(a.outputValues), new: sum(b.outputValues), oldValues: a.outputValues, newValues: b.outputValues,
    };
  }

  if (!outputStructureEqual(a, b)) {
    push(TemplateChangeType.COINBASE_OUTPUTS);
    changeDetails.coinbaseOutputs = { old: a.outputScripts, new: b.outputScripts };
  }

  const oldProtocols = lastTemplate.opReturnProtocols;
  const newProtocols = currentTemplate.opReturnProtocols;
  const changedProtocols: string[] = [];
  for (const [key, oldEntry] of oldProtocols) {
    if (newProtocols.get(key)?.cmp !== oldEntry.cmp) changedProtocols.push(key);
  }
  for (const key of newProtocols.keys()) {
    if (!oldProtocols.has(key)) changedProtocols.push(key);
  }
  for (const key of changedProtocols) {
    // The extranonce carrier's own bytes are masked: a change there is the pool's, but not a commitment.
    push(key.startsWith('Extranonce carrier') ? TemplateChangeType.OP_RETURN_OTHER : getProtocolChangeType(key));
  }
  if (changedProtocols.length > 0) {
    changeDetails.opReturnProtocols = { old: oldProtocols, new: newProtocols, changed: changedProtocols };
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

/**
 * A template's own receive time in ms, for ordering: `received_timestamp` when a history read provides it (its
 * `timestamp` is then the first-seen time over the template's copies on other connections, which can reorder two
 * templates of the shown connection), else `timestamp` (the live stream's own receive time).
 */
export function receiveTimeMs(data: Pick<StratumV1Data, 'timestamp' | 'received_timestamp'>): number {
  return parseMessageTimestampMs(data.received_timestamp ?? data.timestamp);
}

/** Compare by receive time, for sorting one pool's templates before feeding the tracker. */
export function byReceiveTime(a: StratumV1Data, b: StratumV1Data): number {
  return receiveTimeMs(a) - receiveTimeMs(b);
}

interface PoolBaseline {
  template: ProcessedTemplate;
  timestampMs: number;
}

// Bound the per-pool result cache so long-running sessions don't grow without limit.
const MAX_RESULTS_PER_POOL = 500;

/**
 * Change detection is stateful: each message is compared with the previous message from the same pool, in receive
 * order. Callers feed each pool's messages sorted with byReceiveTime (not the latency-adjusted time: that is for
 * drawing, and adjusting each copy by its own latency estimate could reorder them).
 *
 * One baseline per pool, the newest message seen. A message older than the baseline isn't compared (status
 * `outOfOrder`) and never replaces it. A message after a gap (`gapBefore`) isn't compared and becomes the baseline.
 * Results are cached by full message content, so feeding the same message again returns the same result instead of
 * comparing it with itself.
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

  process(data: StratumV1Data, opts: { gapBefore?: boolean } = {}): TemplateChangeResult {
    const pool = data.pool_name;
    const rawKey = templateContentKey(data);

    const cached = this.resultsByPool.get(pool)?.get(rawKey);
    if (cached) {
      return cached;
    }

    const currentTemplate = processTemplateData(data);
    const currentTimestampMs = receiveTimeMs(data);
    const baseline = this.baselineByPool.get(pool);
    const empty = { hasChanges: false, changeTypes: [], changeDetails: {} };

    // First template for this pool, or the first after a gap: nothing to compare with; it becomes the baseline.
    if (!baseline || opts.gapBefore) {
      if (baseline && !isNaN(currentTimestampMs) && currentTimestampMs < baseline.timestampMs) {
        return this.cacheResult(pool, rawKey, { status: 'outOfOrder', ...empty, outOfOrder: true });
      }
      this.baselineByPool.set(pool, { template: currentTemplate, timestampMs: currentTimestampMs });
      return this.cacheResult(pool, rawKey, { status: baseline ? 'gap' : 'first', ...empty });
    }

    const bothTimestampsValid = !isNaN(currentTimestampMs) && !isNaN(baseline.timestampMs);
    if (bothTimestampsValid && currentTimestampMs < baseline.timestampMs) {
      return this.cacheResult(pool, rawKey, { status: 'outOfOrder', ...empty, outOfOrder: true });
    }

    if (baseline.template.connection && currentTemplate.connection && baseline.template.connection !== currentTemplate.connection) {
      this.baselineByPool.set(pool, { template: currentTemplate, timestampMs: currentTimestampMs });
      return this.cacheResult(pool, rawKey, { status: 'otherConnection', ...empty });
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
      return 'Clean jobs flag set';
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
