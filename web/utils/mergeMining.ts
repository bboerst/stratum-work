// What a template commits to on other chains (#42, #82): OP_RETURN outputs decoded per protocol, the AuxPoW
// commitment in the scriptSig, and a compact per-template summary for change tracking.
//
// Like coinbaseParser, everything here is bounded and total: decoders read fixed-size fields from data whose length
// they check first, never allocate from a length field, and report what they couldn't decode instead of throwing.
// Every decoded value is plain text (hex, numbers, names) and is rendered as text, never as HTML.
//
// Sources, per protocol (see DECODERS below for the byte layouts):
//   Witness commitment  BIP141
//   RSK                 RSKIP-92 and RSKIP-110 (tag "RSKBLOCK:" + 20-byte hash prefix + CPV + uncle count + height)
//   Core                Core DAO docs "Delegating hash" and its light client (btcpowermirror, ParsePowerParams)
//   exSat               exSat consensus contracts (utils.hpp get_op_return_eos_account / account_decode)
//   Syscoin             Syscoin 5 auxpow_miner.cpp createScriptPubKey ("sys" + block hash + height)
//   Hathor              hathor-core merged_mining ("Hath" + mining base hash)
//   AuxPoW              Bitcoin wiki "Merged mining specification" and Namecoin's CAuxPow::check / getExpectedIndex

import { parseCoinbase, tokenizeScript, ByteRange, ParsedCoinbase, AuxPow } from "./coinbaseParser";

/** How an identification was established. */
export type Confidence =
  | "spec" // layout from a published spec or the protocol's reference code, and it matches the data seen
  | "marker" // only the protocol marker is from a spec; the payload isn't decoded
  | "heuristic" // a shape match without a distinctive marker
  | "structural"; // known from how the coinbase was built (e.g. the extranonce position), not from the bytes

export type OpReturnProtocolId =
  | "witness"
  | "rsk"
  | "core"
  | "exsat"
  | "syscoin"
  | "hathor"
  | "omni"
  | "runestone"
  | "stacks"
  | "bip47"
  | "extranonce"
  | "empty"
  | "malformed"
  | "unknown";

export interface DecodedField {
  label: string;
  value: string;
  hint?: string; // what the field means, for a tooltip
  href?: string; // an explorer link, built only from validated hex
}

export interface OpReturnDecoded {
  id: OpReturnProtocolId;
  protocol: string; // display name; stable (used as a key by template change detection)
  chain?: string; // short label of the other chain this commits to, for the merge-mining summary
  confidence: Confidence;
  fields: DecodedField[];
  commitment?: string; // the committed value, compared between templates to see when it changes
  error?: string; // what didn't match the protocol's layout
  dataHex: string; // the pushed data (after OP_RETURN and the push opcode)
}

// --- byte helpers ---

const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

export function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== "string" || !HEX_RE.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function toHex(b: Uint8Array, start = 0, end = b.length): string {
  let s = "";
  for (let i = start; i < end && i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

function toHexReversed(b: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = Math.min(end, b.length) - 1; i >= start; i--) s += b[i].toString(16).padStart(2, "0");
  return s;
}

function startsWith(b: Uint8Array, prefix: number[]): boolean {
  if (b.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (b[i] !== prefix[i]) return false;
  return true;
}

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const be32 = (b: Uint8Array, p: number) => b[p] * 0x1000000 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
const le32 = (b: Uint8Array, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 0x1000000;
const be16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
const isPrintable = (c: number) => c >= 0x20 && c <= 0x7e;

// --- OP_RETURN protocols ---

const WITNESS_MAGIC = [0xaa, 0x21, 0xa9, 0xed];
const RSK_TAG = ascii("RSKBLOCK:");
const CORE_TAG = ascii("CORE");
const EXSAT_TAG = ascii("EXSAT");
const SYSCOIN_TAG = ascii("sys");
const HATHOR_TAG = ascii("Hath");
const OMNI_TAG = ascii("omni");
const STACKS_TAG = ascii("X2[");

// exSat account names: one byte per character, an index into this alphabet (contract-of-consensus account_decode).
const EXSAT_ALPHABET = "abcdefghijklmnopqrstuvwxyz12345.";
const EXSAT_MAX_NAME = 13; // EOS-style account names are at most 13 characters

interface PayloadContext {
  directPush: boolean; // the data was pushed with a 1-byte length opcode (0x01-0x4b), not PUSHDATA1/2/4
  pushCount: number; // data pushes after OP_RETURN
}

type Decoder = (d: Uint8Array, ctx: PayloadContext) => Omit<OpReturnDecoded, "dataHex">;

const incomplete = (need: number, have: number) => `expected at least ${need} bytes, got ${have}`;

function decodeWitness(d: Uint8Array): Omit<OpReturnDecoded, "dataHex"> {
  const base = { id: "witness" as const, protocol: "WitnessCommitment", confidence: "spec" as const };
  if (d.length < 36) return { ...base, fields: [], error: incomplete(36, d.length) };
  return {
    ...base,
    fields: [
      {
        label: "Witness commitment",
        value: toHex(d, 4, 36),
        hint: "BIP141: double SHA-256 of the witness merkle root and the coinbase witness nonce. Bitcoin's own, not another chain.",
      },
    ],
  };
}

function decodeRsk(d: Uint8Array): Omit<OpReturnDecoded, "dataHex"> {
  const base = { id: "rsk" as const, protocol: "RSK Block", chain: "RSK", confidence: "spec" as const };
  const o = RSK_TAG.length;
  if (d.length < o + 32) return { ...base, fields: [], error: incomplete(o + 32, d.length) };
  const uncles = d[o + 27];
  const fields: DecodedField[] = [
    {
      label: "Hash for merged mining (first 20 bytes)",
      value: toHex(d, o, o + 20),
      hint: "RSKIP-110: prefix of the hash of the RSK block header being mined, without its merged-mining fields. Not the final RSK block hash.",
    },
    {
      label: "Commit to parents vector",
      value: toHex(d, o + 20, o + 27),
      hint: "RSKIP-110 CPV: one byte from each of seven ancestor checkpoints, so an RSK node can check which chain the work builds on.",
    },
    {
      label: "Uncles (last 32 blocks)",
      value: uncles === 255 ? "255 or more" : String(uncles),
      hint: "RSKIP-110: uncles referenced in the last 32 RSK blocks (capped at 255).",
    },
    { label: "RSK block number", value: String(be32(d, o + 28)), hint: "RSKIP-110: the RSK height being mined (big-endian)." },
  ];
  const extra = d.length - (o + 32);
  return {
    ...base,
    fields,
    commitment: toHex(d, o, o + 32),
    error: extra > 0 ? `${extra} bytes after the 32-byte RSK field` : undefined,
  };
}

function decodeCore(d: Uint8Array, ctx: PayloadContext): Omit<OpReturnDecoded, "dataHex"> {
  const base = { id: "core" as const, protocol: "CoreDAO", chain: "Core", confidence: "spec" as const };
  const version = d.length > 4 ? d[4] : -1;
  if (version !== 1) return { ...base, fields: [], error: version < 0 ? "no version byte" : `unknown version ${version}` };
  if (d.length < 45) return { ...base, fields: [{ label: "Version", value: "1" }], error: incomplete(45, d.length) };
  const validator = "0x" + toHex(d, 5, 25);
  const reward = "0x" + toHex(d, 25, 45);
  const fields: DecodedField[] = [
    { label: "Version", value: "1" },
    {
      label: "Validator",
      value: validator,
      hint: "The Core validator this pool delegates its hash power to.",
      href: `https://stake.coredao.org/validator/${validator}`,
    },
    {
      label: "Reward address",
      value: reward,
      hint: "The Core address that receives the pool's CORE rewards for the delegation.",
      href: `https://scan.coredao.org/address/${reward}`,
    },
  ];
  // Core's light client also reads an optional 32 bytes after the two addresses.
  if (d.length >= 77) fields.push({ label: "Extra 32 bytes", value: toHex(d, 45, 77), hint: "Read by Core's light client when present." });
  let error: string | undefined;
  // Core's light client reads fixed offsets (OP_RETURN, one length byte, "CORE"...), so a PUSHDATA form shifts them.
  if (!ctx.directPush) error = "pushed with PUSHDATA: Core's light client expects a one-byte push and may not read it";
  return { ...base, fields, commitment: `${validator}:${reward}`, error };
}

function decodeExsat(d: Uint8Array, ctx: PayloadContext): Omit<OpReturnDecoded, "dataHex"> {
  const base = { id: "exsat" as const, protocol: "ExSat", chain: "exSat", confidence: "spec" as const };
  const version = d.length > 5 ? d[5] : -1;
  if (version !== 1) return { ...base, fields: [], error: version < 0 ? "no version byte" : `unknown version ${version}` };
  const nameBytes = d.length - 6;
  let name = "";
  let bad = 0;
  for (let i = 6; i < d.length && i < 6 + EXSAT_MAX_NAME; i++) {
    if (d[i] < EXSAT_ALPHABET.length) name += EXSAT_ALPHABET[d[i]];
    else {
      name += "?";
      bad++;
    }
  }
  const errors: string[] = [];
  if (nameBytes === 0) errors.push("no account name");
  if (nameBytes > EXSAT_MAX_NAME) errors.push(`account name longer than ${EXSAT_MAX_NAME} characters`);
  if (bad) errors.push(`${bad} byte(s) outside the account alphabet`);
  if (ctx.pushCount !== 1) errors.push("more than one push");
  return {
    ...base,
    fields: [
      { label: "Version", value: "1" },
      {
        label: "Account",
        value: name,
        hint: "The pool's account on the exSat chain (an EOS-style name), registered for its synchronizer rewards.",
      },
    ],
    commitment: name,
    error: errors.length ? errors.join("; ") : undefined,
  };
}

function decodeSyscoin(d: Uint8Array): Omit<OpReturnDecoded, "dataHex"> {
  const base = { id: "syscoin" as const, protocol: "Syscoin", chain: "Syscoin", confidence: "spec" as const };
  const o = SYSCOIN_TAG.length;
  if (d.length < o + 36) return { ...base, fields: [], error: incomplete(o + 36, d.length) };
  const hash = toHexReversed(d, o, o + 32); // serialized uint256: reverse for display
  const height = le32(d, o + 32);
  const errors: string[] = [];
  if (height % 10 !== 0) errors.push("height is not a multiple of 10 (Syscoin picks one that is)");
  if (d.length > o + 36) errors.push(`${d.length - o - 36} extra bytes`);
  return {
    ...base,
    fields: [
      {
        label: "Syscoin block",
        value: hash,
        hint: "A recent Syscoin block the work refers to: about 5 blocks behind the Syscoin tip, rounded down to a multiple of 10 (Syscoin 5). The merge-mining proof itself is in the AuxPoW tree.",
      },
      { label: "Syscoin height", value: String(height) },
    ],
    commitment: `${height}:${hash}`,
    error: errors.length ? errors.join("; ") : undefined,
  };
}

function decodeHathor(d: Uint8Array): Omit<OpReturnDecoded, "dataHex"> {
  const base = { id: "hathor" as const, protocol: "Hathor Network", chain: "Hathor", confidence: "spec" as const };
  const o = HATHOR_TAG.length;
  if (d.length < o + 32) return { ...base, fields: [], error: incomplete(o + 32, d.length) };
  const extra = d.length - (o + 32);
  return {
    ...base,
    fields: [
      {
        label: "Mining base hash",
        value: toHex(d, o, o + 32),
        hint: "Hash of the Hathor block being mined, without its proof of work. Not the final Hathor block hash.",
      },
    ],
    commitment: toHex(d, o, o + 32),
    error: extra > 0 ? `${extra} extra bytes (a Hathor extranonce, if zeros)` : undefined,
  };
}

function decodeOmni(d: Uint8Array): Omit<OpReturnDecoded, "dataHex"> {
  const base = { id: "omni" as const, protocol: "Omni", confidence: "spec" as const };
  if (d.length < 8) return { ...base, fields: [], error: incomplete(8, d.length) };
  return {
    ...base,
    fields: [
      { label: "Transaction version", value: String(be16(d, 4)) },
      { label: "Transaction type", value: String(be16(d, 6)) },
    ],
  };
}

function decodeUnknown(d: Uint8Array): Omit<OpReturnDecoded, "dataHex"> {
  const fields: DecodedField[] = [{ label: "Length", value: `${d.length} bytes` }];
  let n = 0;
  while (n < d.length && n < 32 && isPrintable(d[n])) n++;
  if (n >= 3) fields.push({ label: "Leading text", value: String.fromCharCode(...d.subarray(0, n)), hint: "Printable bytes at the start, often a protocol tag." });
  return { id: "unknown", protocol: "Unknown", confidence: "heuristic", fields };
}

const DECODERS: { prefix: number[]; decode: Decoder }[] = [
  { prefix: WITNESS_MAGIC, decode: decodeWitness },
  { prefix: RSK_TAG, decode: decodeRsk },
  { prefix: CORE_TAG, decode: decodeCore },
  { prefix: EXSAT_TAG, decode: decodeExsat },
  { prefix: SYSCOIN_TAG, decode: decodeSyscoin },
  { prefix: HATHOR_TAG, decode: decodeHathor },
  { prefix: OMNI_TAG, decode: decodeOmni },
  {
    prefix: STACKS_TAG,
    decode: () => ({ id: "stacks", protocol: "Stacks Block Commit", chain: "Stacks", confidence: "marker", fields: [] }),
  },
];

/** Decode the data pushed after OP_RETURN. Never throws. */
export function decodeOpReturnPayload(data: Uint8Array, ctx: PayloadContext = { directPush: true, pushCount: 1 }): OpReturnDecoded {
  const dataHex = toHex(data);
  if (data.length === 0) return { id: "empty", protocol: "OP_RETURN (0 byte)", confidence: "spec", fields: [], dataHex };
  for (const { prefix, decode } of DECODERS) if (startsWith(data, prefix)) return { ...decode(data, ctx), dataHex };
  // BIP47 notification payload: 80 bytes, version 1 or 2, then a compressed public key's sign byte (no marker).
  if (data.length === 80 && (data[0] === 0x01 || data[0] === 0x02) && (data[2] === 0x02 || data[2] === 0x03))
    return { id: "bip47", protocol: "BIP47 Payment Code", confidence: "heuristic", fields: [], dataHex };
  return { ...decodeUnknown(data), dataHex };
}

/** Decode an output script that starts with OP_RETURN; null for any other script. Never throws. */
export function decodeOpReturnScript(script: Uint8Array): OpReturnDecoded | null {
  if (script.length === 0 || script[0] !== 0x6a) return null;
  if (script.length === 1) return { id: "empty", protocol: "Empty OP_RETURN", confidence: "spec", fields: [], dataHex: "" };
  if (script[1] === 0x5d) {
    // OP_RETURN OP_13: a Runestone. The payload (pushes of LEB128 integers) isn't decoded here.
    return {
      id: "runestone",
      protocol: "Runestone",
      confidence: "marker",
      fields: [{ label: "Payload", value: `${script.length - 2} bytes` }],
      dataHex: toHex(script, 2),
    };
  }
  const { pushes } = tokenizeScript(script, 1, script.length);
  const dataPushes = pushes.filter((p) => p.opcode <= 0x4e);
  const first = pushes[0];
  if (!first || first.opcode > 0x4e || first.truncated) {
    return {
      id: "malformed",
      protocol: "Malformed OP_RETURN",
      confidence: "spec",
      fields: [],
      error: first?.truncated ? "push longer than the script" : "not a data push after OP_RETURN",
      dataHex: toHex(script, 1),
    };
  }
  const decoded = decodeOpReturnPayload(script.subarray(first.data.start, first.data.end), {
    directPush: first.opcode >= 0x01 && first.opcode <= 0x4b,
    pushCount: dataPushes.length,
  });
  if (pushes.length > 1 && decoded.id !== "exsat") {
    const note = `${pushes.length - 1} more push(es) after the first, not decoded`;
    decoded.error = decoded.error ? `${decoded.error}; ${note}` : note;
  }
  return decoded;
}

// --- AuxPoW ---

/** Chains known to merge-mine with Bitcoin via AuxPoW, with their chain IDs, for the slot each would use. */
export const KNOWN_AUX_CHAINS: { name: string; chainId: number; source: string }[] = [
  { name: "Namecoin", chainId: 1, source: "namecoin-core chainparams" },
  { name: "Syscoin", chainId: 16, source: "syscoin chainparams" },
  { name: "Elastos", chainId: 1224, source: "Elastos merged mining docs" },
];

/** Slot a chain's block hash occupies in the aux merkle tree (Namecoin getExpectedIndex; 32-bit arithmetic). */
export function auxSlot(nonce: number, chainId: number, merkleSize: number): number {
  let rand = Math.imul(nonce >>> 0, 1103515245) + 12345;
  rand = (rand + chainId) >>> 0;
  rand = (Math.imul(rand, 1103515245) + 12345) >>> 0;
  return rand % merkleSize;
}

export interface AuxPowInfo {
  root: string; // display order (the coinbase bytes as they are)
  merkleSize?: number;
  nonce?: number;
  treeHeight?: number; // log2(merkleSize): the length of every aux chain's merkle branch
  problems: string[]; // what an aux chain's validation would reject
  // The slot each known chain would occupy *if* it's in this tree. The coinbase alone can't say which chains are.
  knownSlots: { name: string; chainId: number; slot: number; sharesSlotWith: string[] }[];
}

const MAX_SLOT_SIZE = 2 ** 31;

export function describeAuxPow(aux: AuxPow): AuxPowInfo {
  const info: AuxPowInfo = { root: aux.root, merkleSize: aux.merkleSize, nonce: aux.nonce, problems: [], knownSlots: [] };
  if (aux.magicCount > 1) info.problems.push(`the magic appears ${aux.magicCount} times (aux chains reject more than one)`);
  if (aux.merkleSize === undefined || aux.nonce === undefined) {
    info.problems.push("the script ends before the merkle size and nonce");
    return info;
  }
  const size = aux.merkleSize;
  const powerOfTwo = size >= 1 && size <= MAX_SLOT_SIZE && (size & (size - 1)) === 0;
  if (!powerOfTwo) {
    info.problems.push(`merkle size ${size} is not a power of two`);
    return info;
  }
  info.treeHeight = Math.round(Math.log2(size));
  const slots = KNOWN_AUX_CHAINS.map((c) => ({ name: c.name, chainId: c.chainId, slot: auxSlot(aux.nonce!, c.chainId, size) }));
  info.knownSlots = slots.map((s) => ({
    ...s,
    sharesSlotWith: slots.filter((o) => o.slot === s.slot && o.name !== s.name).map((o) => o.name),
  }));
  return info;
}

// --- per-template decode and summary ---

export interface DecodedOutput {
  index: number;
  value: number; // satoshis
  script: ByteRange; // offset in the coinbase
  opReturn: OpReturnDecoded | null;
}

export interface MergeMiningSummary {
  chains: string[]; // other chains this template commits to, in a fixed order, e.g. ["AuxPoW", "RSK", "Core"]
  label: string; // for display: "AuxPoW(16) RSK Core"
  key: string; // which chains (and the AuxPoW tree size): equal keys = the same set of commitments
  commitments: Record<string, string>; // chain -> committed value(s), to see which changed between templates
}

export interface MergeMiningDecode {
  parsed: ParsedCoinbase;
  outputs: DecodedOutput[];
  auxpow: AuxPowInfo | null;
  summary: MergeMiningSummary;
}

const CHAIN_ORDER = ["AuxPoW", "RSK", "Core", "exSat", "Syscoin", "Hathor", "Stacks"];

function chainRank(c: string) {
  const i = CHAIN_ORDER.indexOf(c);
  return i < 0 ? CHAIN_ORDER.length : i;
}

export function summarize(outputs: DecodedOutput[], auxpow: AuxPowInfo | null): MergeMiningSummary {
  const values = new Map<string, string[]>();
  const add = (chain: string, v: string) => {
    const list = values.get(chain) ?? [];
    list.push(v);
    values.set(chain, list);
  };
  if (auxpow) add("AuxPoW", `${auxpow.root}:${auxpow.merkleSize ?? ""}:${auxpow.nonce ?? ""}`);
  for (const o of outputs) if (o.opReturn?.chain) add(o.opReturn.chain, o.opReturn.commitment ?? o.opReturn.dataHex);
  const chains = [...values.keys()].sort((a, b) => chainRank(a) - chainRank(b) || a.localeCompare(b));
  const commitments: Record<string, string> = {};
  for (const c of chains) commitments[c] = values.get(c)!.slice().sort().join(",");
  const name = (c: string) => {
    const n = values.get(c)!.length;
    const base = c === "AuxPoW" && auxpow?.merkleSize !== undefined ? `AuxPoW(${auxpow.merkleSize})` : c;
    return n > 1 ? `${base}×${n}` : base;
  };
  const names = chains.map(name);
  return { chains, label: names.join(" "), key: names.join("+"), commitments };
}

export interface MergeMiningChange {
  added: string[];
  removed: string[];
  changed: string[]; // still committed to, with a different value
  setChanged: boolean; // the summary key differs (chains added/removed, AuxPoW tree size, output counts)
}

export function diffMergeMining(prev: MergeMiningSummary, cur: MergeMiningSummary): MergeMiningChange {
  const added = cur.chains.filter((c) => !(c in prev.commitments));
  const removed = prev.chains.filter((c) => !(c in cur.commitments));
  const changed = cur.chains.filter((c) => c in prev.commitments && prev.commitments[c] !== cur.commitments[c]);
  return { added, removed, changed, setChanged: prev.key !== cur.key };
}

/** "+Syscoin −Hathor RSK AuxPoW", or "" when nothing changed. */
export function formatMergeMiningChange(c: MergeMiningChange): string {
  return [...c.added.map((x) => `+${x}`), ...c.removed.map((x) => `−${x}`), ...c.changed].join(" ");
}

const EXTRANONCE_CARRIER: Omit<OpReturnDecoded, "dataHex"> = {
  id: "extranonce",
  protocol: "Extranonce carrier",
  confidence: "structural",
  fields: [
    {
      label: "Contents",
      value: "extranonce bytes",
      hint: "This output holds the per-connection extranonce1 and the miner's extranonce2, so it changes with every share. Not a commitment to another chain.",
    },
  ],
};

const EMPTY_SUMMARY: MergeMiningSummary = { chains: [], label: "", key: "", commitments: {} };

const cache = new Map<string, MergeMiningDecode>();
const MAX_CACHE = 1000;

/** Decode a template's outputs and AuxPoW, and summarize its merge-mining commitments. Never throws. */
export function decodeMergeMining(
  coinbase1: string,
  extranonce1: string,
  extranonce2Length: number,
  coinbase2: string
): MergeMiningDecode {
  const key = `${coinbase1}|${extranonce1}|${extranonce2Length}|${coinbase2}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const parsed = parseCoinbase(coinbase1, extranonce1 || "", Number(extranonce2Length), coinbase2);
  let result: MergeMiningDecode;
  const tx = parsed.size > 0 ? hexToBytes(coinbase1 + (extranonce1 || "") + "00".repeat(Number(extranonce2Length)) + coinbase2) : null;
  if (!tx) {
    result = { parsed, outputs: [], auxpow: null, summary: EMPTY_SUMMARY };
  } else {
    const en: ByteRange = { start: parsed.extranonce1.start, end: parsed.extranonce2.end };
    const outputs: DecodedOutput[] = parsed.outputs.map((o) => {
      const script = tx.subarray(o.script.start, o.script.end);
      let opReturn = decodeOpReturnScript(script);
      const carriesExtranonce = en.end > en.start && o.script.start < en.end && en.start < o.script.end;
      if (opReturn && carriesExtranonce) opReturn = { ...EXTRANONCE_CARRIER, dataHex: opReturn.dataHex };
      return { index: o.index, value: o.value, script: o.script, opReturn };
    });
    const auxpow = parsed.scriptSig?.auxpow ? describeAuxPow(parsed.scriptSig.auxpow) : null;
    result = { parsed, outputs, auxpow, summary: summarize(outputs, auxpow) };
  }
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, result);
  return result;
}
