import { describe, it, expect } from "vitest";
import {
  auxSlot,
  decodeMergeMining,
  decodeOpReturnPayload,
  decodeOpReturnScript,
  describeAuxPow,
  diffMergeMining,
  formatMergeMiningChange,
  hexToBytes,
  summarize,
  OpReturnDecoded,
} from "../mergeMining";
import { computeCoinbaseOutputs, decodeOpReturnData } from "../bitcoinUtils";

// All fixtures are synthetic, built from each protocol's published layout.

const asciiHex = (s: string) => Buffer.from(s, "ascii").toString("hex");
const le32 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]).toString("hex");
const be32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]).toString("hex");
const le64 = (n: number) => le32(n % 0x100000000) + le32(Math.floor(n / 0x100000000));
const push = (dataHex: string) => {
  const n = dataHex.length / 2;
  return (n <= 0x4b ? n.toString(16).padStart(2, "0") : "4c" + n.toString(16).padStart(2, "0")) + dataHex;
};
const opReturn = (dataHex: string) => "6a" + push(dataHex);
const bytes = (hex: string) => hexToBytes(hex)!;
const script = (hex: string) => decodeOpReturnScript(bytes(hex))!;
const field = (d: OpReturnDecoded, label: string) => d.fields.find((f) => f.label === label)?.value;
const seq = (n: number, start = 0) => Array.from({ length: n }, (_, i) => ((start + i) & 255).toString(16).padStart(2, "0")).join("");

const RSK_PAYLOAD = (prefix: string, cpv: string, uncles: number, height: number) =>
  asciiHex("RSKBLOCK:") + prefix + cpv + uncles.toString(16).padStart(2, "0") + be32(height);

describe("OP_RETURN protocols", () => {
  it("witness commitment (BIP141)", () => {
    const d = script("6a24aa21a9ed" + "ab".repeat(32));
    expect(d.id).toBe("witness");
    expect(d.protocol).toBe("WitnessCommitment");
    expect(field(d, "Witness commitment")).toBe("ab".repeat(32));
    expect(d.chain).toBeUndefined(); // Bitcoin's own, not another chain
  });

  it("RSK: hash prefix, CPV, uncle count and big-endian block number (RSKIP-110)", () => {
    const d = script(opReturn(RSK_PAYLOAD(seq(20), "a1a2a3a4a5a6a7", 7, 6_000_123)));
    expect(d.id).toBe("rsk");
    expect(d.chain).toBe("RSK");
    expect(field(d, "Hash for merged mining (first 20 bytes)")).toBe(seq(20));
    expect(field(d, "Commit to parents vector")).toBe("a1a2a3a4a5a6a7");
    expect(field(d, "Uncles (last 32 blocks)")).toBe("7");
    expect(field(d, "RSK block number")).toBe("6000123");
    expect(d.commitment).toBe(seq(20) + "a1a2a3a4a5a6a7" + "07" + be32(6_000_123));
    expect(d.error).toBeUndefined();
  });

  it("RSK: a capped uncle count, a non-minimal PUSHDATA1 push, and a short payload", () => {
    const capped = script("6a4c29" + RSK_PAYLOAD(seq(20), seq(7), 255, 1));
    expect(capped.id).toBe("rsk");
    expect(field(capped, "Uncles (last 32 blocks)")).toBe("255 or more");
    const short = script(opReturn(asciiHex("RSKBLOCK:") + seq(10)));
    expect(short.id).toBe("rsk");
    expect(short.fields).toEqual([]);
    expect(short.error).toMatch(/expected at least 41/);
  });

  it("Core: version, validator and reward address (Core DAO delegation format)", () => {
    const validator = "0a".repeat(20);
    const reward = "bd".repeat(20);
    const d = script("6a2d" + asciiHex("CORE") + "01" + validator + reward);
    expect(d.id).toBe("core");
    expect(d.chain).toBe("Core");
    expect(field(d, "Validator")).toBe("0x" + validator);
    expect(field(d, "Reward address")).toBe("0x" + reward);
    expect(d.fields.find((f) => f.label === "Validator")!.href).toBe(`https://stake.coredao.org/validator/0x${validator}`);
    expect(d.commitment).toBe(`0x${validator}:0x${reward}`);
    expect(d.error).toBeUndefined();
  });

  it("Core: unknown version, truncated addresses, PUSHDATA form", () => {
    expect(script(opReturn(asciiHex("CORE") + "02" + "00".repeat(40))).error).toBe("unknown version 2");
    const short = script(opReturn(asciiHex("CORE") + "01" + "00".repeat(30)));
    expect(short.error).toMatch(/expected at least 45/);
    expect(field(short, "Validator")).toBeUndefined();
    const pd = script("6a4c2d" + asciiHex("CORE") + "01" + "11".repeat(40));
    expect(field(pd, "Validator")).toBe("0x" + "11".repeat(20));
    expect(pd.error).toMatch(/PUSHDATA/);
  });

  it("exSat: account name in the contract's 32-character alphabet", () => {
    // "pool1.x" -> p=15 o=14 o=14 l=11 1=26 .=31 x=23
    const name = "0f0e0e0b1a1f17";
    const d = script(opReturn(asciiHex("EXSAT") + "01" + name));
    expect(d.id).toBe("exsat");
    expect(d.chain).toBe("exSat");
    expect(field(d, "Account")).toBe("pool1.x");
    expect(d.commitment).toBe("pool1.x");
    expect(d.error).toBeUndefined();
  });

  it("exSat: bytes outside the alphabet and over-long names are flagged, not trusted", () => {
    const bad = script(opReturn(asciiHex("EXSAT") + "01" + "00" + "20" + "ff"));
    expect(field(bad, "Account")).toBe("a??");
    expect(bad.error).toMatch(/2 byte\(s\) outside/);
    const long = script(opReturn(asciiHex("EXSAT") + "01" + "00".repeat(40)));
    expect(field(long, "Account")).toBe("a".repeat(13)); // bounded
    expect(long.error).toMatch(/longer than 13/);
    expect(script(opReturn(asciiHex("EXSAT") + "01")).error).toMatch(/no account name/);
    expect(script(opReturn(asciiHex("EXSAT") + "07" + "00")).error).toBe("unknown version 7");
  });

  it("Syscoin: block hash (serialized, so reversed for display) and little-endian height", () => {
    const internal = seq(32); // as serialized: internal byte order
    const display = seq(32).match(/../g)!.reverse().join("");
    const d = script(opReturn(asciiHex("sys") + internal + le32(1_234_560)));
    expect(d.id).toBe("syscoin");
    expect(d.chain).toBe("Syscoin");
    expect(field(d, "Syscoin block")).toBe(display);
    expect(field(d, "Syscoin height")).toBe("1234560");
    expect(d.commitment).toBe(`1234560:${display}`);
    expect(d.error).toBeUndefined();
    expect(script(opReturn(asciiHex("sys") + internal + le32(1_234_567))).error).toMatch(/multiple of 10/);
    expect(script(opReturn(asciiHex("sys") + "00".repeat(10))).error).toMatch(/expected at least 39/);
  });

  it("Hathor: mining base hash after the magic", () => {
    const d = script(opReturn(asciiHex("Hath") + "cd".repeat(32)));
    expect(d.id).toBe("hathor");
    expect(d.chain).toBe("Hathor");
    expect(field(d, "Mining base hash")).toBe("cd".repeat(32));
    expect(script(opReturn(asciiHex("Hath") + "cd".repeat(32) + "00".repeat(4))).error).toMatch(/4 extra bytes/);
  });

  it("Omni: version and type", () => {
    const d = script(opReturn(asciiHex("omni") + "0000" + "0032" + "00".repeat(8)));
    expect(d.id).toBe("omni");
    expect(field(d, "Transaction version")).toBe("0");
    expect(field(d, "Transaction type")).toBe("50");
  });

  it("Runestone, empty, OP_0, unknown with a text prefix, and the BIP47 shape", () => {
    expect(script("6a5d0400").id).toBe("runestone");
    expect(script("6a").protocol).toBe("Empty OP_RETURN");
    expect(script("6a00").protocol).toBe("OP_RETURN (0 byte)");
    const u = script(opReturn(asciiHex("ZZZ1") + "0001"));
    expect(u.id).toBe("unknown");
    expect(u.confidence).toBe("heuristic");
    expect(field(u, "Leading text")).toBe("ZZZ1");
    expect(field(u, "Length")).toBe("6 bytes");
    expect(field(script(opReturn("0001")), "Leading text")).toBeUndefined();
    const bip47 = script(opReturn("01" + "00" + "02" + "00".repeat(77)));
    expect(bip47.id).toBe("bip47");
    expect(bip47.confidence).toBe("heuristic");
  });

  it("returns null for non-OP_RETURN scripts", () => {
    expect(decodeOpReturnScript(bytes("0014" + "11".repeat(20)))).toBeNull();
    expect(decodeOpReturnScript(new Uint8Array(0))).toBeNull();
  });
});

describe("hostile OP_RETURN input", () => {
  it("flags pushes longer than the script", () => {
    for (const s of ["6a4c", "6a4cff00", "6a4dffff00", "6a4effffffff00", "6a2d434f5245"]) {
      const d = script(s);
      expect(d.id).toBe("malformed");
      expect(d.error).toMatch(/push longer/);
    }
    expect(script("6a51").id).toBe("malformed"); // OP_1 is not a data push
  });

  it("decodes every truncation of every protocol without throwing", () => {
    const full = [
      "6a24aa21a9ed" + "ab".repeat(32),
      opReturn(RSK_PAYLOAD(seq(20), seq(7), 3, 99)),
      "6a2d" + asciiHex("CORE") + "01" + "22".repeat(40),
      opReturn(asciiHex("EXSAT") + "01" + "0f0e0e0b"),
      opReturn(asciiHex("sys") + seq(32) + le32(10)),
      opReturn(asciiHex("Hath") + seq(32)),
      opReturn(asciiHex("omni") + seq(8)),
    ];
    for (const s of full)
      for (let n = 1; n <= s.length / 2; n++) {
        const d = decodeOpReturnScript(bytes(s.slice(0, n * 2)));
        expect(d).not.toBeNull();
        for (const f of d!.fields) expect(typeof f.value).toBe("string");
      }
  });

  it("survives random scripts", () => {
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 255;
    for (let i = 0; i < 2000; i++) {
      const b = new Uint8Array(1 + (rnd() % 90));
      for (let k = 0; k < b.length; k++) b[k] = rnd();
      b[0] = 0x6a;
      expect(() => decodeOpReturnScript(b)).not.toThrow();
      expect(() => decodeOpReturnPayload(b.subarray(1))).not.toThrow();
    }
  });
});

describe("AuxPoW", () => {
  // Reference implementation of the spec's slot algorithm with BigInt (unsigned 32-bit wraparound).
  const refSlot = (nonce: number, chainId: number, size: number) => {
    const B = BigInt;
    const M = B(2) ** B(32);
    let r = (B(nonce) * B(1103515245) + B(12345)) % M;
    r = (r + B(chainId)) % M;
    r = (r * B(1103515245) + B(12345)) % M;
    return Number(r % BigInt(size));
  };

  it("computes slots like the spec's unsigned arithmetic", () => {
    expect(auxSlot(0, 1, 1)).toBe(0);
    for (const nonce of [0, 1, 7, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678])
      for (const chainId of [1, 16, 98, 1224, 0xffff])
        for (const size of [1, 2, 8, 16, 1024, 2 ** 31]) expect(auxSlot(nonce, chainId, size)).toBe(refSlot(nonce, chainId, size));
  });

  const aux = (over: Partial<Parameters<typeof describeAuxPow>[0]> = {}) =>
    describeAuxPow({ range: { start: 0, end: 44 }, root: "aa".repeat(32), merkleSize: 8, nonce: 7, magicCount: 1, ...over });

  it("derives tree height and each known chain's slot, flagging chains that share one", () => {
    const a = aux();
    expect(a.problems).toEqual([]);
    expect(a.treeHeight).toBe(3);
    for (const s of a.knownSlots) expect(s.slot).toBe(refSlot(7, s.chainId, 8));
    for (const s of a.knownSlots) {
      const others = a.knownSlots.filter((o) => o.name !== s.name && o.slot === s.slot).map((o) => o.name);
      expect(s.sharesSlotWith).toEqual(others);
    }
    expect(aux({ merkleSize: 1, nonce: 0 }).knownSlots.every((s) => s.slot === 0)).toBe(true);
  });

  it("reports what an aux chain would reject", () => {
    expect(aux({ merkleSize: 12 }).problems).toEqual(["merkle size 12 is not a power of two"]);
    expect(aux({ merkleSize: 0 }).problems[0]).toMatch(/not a power of two/);
    expect(aux({ merkleSize: 2 ** 32 - 1 }).knownSlots).toEqual([]);
    expect(aux({ merkleSize: undefined, nonce: undefined }).problems).toEqual(["the script ends before the merkle size and nonce"]);
    expect(aux({ magicCount: 2 }).problems[0]).toMatch(/2 times/);
  });
});

// A whole coinbase, split into stratum parts at the extranonce (written as a placeholder, then cut out).
function coinbase(opts: { sig: string; outputs: string[]; enInOutput?: number }) {
  const en1 = "a1b2c3d4";
  const en2 = 4;
  const enLen = en1.length / 2 + en2;
  const HOLE = "<EN>";
  const len = (hex: string, extra: number) => (hex.length / 2 + extra).toString(16).padStart(2, "0");
  const outs = opts.outputs.map((s, i) => {
    const inThis = opts.enInOutput === i;
    return le64(i === 0 ? 312_500_000 : 0) + len(s, inThis ? enLen : 0) + s + (inThis ? HOLE : "");
  });
  const inSig = opts.enInOutput === undefined;
  const tx =
    "01000000" + "01" + "00".repeat(32) + "ffffffff" + len(opts.sig, inSig ? enLen : 0) + opts.sig + (inSig ? HOLE : "") +
    "ffffffff" + outs.length.toString(16).padStart(2, "0") + outs.join("") + "00000000";
  const [coinbase1, coinbase2] = tx.split(HOLE);
  return { coinbase1, extranonce1: en1, extranonce2Length: en2, coinbase2 };
}

describe("decodeMergeMining", () => {
  const P2WPKH = "0014" + "11".repeat(20);
  const height = "03" + "1ce40e";
  const auxpow = (root: string, size: number, nonce: number) => "fabe6d6d" + root + le32(size) + le32(nonce);
  const outputs = (rskHeight: number) => [
    P2WPKH,
    "6a24aa21a9ed" + "22".repeat(32),
    opReturn(RSK_PAYLOAD(seq(20), seq(7), 1, rskHeight)),
    "6a2d" + asciiHex("CORE") + "01" + "33".repeat(40),
  ];

  it("summarizes the chains a template commits to, in a stable order", () => {
    const c = coinbase({ sig: height + push(auxpow("ee".repeat(32), 16, 0)) + push(asciiHex("/Example/")), outputs: outputs(100) });
    const r = decodeMergeMining(c.coinbase1, c.extranonce1, c.extranonce2Length, c.coinbase2);
    expect(r.parsed.ok).toBe(true);
    expect(r.auxpow!.root).toBe("ee".repeat(32));
    expect(r.auxpow!.merkleSize).toBe(16);
    expect(r.summary.chains).toEqual(["AuxPoW", "RSK", "Core"]);
    expect(r.summary.label).toBe("AuxPoW(16) RSK Core");
    expect(r.outputs.map((o) => o.opReturn?.id ?? null)).toEqual([null, "witness", "rsk", "core"]);
  });

  it("tracks which commitments changed between two templates", () => {
    const a = coinbase({ sig: height + push(auxpow("ee".repeat(32), 16, 0)), outputs: outputs(100) });
    const b = coinbase({ sig: height + push(auxpow("ef".repeat(32), 16, 0)), outputs: outputs(101) });
    const c = coinbase({ sig: height + push(auxpow("ef".repeat(32), 8, 0)), outputs: outputs(101).slice(0, 3) });
    const sa = decodeMergeMining(a.coinbase1, a.extranonce1, a.extranonce2Length, a.coinbase2).summary;
    const sb = decodeMergeMining(b.coinbase1, b.extranonce1, b.extranonce2Length, b.coinbase2).summary;
    const sc = decodeMergeMining(c.coinbase1, c.extranonce1, c.extranonce2Length, c.coinbase2).summary;
    expect(formatMergeMiningChange(diffMergeMining(sa, sa))).toBe("");
    const ab = diffMergeMining(sa, sb);
    expect(ab).toEqual({ added: [], removed: [], changed: ["AuxPoW", "RSK"], setChanged: false });
    const bc = diffMergeMining(sb, sc);
    expect(bc.removed).toEqual(["Core"]);
    expect(bc.setChanged).toBe(true); // Core gone, and the AuxPoW tree shrank
    expect(formatMergeMiningChange(bc)).toBe("−Core AuxPoW");
  });

  it("labels an OP_RETURN that holds the extranonce as such, not as a protocol", () => {
    const c = coinbase({ sig: height + push(asciiHex("/Example/")), outputs: [P2WPKH, "6a0e" + "0102"], enInOutput: 1 });
    const r = decodeMergeMining(c.coinbase1, c.extranonce1, c.extranonce2Length, c.coinbase2);
    expect(r.parsed.ok).toBe(true);
    expect(r.parsed.extranonceIn).toEqual(["output 1 script"]);
    expect(r.outputs[1].opReturn!.id).toBe("extranonce");
    expect(r.summary.chains).toEqual([]);
  });

  it("counts repeated protocols and keeps the summary stable under output reordering", () => {
    const core = (b: string) => "6a2d" + asciiHex("CORE") + "01" + b.repeat(40);
    const x = summarize(
      [core("44"), core("55")].map((s, i) => ({ index: i, value: 0, script: { start: 0, end: 0 }, opReturn: script(s) })),
      null
    );
    const y = summarize(
      [core("55"), core("44")].map((s, i) => ({ index: i, value: 0, script: { start: 0, end: 0 }, opReturn: script(s) })),
      null
    );
    expect(x.label).toBe("Core×2");
    expect(x).toEqual(y);
  });

  it("never throws on garbage parts", () => {
    for (const parts of [
      ["", "", 0, ""],
      ["zz", "", 4, "00"],
      ["01000000", "ab", 999, "00"],
      ["01000000" + "01" + "00".repeat(36) + "ff", "", 4, ""],
    ] as [string, string, number, string][]) {
      const r = decodeMergeMining(...parts);
      expect(r.summary.label).toBe("");
      expect(r.parsed.ok).toBe(false);
    }
  });
});

describe("bitcoinUtils compatibility", () => {
  it("keeps the legacy protocol names and detail keys", () => {
    const rsk = decodeOpReturnData(RSK_PAYLOAD(seq(20), seq(7), 2, 5));
    expect(rsk.protocol).toBe("RSK Block");
    expect(rsk.details?.rskBlockHash).toBe(seq(20) + seq(7) + "02" + be32(5));
    const core = decodeOpReturnData(asciiHex("CORE") + "01" + "66".repeat(20) + "77".repeat(20));
    expect(core.details).toEqual({ validatorAddress: "0x" + "66".repeat(20), rewardAddress: "0x" + "77".repeat(20) });
    expect(decodeOpReturnData(asciiHex("EXSAT") + "01" + "00").details?.synchronizerAccount).toBe("a");
    expect(decodeOpReturnData(asciiHex("Hath") + "cd".repeat(32)).details?.auxBlockHash).toBe("cd".repeat(32));
    expect(decodeOpReturnData("").protocol).toBe("Empty OP_RETURN");
    expect(decodeOpReturnData("xyz").protocol).toBe("Malformed OP_RETURN");
  });

  it("decodes OP_RETURN outputs in computeCoinbaseOutputs with named fields", () => {
    const c = coinbase({ sig: "03" + "1ce40e" + push(asciiHex("/Example/")), outputs: [
      "0014" + "11".repeat(20),
      opReturn(asciiHex("sys") + seq(32) + le32(20)),
      "6a4c",
    ] });
    const raw = c.coinbase1 + c.extranonce1 + "00".repeat(c.extranonce2Length) + c.coinbase2;
    const outs = computeCoinbaseOutputs(raw);
    expect(outs.map((o) => o.type)).toEqual(["address", "nulldata", "nulldata"]);
    expect(outs[1].decodedData!.protocol).toBe("Syscoin");
    expect(outs[1].decodedData!.fields!.find((f) => f.label === "Syscoin height")!.value).toBe("20");
    expect(outs[2].decodedData!.protocol).toBe("Malformed OP_RETURN");
  });
});
