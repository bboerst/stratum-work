import { describe, it, expect } from "vitest";
import { address, networks } from "bitcoinjs-lib";
import { addressFromScript } from "../addressFromScript";

// Same answer as bitcoinjs-lib's fromOutputScript (the reference), without its exceptions. Except taproot:
// fromOutputScript throws for every P2TR output without an initialised ECC library, so the reference encodes it as
// BIP350 specifies (bech32m, version 1).
function reference(script: Uint8Array): string | null {
  if (script.length === 34 && script[0] === 0x51 && script[1] === 0x20) return address.toBech32(script.subarray(2), 1, "bc");
  try {
    return address.fromOutputScript(script, networks.bitcoin);
  } catch {
    return null;
  }
}

let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x100000000);
const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
const cat = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));

describe("addressFromScript", () => {
  it("encodes a known taproot output (BIP350 test vector)", () => {
    const s = Uint8Array.from(Buffer.from("512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex"));
    expect(addressFromScript(s)).toBe("bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0");
  });

  it("matches fromOutputScript on every standard type", () => {
    const cases = [
      cat([0x76, 0xa9, 0x14], bytes(20), [0x88, 0xac]), // P2PKH
      cat([0xa9, 0x14], bytes(20), [0x87]), // P2SH
      cat([0x00, 0x14], bytes(20)), // P2WPKH
      cat([0x00, 0x20], bytes(32)), // P2WSH
      cat([0x51, 0x20], bytes(32)), // P2TR
      cat([0x52, 0x10], bytes(16)), // future witness version
      cat([0x60, 0x28], bytes(40)),
    ];
    for (const s of cases) {
      const want = reference(s);
      expect(want).not.toBeNull();
      expect(addressFromScript(s)).toBe(want);
    }
  });

  it("returns null wherever fromOutputScript throws, and the same address elsewhere (fuzz)", () => {
    const shapes = [
      () => cat([0x6a, 0x24, 0xaa, 0x21, 0xa9, 0xed], bytes(32)), // witness commitment
      () => cat([0x6a], bytes(Math.floor(rnd() * 80))), // other OP_RETURN
      () => cat([0x00, 0x14], bytes(19)), // wrong lengths
      () => cat([0x00, 0x15], bytes(21)),
      () => cat([0x00, 0x1f], bytes(31)),
      () => cat([0x51, 0x01], bytes(1)),
      () => cat([0x51, 0x29], bytes(41)),
      () => cat([0x76, 0xa9, 0x14], bytes(20), [0x88, 0xad]),
      () => cat([0xa9, 0x14], bytes(20), [0x88]),
      () => cat([0x50 + Math.floor(rnd() * 18), 2 + Math.floor(rnd() * 40)], bytes(2 + Math.floor(rnd() * 40))),
      () => bytes(Math.floor(rnd() * 45)),
    ];
    for (let i = 0; i < 5000; i++) {
      const s = shapes[i % shapes.length]();
      expect(addressFromScript(s)).toBe(reference(s));
    }
  });
});
