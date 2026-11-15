import { describe, it, expect } from "vitest";
import { Transaction } from "bitcoinjs-lib";
import { parseCoinbase, coinbaseTagText, tokenizeScript, MAX_COINBASE_BYTES, ParsedCoinbase } from "../coinbaseParser";
import { decodeCoinbaseScriptSigInfo } from "../bitcoinUtils";

const hex = (s: string) => Buffer.from(s, "ascii").toString("hex");
const le32 = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255]).toString("hex");
const le64 = (n: number) => le32(n % 0x100000000) + le32(Math.floor(n / 0x100000000));
const varint = (n: number) => (n < 0xfd ? n.toString(16).padStart(2, "0") : "fd" + le32(n).slice(0, 4));
const push = (dataHex: string) => varint(dataHex.length / 2) + dataHex;
const P2WPKH = "0014" + "11".repeat(20);

interface Spec {
  sigBefore: string; // scriptSig hex before the extranonce
  sigAfter?: string; // scriptSig hex after it
  en1?: string;
  en2?: number;
  outputs?: { value: number; script: string }[];
  segwit?: boolean;
  sequence?: number;
  enInOutput?: number; // put the extranonce inside this output's script instead of the scriptSig
}

// Builds a coinbase and splits it into the stratum parts at the extranonce.
function build(s: Spec) {
  const en1 = s.en1 ?? "a1b2c3d4";
  const en2 = s.en2 ?? 8;
  const enHex = en1 + "00".repeat(en2);
  const outs = s.outputs ?? [{ value: 312_500_000, script: P2WPKH }, { value: 0, script: "6a24aa21a9ed" + "22".repeat(32) }];
  const inOut = s.enInOutput !== undefined;
  const sig = s.sigBefore + (inOut ? "" : enHex) + (s.sigAfter ?? "");
  let txHex = le32(2) + (s.segwit ? "0001" : "") + "01" + "00".repeat(32) + "ffffffff" + varint(sig.length / 2) + sig + le32(s.sequence ?? 0xffffffff);
  txHex += varint(outs.length);
  outs.forEach((o, i) => {
    const script = inOut && i === s.enInOutput ? o.script + enHex : o.script;
    txHex += le64(o.value) + varint(script.length / 2) + script;
  });
  if (s.segwit) txHex += "01" + "20" + "00".repeat(32);
  txHex += le32(0);
  const split = txHex.indexOf(enHex, inOut ? txHex.length - 200 : 0);
  return {
    coinbase1: txHex.slice(0, split),
    extranonce1: en1,
    extranonce2Length: en2,
    coinbase2: txHex.slice(split + enHex.length),
    txHex,
  };
}

const parse = (b: ReturnType<typeof build>) => parseCoinbase(b.coinbase1, b.extranonce1, b.extranonce2Length, b.coinbase2);
const heightPush = (h: number) => push(le32(h).slice(0, 6)); // 3-byte BIP34 push

function checkInvariants(p: ParsedCoinbase) {
  for (const f of p.fields) {
    expect(f.start).toBeGreaterThanOrEqual(0);
    expect(f.end).toBeLessThanOrEqual(p.size);
    expect(f.end).toBeGreaterThanOrEqual(f.start);
  }
  if (p.scriptSig) {
    const s = p.scriptSig;
    let at = s.start;
    for (const seg of s.segments) {
      expect(seg.start).toBe(at); // contiguous, in order, covering the scriptSig
      expect(seg.end).toBeGreaterThan(seg.start);
      at = seg.end;
    }
    expect(at).toBe(s.segments.length ? s.end : s.start);
    for (const t of s.tags) expect(t.text.length).toBe(t.end - t.start);
  }
}

describe("parseCoinbase: structure", () => {
  it("maps a typical coinbase: height, tag, extranonce inside the scriptSig", () => {
    const b = build({ sigBefore: heightPush(975_900) + push(hex("Mined by Example Pool")), sigAfter: push(hex("/tail/")) });
    const p = parse(b);
    expect(p.ok).toBe(true);
    expect(p.size).toBe(b.txHex.length / 2);
    expect(p.scriptSig!.height).toBe(975_900);
    expect(p.extranonceIn).toEqual(["scriptSig"]);
    expect(p.scriptSig!.tags.map((t) => t.text)).toEqual(["Mined by Example Pool", "/tail/"]);
    expect(coinbaseTagText(p)).toBe("Mined by Example Pool /tail/");
    expect(p.outputs.map((o) => o.value)).toEqual([312_500_000, 0]);
    const kinds = p.scriptSig!.segments.map((s) => s.kind);
    expect(kinds).toEqual(["height", "push", "tag", "extranonce1", "extranonce2", "push", "tag"]);
    checkInvariants(p);
  });

  it("agrees with bitcoinjs on every field it reports", () => {
    const b = build({ sigBefore: heightPush(1_000_000) + push(hex("tag-text")), segwit: true, sequence: 0x12345678,
      outputs: [{ value: 1, script: P2WPKH }, { value: 2, script: "76a914" + "33".repeat(20) + "88ac" }, { value: 0, script: "6a0401020304" }] });
    const p = parse(b);
    const tx = Transaction.fromHex(b.txHex);
    expect(p.ok).toBe(true);
    expect(p.segwit).toBe(true);
    expect(p.version).toBe(tx.version);
    expect(p.sequence).toBe(tx.ins[0].sequence);
    expect(p.locktime).toBe(tx.locktime);
    const sig = p.scriptSig!;
    expect(b.txHex.slice(sig.start * 2, sig.end * 2)).toBe(Buffer.from(tx.ins[0].script).toString("hex"));
    expect(p.outputs.length).toBe(tx.outs.length);
    p.outputs.forEach((o, i) => {
      expect(o.value).toBe(Number(tx.outs[i].value));
      expect(b.txHex.slice(o.script.start * 2, o.script.end * 2)).toBe(Buffer.from(tx.outs[i].script).toString("hex"));
    });
  });

  it("finds the extranonce when it runs past the scriptSig into nSequence", () => {
    // The scriptSig ends 5 bytes into the 9-byte extranonce; its last 4 bytes are read as nSequence.
    const before = heightPush(975_900) + push(hex("/Example/"));
    const coinbase1 = le32(2) + "01" + "00".repeat(32) + "ffffffff" + varint(before.length / 2 + 5) + before;
    const coinbase2 = "01" + le64(312_500_000) + varint(P2WPKH.length / 2) + P2WPKH + le32(0);
    const p = parseCoinbase(coinbase1, "ab", 8, coinbase2);
    expect(p.ok).toBe(true);
    expect(p.extranonceIn).toEqual(["scriptSig", "sequence"]);
    expect(p.scriptSig!.tags.map((t) => t.text)).toEqual(["/Example/"]);
    checkInvariants(p);
  });

  it("finds the extranonce inside an output script", () => {
    const b = build({ sigBefore: heightPush(975_900) + push(hex("< Example >")), en1: "abcdef", en2: 4, enInOutput: 1,
      outputs: [{ value: 1, script: P2WPKH }, { value: 0, script: "6a0b" + "44".repeat(4) }, { value: 0, script: "6a0100" }] });
    const p = parse(b);
    expect(p.ok).toBe(true);
    expect(p.extranonceIn).toEqual(["output 1 script"]);
    expect(p.scriptSig!.segments.some((s) => s.kind.startsWith("extranonce"))).toBe(false);
    expect(coinbaseTagText(p)).toBe("< Example >");
  });

  it("never reads extranonce bytes as text, whatever they contain", () => {
    const en1 = hex("ABCD"); // printable, would otherwise join the tag
    const b = build({ sigBefore: heightPush(975_900) + "1c" + hex("Mined by X"), en1, en2: 4, sigAfter: hex("yz") });
    const p = parse(b);
    expect(p.scriptSig!.tags.map((t) => t.text)).toEqual(["Mined by X"]);
    expect(coinbaseTagText(p)).not.toContain("ABCD");
  });

  it("decodes AuxPoW with merkle size and nonce", () => {
    const root = "55".repeat(31) + "66";
    const aux = "fabe6d6d" + root + le32(8) + le32(7);
    const b = build({ sigBefore: heightPush(975_900) + push(hex("merge") + aux) });
    const s = parse(b).scriptSig!;
    expect(s.auxpow).not.toBeNull();
    expect(s.auxpow!.root).toBe(root); // coinbase byte order is already display order
    expect(s.auxpow!.magicCount).toBe(1);
    expect(s.auxpow!.merkleSize).toBe(8);
    expect(s.auxpow!.nonce).toBe(7);
    expect(s.segments.find((x) => x.kind === "auxpow")!.end - s.segments.find((x) => x.kind === "auxpow")!.start).toBe(44);
    expect(s.tags.map((t) => t.text)).toEqual(["merge"]);
  });

  it("keeps raw (unpushed) text in a script that isn't push-only", () => {
    // Text bytes placed straight in the script read as opcodes; the parser must still find the tag.
    const b = build({ sigBefore: heightPush(975_900) + "04" + "01020304" + hex("RawTextPoolX") + "b0" });
    const s = parse(b).scriptSig!;
    expect(s.pushOnly).toBe(false);
    expect(s.tags.map((t) => t.text)).toContain("RawTextPoolX");
  });

  it("labels a pushed Unix time close to ntime, and only then", () => {
    const ntime = 1_789_000_000;
    const b = build({ sigBefore: heightPush(975_900) + push(le32(ntime - 30)) + push(hex("/ExamplePool/")) });
    const p = parseCoinbase(b.coinbase1, b.extranonce1, b.extranonce2Length, b.coinbase2, { ntime });
    expect(p.scriptSig!.time).toBe(ntime - 30);
    expect(p.scriptSig!.segments.map((x) => x.kind)).toContain("time");
    expect(parse(b).scriptSig!.time).toBeNull(); // no ntime given
    const far = parseCoinbase(b.coinbase1, b.extranonce1, b.extranonce2Length, b.coinbase2, { ntime: ntime + 10 * 86400 });
    expect(far.scriptSig!.time).toBeNull();
  });

  it("doesn't run text across the end of a push (a timestamp's printable bytes stay out of the tag)", () => {
    // 4 pushed bytes ending in 'y', 'j' (as a 2026 timestamp does), then raw text
    const b = build({ sigBefore: heightPush(975_900) + push("0102796a") + hex("ExamplePool/42/") + "b0" });
    const tags = parse(b).scriptSig!.tags.map((t) => t.text);
    expect(tags).toEqual(["ExamplePool/42/"]);
    // also when 3 of the 4 pushed bytes are printable
    const c = build({ sigBefore: heightPush(975_900) + push("3b796a71") + hex("ExamplePool/42/") + "b0" });
    expect(parse(c).scriptSig!.tags.map((t) => t.text)).toEqual(["ExamplePool/42/"]);
  });

  it("ignores short printable runs in binary data, including a pushed 4-byte value that happens to be printable", () => {
    const b = build({ sigBefore: heightPush(975_900) + push("00" + hex("CvYH") + "00ff") + push(hex("&bF$")) + push(hex("Mined by X")) });
    expect(parse(b).scriptSig!.tags.map((t) => t.text)).toEqual(["Mined by X"]);
  });

  it("keeps a tag whole when the pool's push length doesn't match its text", () => {
    // After the extranonce: 0a "tagpool" 0d "/longer/name/": the 0x0a push length cuts into the second string.
    const b = build({ sigBefore: heightPush(975_900), sigAfter: "0a" + hex("tagpool") + "0d" + hex("/longer/name/") });
    expect(coinbaseTagText(parse(b))).toBe("tagpool /longer/name/");
    // the same with a 19-byte second push
    const c = build({ sigBefore: heightPush(975_900), sigAfter: "0a" + hex("tagpool") + "13" + hex("ab/solo.example.org") });
    expect(coinbaseTagText(parse(c))).toBe("tagpool ab/solo.example.org");
  });

  it("matches the existing BIP34 height decoder on all its cases", () => {
    for (const pre of ["0393e20e", "0340420f", "03ffff7f", "0400008000", "023412", "0111", "51", "60", "0393e28e", "0b" + "00".repeat(11), ""]) {
      const b = build({ sigBefore: pre + push(hex("/tag/")) });
      const old = decodeCoinbaseScriptSigInfo(Buffer.from(pre + push(hex("/tag/")) + b.extranonce1 + "00".repeat(8), "hex")).height ?? null;
      expect(parse(b).scriptSig!.height).toBe(old);
    }
  });
});

describe("parseCoinbase: hostile and malformed input", () => {
  it("reports, never throws, on bad parts", () => {
    expect(parseCoinbase("zz", "", 4, "").ok).toBe(false);
    expect(parseCoinbase("abc", "", 4, "").error).toBe("not hex");
    expect(parseCoinbase("", "", -1, "").error).toBe("invalid extranonce2 length");
    expect(parseCoinbase("", "", 4.5, "").ok).toBe(false);
    // @ts-expect-error runtime garbage from a third party
    expect(parseCoinbase(null, undefined, 4, 5).ok).toBe(false);
    expect(parseCoinbase("00".repeat(MAX_COINBASE_BYTES + 1), "", 0, "").error).toBe("coinbase too large");
  });

  it("rejects huge declared lengths without looping or allocating", () => {
    const coinbase1 = le32(2) + "01" + "00".repeat(32) + "ffffffff" + varint(4 + 12) + heightPush(1);
    const tail = "ffffffff"; // nSequence after the extranonce
    // 2^64-1 outputs
    let p = parseCoinbase(coinbase1, "a1b2c3d4", 8, tail + "ffffffffffffffffff" + le32(0));
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/too many outputs/);
    expect(p.scriptSig!.height).toBe(1); // what was parsed before the failure is still returned
    // one output whose script claims 4 GiB
    p = parseCoinbase(coinbase1, "a1b2c3d4", 8, tail + "01" + le64(1) + "feffffffff" + "00");
    expect(p.error).toMatch(/longer than the coinbase/);
    // a scriptSig claiming more than the coinbase holds
    p = parseCoinbase(le32(2) + "01" + "00".repeat(32) + "ffffffff" + "fdffff", "", 0, "00");
    expect(p.error).toMatch(/scriptSig longer/);
  });

  it("handles truncated pushes inside the scriptSig", () => {
    const sig = new Uint8Array([0x4d, 0xff]); // PUSHDATA2 with a missing length byte
    expect(tokenizeScript(sig, 0, sig.length).pushes[0].truncated).toBe(true);
    const sig2 = new Uint8Array([0x4b, 1, 2]); // push 75, only 2 bytes left
    const t = tokenizeScript(sig2, 0, sig2.length);
    expect(t.pushOnly).toBe(false);
    expect(t.pushes[0].end).toBe(3);
  });

  it("survives random bytes and mutated coinbases (fuzz)", () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const randHex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 256).toString(16).padStart(2, "0")).join("");
    const base = build({ sigBefore: heightPush(975_900) + push(hex("Mined by Fuzz")) + "fabe6d6d" + "77".repeat(40), segwit: true });
    const started = Date.now();
    for (let i = 0; i < 3000; i++) {
      let c1 = base.coinbase1, c2 = base.coinbase2;
      if (i % 3 === 0) {
        c1 = randHex(Math.floor(rnd() * 120));
        c2 = randHex(Math.floor(rnd() * 200));
      } else {
        // flip, insert or delete a few bytes
        const which = rnd() < 0.5 ? "c1" : "c2";
        let s = which === "c1" ? c1 : c2;
        for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) {
          const at = Math.floor(rnd() * (s.length / 2)) * 2;
          const r = rnd();
          s = r < 0.4 ? s.slice(0, at) + randHex(1) + s.slice(at + 2) : r < 0.7 ? s.slice(0, at) + randHex(1 + Math.floor(rnd() * 9)) + s.slice(at) : s.slice(0, at) + s.slice(at + 2);
        }
        if (which === "c1") c1 = s; else c2 = s;
      }
      const p = parseCoinbase(c1, rnd() < 0.2 ? "" : base.extranonce1, Math.floor(rnd() * 12), c2);
      checkInvariants(p);
      expect(typeof coinbaseTagText(p)).toBe("string");
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
