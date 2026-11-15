// Coinbase transaction parser (#105): a structural map of the coinbase a pool sends, by byte offset.
//
// Everything in a template comes from a third party, so this parser is bounded and total: it never throws, never
// loops or allocates based on an unchecked length field, and reports what it couldn't parse instead.
//
// The coinbase is rebuilt the way a miner would: coinbase1 + extranonce1 + extranonce2 (zeros) + coinbase2. Because
// we build it, we know exactly which bytes are the extranonce, wherever the pool put them: inside the scriptSig
// (most pools), across the end of the scriptSig into nSequence, or inside an output script. Those bytes are per
// connection (and, for extranonce1, masked on the public site), so they are marked and never read as a pool tag.

export interface ByteRange {
  start: number; // inclusive, offset in the coinbase transaction
  end: number; // exclusive
}

export type TxFieldKind =
  | "version"
  | "segwitFlag"
  | "inputCount"
  | "prevout"
  | "scriptSigLength"
  | "scriptSig"
  | "sequence"
  | "outputCount"
  | "outputValue"
  | "outputScriptLength"
  | "outputScript"
  | "witness"
  | "locktime";

export interface TxField extends ByteRange {
  kind: TxFieldKind;
  output?: number; // index, for output fields
}

export type ScriptSegmentKind =
  | "height" // BIP34 height push (opcode + data)
  | "auxpow" // merge-mining commitment: magic + root (+ size + nonce)
  | "extranonce1" // per connection, assigned by the pool
  | "extranonce2" // per share, chosen by the miner (zeros here)
  | "time" // a pushed 4-byte Unix time close to the template's ntime (the pool's clock)
  | "tag" // printable text (5+ characters)
  | "push" // push opcode or PUSHDATA length bytes
  | "data"; // anything else: pushed binary data or non-push opcodes

export interface ScriptSegment extends ByteRange {
  kind: ScriptSegmentKind;
  text?: string; // for tags
}

export interface ScriptPush extends ByteRange {
  opcode: number;
  data: ByteRange; // the pushed bytes (empty for non-push opcodes)
  truncated: boolean; // the push claims more bytes than the script has
}

export interface AuxPow {
  range: ByteRange;
  root: string; // aux chain merkle root / block hash, displayed byte-reversed as usual
  merkleSize?: number;
  nonce?: number;
}

export interface ParsedScriptSig extends ByteRange {
  height: number | null;
  time: number | null; // Unix seconds, see "time"
  auxpow: AuxPow | null;
  pushes: ScriptPush[];
  pushOnly: boolean; // the script is a clean sequence of pushes (no truncated push, no non-push opcode), extranonce aside
  tags: { start: number; end: number; text: string }[];
  segments: ScriptSegment[]; // contiguous, covering the whole scriptSig, in order
}

export interface ParsedOutput {
  index: number;
  value: number; // satoshis
  script: ByteRange;
}

export interface ParsedCoinbase {
  ok: boolean;
  error?: string; // why parsing stopped (fields up to that point are still returned)
  size: number;
  segwit: boolean;
  version?: number;
  sequence?: number;
  locktime?: number;
  fields: TxField[];
  extranonce1: ByteRange;
  extranonce2: ByteRange;
  extranonceIn: string[]; // fields the extranonce bytes fall in, e.g. ["scriptSig"], ["scriptSig", "sequence"], ["output 2 script"]
  scriptSig: ParsedScriptSig | null;
  outputs: ParsedOutput[];
}

// Limits. A Bitcoin coinbase scriptSig is at most 100 bytes by consensus, and a real coinbase is a few hundred bytes
// to a few KB; these bounds are generous for other chains' templates while keeping hostile input cheap.
export const MAX_COINBASE_BYTES = 100_000;
export const MAX_OUTPUTS = 1_000;
export const MAX_WITNESS_ITEMS = 16;
export const MAX_EXTRANONCE2_LENGTH = 64;
export const MIN_TAG_LENGTH = 5; // random binary has a run of 4 printable bytes about once every 50 positions
export const TIME_WINDOW_SECONDS = 2 * 3600;

const AUXPOW_MAGIC = [0xfa, 0xbe, 0x6d, 0x6d];
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

const isPrintable = (c: number) => c >= 0x20 && c <= 0x7e;

function ascii(b: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  has(n: number) {
    return n >= 0 && this.pos + n <= this.b.length;
  }
  u32(): number | null {
    if (!this.has(4)) return null;
    const b = this.b, p = this.pos;
    this.pos += 4;
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 0x1000000;
  }
  u64(): number | null {
    const lo = this.u32();
    const hi = this.u32();
    return lo === null || hi === null ? null : hi * 0x100000000 + lo; // exact up to 2^53, beyond any real value
  }
  // Bitcoin CompactSize. Returns null if truncated.
  varint(): number | null {
    if (!this.has(1)) return null;
    const first = this.b[this.pos++];
    if (first < 0xfd) return first;
    if (first === 0xfd) {
      if (!this.has(2)) return null;
      const v = this.b[this.pos] | (this.b[this.pos + 1] << 8);
      this.pos += 2;
      return v;
    }
    if (first === 0xfe) return this.u32();
    return this.u64();
  }
}

const emptyRange = (): ByteRange => ({ start: 0, end: 0 });

export interface ParseOptions {
  ntime?: number; // the template's ntime (Unix seconds): enables detecting a pushed timestamp
}

/** Parse a coinbase from its stratum parts. Never throws. */
export function parseCoinbase(
  coinbase1: string,
  extranonce1: string,
  extranonce2Length: number,
  coinbase2: string,
  options: ParseOptions = {}
): ParsedCoinbase {
  const result: ParsedCoinbase = {
    ok: false,
    size: 0,
    segwit: false,
    fields: [],
    extranonce1: emptyRange(),
    extranonce2: emptyRange(),
    extranonceIn: [],
    scriptSig: null,
    outputs: [],
  };
  const fail = (error: string) => ({ ...result, ok: false, error });

  const en1 = typeof extranonce1 === "string" ? extranonce1 : "";
  if (typeof coinbase1 !== "string" || typeof coinbase2 !== "string") return fail("coinbase parts missing");
  if (!Number.isInteger(extranonce2Length) || extranonce2Length < 0 || extranonce2Length > MAX_EXTRANONCE2_LENGTH)
    return fail("invalid extranonce2 length");
  const totalHex = coinbase1.length + en1.length + extranonce2Length * 2 + coinbase2.length;
  if (totalHex > MAX_COINBASE_BYTES * 2) return fail("coinbase too large");
  if (!HEX_RE.test(coinbase1) || !HEX_RE.test(en1) || !HEX_RE.test(coinbase2)) return fail("not hex");

  const tx = hexToBytes(coinbase1 + en1 + "00".repeat(extranonce2Length) + coinbase2);
  result.size = tx.length;
  const e1Start = coinbase1.length / 2;
  result.extranonce1 = { start: e1Start, end: e1Start + en1.length / 2 };
  result.extranonce2 = { start: result.extranonce1.end, end: result.extranonce1.end + extranonce2Length };

  const r = new Reader(tx);
  const field = (kind: TxFieldKind, start: number, output?: number) => {
    const f: TxField = { kind, start, end: r.pos };
    if (output !== undefined) f.output = output;
    result.fields.push(f);
  };

  let p = r.pos;
  const version = r.u32();
  if (version === null) return fail("truncated version");
  result.version = version;
  field("version", p);

  if (r.has(2) && tx[r.pos] === 0x00 && tx[r.pos + 1] === 0x01) {
    p = r.pos;
    r.pos += 2;
    result.segwit = true;
    field("segwitFlag", p);
  }

  p = r.pos;
  const inputs = r.varint();
  if (inputs === null) return fail("truncated input count");
  field("inputCount", p);
  if (inputs !== 1) return fail(`coinbase has ${inputs} inputs`);

  p = r.pos;
  if (!r.has(36)) return fail("truncated prevout");
  r.pos += 36;
  field("prevout", p);

  p = r.pos;
  const sigLen = r.varint();
  if (sigLen === null) return fail("truncated scriptSig length");
  field("scriptSigLength", p);
  if (!r.has(sigLen)) return fail("scriptSig longer than the coinbase");
  const sigStart = r.pos;
  r.pos += sigLen;
  field("scriptSig", sigStart);
  result.scriptSig = parseScriptSig(tx, sigStart, r.pos, result.extranonce1, result.extranonce2, options.ntime);

  p = r.pos;
  const sequence = r.u32();
  if (sequence === null) return fail("truncated sequence");
  result.sequence = sequence;
  field("sequence", p);

  p = r.pos;
  const outputs = r.varint();
  if (outputs === null) return fail("truncated output count");
  field("outputCount", p);
  if (outputs > MAX_OUTPUTS) return fail(`too many outputs (${outputs})`);
  for (let i = 0; i < outputs; i++) {
    p = r.pos;
    const value = r.u64();
    if (value === null) return fail(`truncated output ${i} value`);
    field("outputValue", p, i);
    p = r.pos;
    const len = r.varint();
    if (len === null) return fail(`truncated output ${i} script length`);
    field("outputScriptLength", p, i);
    if (!r.has(len)) return fail(`output ${i} script longer than the coinbase`);
    const s = r.pos;
    r.pos += len;
    field("outputScript", s, i);
    result.outputs.push({ index: i, value, script: { start: s, end: r.pos } });
  }

  if (result.segwit) {
    p = r.pos;
    const items = r.varint();
    if (items === null) return fail("truncated witness");
    if (items > MAX_WITNESS_ITEMS) return fail(`too many witness items (${items})`);
    for (let i = 0; i < items; i++) {
      const len = r.varint();
      if (len === null || !r.has(len)) return fail("truncated witness item");
      r.pos += len;
    }
    field("witness", p);
  }

  p = r.pos;
  const locktime = r.u32();
  if (locktime === null) return fail("truncated locktime");
  result.locktime = locktime;
  field("locktime", p);
  if (r.pos !== tx.length) return fail(`${tx.length - r.pos} trailing bytes`);

  result.extranonceIn = locateExtranonce(result);
  result.ok = true;
  return result;
}

function overlaps(a: ByteRange, b: ByteRange) {
  return a.start < b.end && b.start < a.end;
}

function fieldLabel(f: TxField): string {
  if (f.output === undefined) return f.kind;
  const what = f.kind === "outputScript" ? "script" : f.kind === "outputValue" ? "value" : "script length";
  return `output ${f.output} ${what}`;
}

function locateExtranonce(c: ParsedCoinbase): string[] {
  const en: ByteRange = { start: c.extranonce1.start, end: c.extranonce2.end };
  if (en.end <= en.start) return [];
  return c.fields.filter((f) => overlaps(f, en)).map(fieldLabel);
}

/** Tokenize a script into pushes and opcodes, bounded by the script's own length. */
export function tokenizeScript(
  b: Uint8Array,
  start: number,
  end: number,
  skip?: ByteRange
): { pushes: ScriptPush[]; pushOnly: boolean; alignedUntil: number } {
  const pushes: ScriptPush[] = [];
  let pushOnly = true;
  let alignedUntil = end; // offset of the first token that isn't a well-formed push: headers after it are guesses
  const misaligned = (at: number) => {
    pushOnly = false;
    if (alignedUntil === end) alignedUntil = at;
  };
  let i = start;
  while (i < end) {
    // Bytes the pool didn't write (the extranonce, when it sits outside any push) aren't script: skip them.
    if (skip && i >= skip.start && i < skip.end) {
      i = Math.min(skip.end, end);
      continue;
    }
    const op = b[i];
    let header = 1;
    let len = 0;
    if (op >= 0x01 && op <= 0x4b) len = op;
    else if (op === 0x4c || op === 0x4d || op === 0x4e) {
      const n = op === 0x4c ? 1 : op === 0x4d ? 2 : 4;
      if (i + 1 + n > end) {
        pushes.push({ start: i, end, opcode: op, data: { start: end, end }, truncated: true });
        misaligned(i);
        break;
      }
      len = 0;
      for (let k = n - 1; k >= 0; k--) len = len * 256 + b[i + 1 + k];
      header = 1 + n;
    } else if (op > 0x60) {
      misaligned(i); // not a push (OP_0 and OP_1NEGATE..OP_16 count as pushes)
    }
    const dataStart = i + header;
    const dataEnd = Math.min(dataStart + len, end);
    const truncated = dataStart + len > end;
    if (truncated) misaligned(i);
    pushes.push({ start: i, end: dataEnd, opcode: op, data: { start: dataStart, end: dataEnd }, truncated });
    i = dataEnd;
  }
  return { pushes, pushOnly, alignedUntil };
}

function decodeHeight(b: Uint8Array, sigStart: number, sigEnd: number): { height: number; end: number } | null {
  if (sigEnd <= sigStart) return null;
  const op = b[sigStart];
  // BIP34: the first item is a minimal push of the height as a little-endian CScriptNum, or OP_1..OP_16.
  if (op >= 0x51 && op <= 0x60) return { height: op - 0x50, end: sigStart + 1 };
  if (op >= 1 && op <= 6 && sigStart + 1 + op <= sigEnd) {
    if ((b[sigStart + op] & 0x80) !== 0) return null; // sign bit: negative, never a height
    let h = 0;
    for (let k = op; k >= 1; k--) h = h * 256 + b[sigStart + k];
    return { height: h, end: sigStart + 1 + op };
  }
  return null;
}

function findAuxPow(b: Uint8Array, start: number, end: number): AuxPow | null {
  for (let i = start; i + AUXPOW_MAGIC.length + 32 <= end; i++) {
    if (b[i] !== AUXPOW_MAGIC[0] || b[i + 1] !== AUXPOW_MAGIC[1] || b[i + 2] !== AUXPOW_MAGIC[2] || b[i + 3] !== AUXPOW_MAGIC[3])
      continue;
    const rootStart = i + 4;
    const root = b.slice(rootStart, rootStart + 32).reverse();
    const aux: AuxPow = { range: { start: i, end: rootStart + 32 }, root: bytesToHex(root) };
    if (rootStart + 40 <= end) {
      const rd = new Reader(b);
      rd.pos = rootStart + 32;
      aux.merkleSize = rd.u32() ?? undefined;
      aux.nonce = rd.u32() ?? undefined;
      aux.range.end = rootStart + 40;
    }
    return aux;
  }
  return null;
}

function parseScriptSig(
  tx: Uint8Array,
  start: number,
  end: number,
  en1: ByteRange,
  en2: ByteRange,
  ntime?: number
): ParsedScriptSig {
  const { pushes, pushOnly, alignedUntil } = tokenizeScript(tx, start, end, { start: en1.start, end: en2.end });
  const h = decodeHeight(tx, start, end);
  const auxpow = findAuxPow(tx, start, end);

  // Label every byte, highest priority first: extranonce > height > auxpow > push header > data.
  const n = end - start;
  const kind: ScriptSegmentKind[] = new Array(n).fill("data");
  const mark = (r: ByteRange, k: ScriptSegmentKind, onlyOver?: ScriptSegmentKind[]) => {
    for (let i = Math.max(r.start, start); i < Math.min(r.end, end); i++) {
      if (!onlyOver || onlyOver.includes(kind[i - start])) kind[i - start] = k;
    }
  };
  // Push headers count as structure up to the first token that isn't a well-formed push. After it the alignment is a
  // guess (often raw text that happens to look like opcodes), so those bytes stay "data" and tags can use them.
  // Only data pushes (0x01-0x4e) have header bytes; OP_0 and the small-integer opcodes stay "data" (inside text,
  // 'Q'..'`' are far more likely characters than opcodes).
  for (const p of pushes)
    if (p.start < alignedUntil && p.opcode >= 0x01 && p.opcode <= 0x4e) mark({ start: p.start, end: p.data.start }, "push");
  if (auxpow) mark(auxpow.range, "auxpow");
  if (h) mark({ start, end: h.end }, "height");
  mark(en1, "extranonce1");
  mark(en2, "extranonce2");

  // A pushed 4-byte little-endian Unix time within TIME_WINDOW_SECONDS of ntime: the pool's clock at job creation.
  let time: number | null = null;
  const aligned = pushes.filter((p) => p.start < alignedUntil && p.opcode >= 0x01 && p.opcode <= 0x4e && !p.truncated);
  if (ntime !== undefined && Number.isFinite(ntime)) {
    for (const p of aligned) {
      if (p.data.end - p.data.start !== 4 || kind[p.data.start - start] !== "data") continue;
      const v = tx[p.data.start] + tx[p.data.start + 1] * 256 + tx[p.data.start + 2] * 65536 + tx[p.data.start + 3] * 16777216;
      if (Math.abs(v - ntime) <= TIME_WINDOW_SECONDS) {
        time = v;
        mark(p.data, "time", ["data"]);
        break;
      }
    }
  }
  // Text doesn't run across the end of a pushed *binary* value (e.g. a timestamp whose last bytes happen to be
  // printable, followed by raw text). A push that is itself mostly text and runs into more text is the same text:
  // some pools' push lengths don't match their tag (e.g. `0a "tagpool" 0d "/name/"`), so its end isn't a boundary.
  const isMostlyText = (r: ByteRange) => {
    let printable = 0;
    for (let i = r.start; i < r.end; i++) if (isPrintable(tx[i])) printable++;
    // Shorter than a tag: a pushed number (time, nonce), whatever its bytes look like.
    return r.end - r.start >= MIN_TAG_LENGTH && printable / (r.end - r.start) >= 0.75;
  };
  const breaks = new Set(aligned.filter((p) => !isMostlyText(p.data)).map((p) => p.data.end));

  // Tags: runs of printable bytes among the remaining data bytes.
  const tags: { start: number; end: number; text: string }[] = [];
  let runStart = -1;
  for (let i = start; i <= end; i++) {
    const ok = i < end && kind[i - start] === "data" && isPrintable(tx[i]) && !(runStart >= 0 && breaks.has(i));
    if (!ok && runStart >= 0) {
      const len = i - runStart;
      if (len >= MIN_TAG_LENGTH) {
        tags.push({ start: runStart, end: i, text: ascii(tx, runStart, i) });
        mark({ start: runStart, end: i }, "tag", ["data"]);
      }
      runStart = -1;
    }
    if (i < end && kind[i - start] === "data" && isPrintable(tx[i]) && runStart < 0) runStart = i;
  }

  const segments: ScriptSegment[] = [];
  for (let i = start; i < end; i++) {
    const k = kind[i - start];
    const last = segments[segments.length - 1];
    if (last && last.kind === k) last.end = i + 1;
    else segments.push({ kind: k, start: i, end: i + 1 });
  }
  for (const s of segments) if (s.kind === "tag") s.text = ascii(tx, s.start, s.end);

  return { start, end, height: h ? h.height : null, time, auxpow, pushes, pushOnly, tags, segments };
}

/** The pool's text tags joined for display, without extranonce bytes, height or AuxPoW. */
export function coinbaseTagText(parsed: ParsedCoinbase, maxLength = 80): string {
  const text = (parsed.scriptSig?.tags ?? []).map((t) => t.text.trim()).filter(Boolean).join(" ");
  return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}

/** Hex of a range of the rebuilt coinbase (for display). */
export function rangeHex(coinbase1: string, extranonce1: string, extranonce2Length: number, coinbase2: string, r: ByteRange): string {
  const hex = coinbase1 + (extranonce1 || "") + "00".repeat(Math.max(0, extranonce2Length | 0)) + coinbase2;
  return hex.slice(r.start * 2, r.end * 2);
}
