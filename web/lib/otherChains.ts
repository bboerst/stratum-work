/**
 * /api/other-chains template rows: the MiningNotify shape (pg-mapping), extranonce1 masked (connectionMask, #105),
 * plus fields decoded on the server so the browser only renders them (client performance principle): the coinbase
 * scriptSig's height, text tags and merge-mining (AuxPoW) commitment, and the outputs. Server-only (connectionMask).
 *
 * Other chains' coinbases needn't be Bitcoin transactions: parseCoinbase never throws and keeps what it could parse.
 * Output addresses are in Bitcoin's encoding (the same script on another chain has another address format).
 */
import { maskTemplate } from './connectionMask';
import { templateRowToMiningNotify } from './db/pg-mapping';
import type { OtherTemplateRow } from './db/other-chains';
import { parseCoinbase, coinbaseTagText } from '../utils/coinbaseParser';
import { addressFromScript } from '../utils/addressFromScript';
import { decodeOpReturnScript } from '../utils/mergeMining';
import { reverseHex } from '../utils/formatters';

export interface OtherChainOutput {
  value: number;                 // satoshis (the other chain's base unit)
  address?: string;              // Bitcoin encoding of a standard script
  protocol?: string;             // OP_RETURN protocol, when recognised
  script_hex: string;
}

export interface OtherChainTemplate {
  id: string;
  pool_name: string;
  chain: string;
  reason: string;
  height: number;                // as reported (the BIP34 push the collector parsed, or 0 when it couldn't)
  received_at: number;           // ms since the epoch (this row's own receive time)
  received_us: string;           // the same in µs: the page cursor
  copies: number;                // connections that saw this exact template (de-duplicated reads)
  prev_hash: string;             // display order
  version: string;
  nbits: string;
  ntime: string;
  clean_jobs: boolean;
  extranonce1: string;           // masked
  extranonce2_length: number;
  merkle_branches: number;       // count
  coinbase1: string;
  coinbase2: string;
  coinbase_ok: boolean;          // parsed as a transaction to the end
  coinbase_error?: string;
  scriptsig_height: number | null;
  coinbase_tags: string;         // printable text in the scriptSig (no height, AuxPoW or extranonce bytes)
  auxpow: boolean;
  auxpow_root: string | null;
  auxpow_merkle_size: number | null;
  outputs: OtherChainOutput[];
  output_total: number;
}

const MAX_OUTPUTS_SHOWN = 20;

export function toOtherChainTemplate(row: OtherTemplateRow): OtherChainTemplate {
  const t = maskTemplate(templateRowToMiningNotify(row));
  const parsed = parseCoinbase(t.coinbase1, t.extranonce1, t.extranonce2_length, t.coinbase2, { ntime: parseInt(t.ntime, 16) });
  const bytes = Buffer.from(t.coinbase1 + t.extranonce1 + '00'.repeat(t.extranonce2_length) + t.coinbase2, 'hex');
  const outputs = parsed.outputs.slice(0, MAX_OUTPUTS_SHOWN).map(o => {
    const script = bytes.subarray(o.script.start, o.script.end);
    const out: OtherChainOutput = { value: o.value, script_hex: script.toString('hex') };
    const address = addressFromScript(script);
    if (address) out.address = address;
    else {
      const op = decodeOpReturnScript(Uint8Array.from(script));
      if (op) out.protocol = op.protocol;
    }
    return out;
  });
  const aux = parsed.scriptSig?.auxpow ?? null;
  // The SQL summary's rule (magic anywhere in coinbase1 or coinbase2), so the flag matches the AuxPoW share.
  const auxpow = t.coinbase1.includes('fabe6d6d') || t.coinbase2.includes('fabe6d6d') || aux !== null;
  return {
    id: t.id, pool_name: row.source_name, chain: row.chain ?? 'unknown', reason: row.reason, height: t.height,
    received_at: Math.floor(Number(row.received_us) / 1000), received_us: String(row.received_us),
    copies: Number(row.copies ?? 1),
    prev_hash: reverseHex(t.prev_hash), version: t.version, nbits: t.nbits, ntime: t.ntime, clean_jobs: t.clean_jobs,
    extranonce1: t.extranonce1 ?? '', extranonce2_length: t.extranonce2_length, merkle_branches: t.merkle_branches.length,
    coinbase1: t.coinbase1, coinbase2: t.coinbase2,
    coinbase_ok: parsed.ok, ...(parsed.error ? { coinbase_error: parsed.error } : {}),
    scriptsig_height: parsed.scriptSig?.height ?? null,
    coinbase_tags: parsed.scriptSig ? coinbaseTagText(parsed) : '',
    auxpow, auxpow_root: aux?.root ?? null, auxpow_merkle_size: aux?.merkleSize ?? null,
    outputs, output_total: parsed.outputs.reduce((s, o) => s + o.value, 0),
  };
}
