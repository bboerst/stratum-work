import { address } from "bitcoinjs-lib";

// The mainnet address of an output script, or null when it isn't a standard address script (OP_RETURN, bare
// multisig, anything else). Matches bitcoinjs-lib's address.fromOutputScript, but by recognising the script
// patterns directly instead of trying each address type and catching the exception: those exceptions (valibot
// errors with stack traces) made decoding coinbase outputs one of the most expensive things the browser did on page
// load (perf harness, #157).
//
// Taproot: fromOutputScript throws for every P2TR output here (it needs an ECC library initialised, which this app
// doesn't), so taproot payouts used to show as "unknown". They're encoded as bech32m addresses now.

const P2PKH = 0x00;
const P2SH = 0x05;
const HRP = "bc";

export function addressFromScript(script: Uint8Array): string | null {
  const n = script.length;
  // P2PKH: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG
  if (n === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac) {
    return address.toBase58Check(script.subarray(3, 23), P2PKH);
  }
  // P2SH: OP_HASH160 <20> OP_EQUAL
  if (n === 23 && script[0] === 0xa9 && script[1] === 0x14 && script[22] === 0x87) {
    return address.toBase58Check(script.subarray(2, 22), P2SH);
  }
  // Witness programs: OP_0 <20|32>, or OP_1..OP_16 <2..40> (BIP141/BIP350). bech32 for v0, bech32m from v1.
  if (n >= 4 && n <= 42 && script[1] === n - 2) {
    const op = script[0];
    const program = script.subarray(2);
    if (op === 0x00 && (program.length === 20 || program.length === 32)) return address.toBech32(program, 0, HRP);
    // v1 is taproot (32 bytes); bitcoinjs-lib refuses other v1 lengths, and so do we.
    if (op === 0x51) return program.length === 32 ? address.toBech32(program, 1, HRP) : null;
    if (op >= 0x52 && op <= 0x60) return address.toBech32(program, op - 0x50, HRP);
  }
  return null;
}
