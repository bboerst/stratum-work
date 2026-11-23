"""Stale blocks our node never saw, from the public stale-blocks dataset (#243). Postgres mode only.

Templates prove that a block existed when pools built on it: a template's prev_hash is the hash of the block it builds
on. When that hash is no block we know (bitcoin_parents: blocks and stale_blocks), the block lost a race before our
node had it, or it is from before stale-block tracking (backend/stale_blocks.py records only what the node's
getchaintips knows). Our node can't give us its header, but the public dataset github.com/bitcoin-data/stale-blocks
(CC0) often can: `stale-blocks.csv` (height,hash,header hex where known) and `blocks/<height>-<hash>.bin` (raw blocks).

Candidates: (height, prev_hash) pairs of templates whose prev_hash is no known block, read per height chunk through
the templates height index and only inside each height's receive window (template_height_windows(): a re-sent old job
or another chain's template at that height doesn't count). A parent is stored only if the dataset has it and it
passes every check below, whether one pool or several (distinct sources.name) built on it: several pools building on a
parent doesn't by itself prove it was a block. A multi-pool parent the dataset lacks is only reported
(multi_pool_not_in_dataset). Every candidate's header is checked before anything is stored:
  - hash      dsha256(header), reversed, equals the dataset's hash and the templates' prev_hash
  - pow       the hash meets the header's bits target (and the target is within mainnet's proof-of-work limit)
  - bits      the header's bits equal the best chain block's at the same height (same difficulty period), when we
              have it; "difficulty_unchecked" counts the blocks where we don't
  - prev      the header builds on our best block at height - 1 (blocks_best)
  - height    the dataset height is the template height - 1, and our best block at that height is another block
Anything failing is reported and skipped, never stored. A stored row: header_source 'bitcoin-data/stale-blocks',
chaintip_status = last_status = 'not-in-node' (no status of our node applies), tip_hash itself, fork_height
height - 1, first_seen the earliest template on it (when we first had evidence of it), was_active false.

Full block: when the dataset has its .bin, the block must parse exactly (every byte), carry the validated header, and
its transactions must fold to the header's merkle root (backend/coinbase.py); then its coinbase, size, weight and pool
(the backend's pool identification over the coinbase script and payout addresses) are stored. A block file that fails
is reported and only the header is stored.

Idempotent: candidates exclude known blocks and the insert is ON CONFLICT DO NOTHING. --dry-run stores nothing.

    python -m stale_import --csv stale-blocks.csv [--blocks-dir blocks/] [--dry-run] [--from-height H] [--to-height H]

Connects like the backend (PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD, PG_SSLMODE, PG_SSLROOTCERT), as a user
in the stratum_backend role. Prints the summary as JSON.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import logging
import pathlib
import sys
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

from coinbase import _varint, dsha256, fold, merkle_branches, strip_witness

HEADER_SOURCE = "bitcoin-data/stale-blocks"
STATUS = "not-in-node"
CHUNK_HEIGHTS = 1000
POW_LIMIT = 0xFFFF << 208          # mainnet: bits 0x1d00ffff

logger = logging.getLogger("backend.stale_import")


# --- header ------------------------------------------------------------------------------------------------------------
def bits_target(bits: int) -> Optional[int]:
    """The target a compact nBits encodes; None for a negative or zero target (never valid)."""
    exp, mant = bits >> 24, bits & 0x007FFFFF
    if bits & 0x00800000 or mant == 0:
        return None
    return mant >> (8 * (3 - exp)) if exp <= 3 else mant << (8 * (exp - 3))


def parse_header(header: bytes) -> Dict[str, Any]:
    """An 80-byte header's fields, hashes in display (RPC) order like the tracker stores them."""
    if len(header) != 80:
        raise ValueError(f"header is {len(header)} bytes, not 80")
    return {
        "block_hash": dsha256(header)[::-1].hex(),
        "version": int.from_bytes(header[0:4], "little", signed=True),
        "prev_hash": header[4:36][::-1].hex(),
        "merkle_root": header[36:68][::-1].hex(),
        "time": int.from_bytes(header[68:72], "little"),
        "bits": int.from_bytes(header[72:76], "little"),
        "nonce": int.from_bytes(header[76:80], "little"),
    }


def read_dataset(path: str) -> Dict[str, Dict[str, Any]]:
    """stale-blocks.csv -> {hash: {hash, height, header (bytes or None)}}. Rows that don't parse are left out."""
    out: Dict[str, Dict[str, Any]] = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            try:
                h = (row.get("hash") or "").strip().lower()
                header = (row.get("header") or "").strip()
                bytes.fromhex(h)
                out[h] = {"hash": h, "height": int(row["height"]), "header": bytes.fromhex(header) if header else None}
            except (ValueError, KeyError, TypeError):
                continue
    return out


def validate(candidate: Dict[str, Any], entry: Dict[str, Any], best: Dict[int, List[Dict[str, Any]]]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """(header fields, None) when the dataset entry is the block the candidate's templates built on, else
    (None, reason). best: {height: [{block_hash, bits}]} from blocks_best at height - 1 and height."""
    h = candidate["height"] - 1          # the stale block's height (templates at h + 1 build on it)
    if entry["header"] is None:
        return None, "no_header"
    try:
        hd = parse_header(entry["header"])
    except ValueError:
        return None, "bad_header"
    if hd["block_hash"] != entry["hash"] or hd["block_hash"] != candidate["block_hash"]:
        return None, "hash_mismatch"
    target = bits_target(hd["bits"])
    if target is None or target > POW_LIMIT or int(hd["block_hash"], 16) > target:
        return None, "pow"
    if entry["height"] != h:
        return None, "height_mismatch"
    same = best.get(h, [])
    if any(b["block_hash"] == hd["block_hash"] for b in same):
        return None, "on_best_chain"
    known_bits = {b["bits"] for b in same if b.get("bits") is not None}
    if known_bits and hd["bits"] not in known_bits:
        return None, "bits_mismatch"
    if hd["prev_hash"] not in {b["block_hash"] for b in best.get(h - 1, [])}:
        return None, "prev_mismatch"
    hd["difficulty_checked"] = bool(known_bits)
    return hd, None


# --- full block --------------------------------------------------------------------------------------------------------
def _tx_end(raw: bytes, i: int) -> int:
    """Index just past the transaction starting at raw[i]."""
    start = i
    segwit = raw[i + 4] == 0 and raw[i + 5] != 0
    i += 6 if segwit else 4
    n_in, i = _varint(raw, i)
    for _ in range(n_in):
        i += 36
        n, i = _varint(raw, i)
        i += n + 4
    n_out, i = _varint(raw, i)
    for _ in range(n_out):
        i += 8
        n, i = _varint(raw, i)
        i += n
    if segwit:
        for _ in range(n_in):
            items, i = _varint(raw, i)
            for _ in range(items):
                n, i = _varint(raw, i)
                i += n
    i += 4
    if i > len(raw) or i - start < 10:
        raise ValueError("truncated transaction")
    return i


def parse_block(raw: bytes) -> Dict[str, Any]:
    """A raw block's header, transactions (raw), txids (internal order), size and weight. Every byte must belong to
    it (ValueError otherwise)."""
    if len(raw) < 81:
        raise ValueError("too short for a block")
    try:
        n_tx, i = _varint(raw, 80)
        txs, stripped = [], 0
        for _ in range(n_tx):
            end = _tx_end(raw, i)
            txs.append(raw[i:end])
            i = end
        if i != len(raw) or n_tx == 0:
            raise ValueError("bytes left over after the transactions" if n_tx else "no transactions")
        nowit = [strip_witness(t) for t in txs]
    except IndexError:
        raise ValueError("truncated block")
    base = i - sum(len(t) for t in txs) + sum(len(t) for t in nowit)   # header + count + stripped transactions
    return {"header": raw[:80], "txs": txs, "txids": [dsha256(t) for t in nowit], "coinbase": nowit[0],
            "size": len(raw), "weight": 3 * base + len(raw)}


def parse_coinbase(tx: bytes) -> Tuple[bytes, List[Tuple[int, bytes]]]:
    """A witness-stripped coinbase's scriptSig and outputs [(value_sat, scriptPubKey)]."""
    n_in, i = _varint(tx, 4)
    if n_in != 1 or tx[i:i + 36] != b"\x00" * 32 + b"\xff" * 4:
        raise ValueError("the first transaction isn't a coinbase")
    i += 36
    n, i = _varint(tx, i)
    script_sig = tx[i:i + n]
    i += n + 4
    n_out, i = _varint(tx, i)
    outs = []
    for _ in range(n_out):
        value = int.from_bytes(tx[i:i + 8], "little")
        n, i = _varint(tx, i + 8)
        outs.append((value, tx[i:i + n]))
        i += n
    return script_sig, outs


_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _base58check(payload: bytes) -> str:
    data = payload + hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    n, out = int.from_bytes(data, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\x00"))) + out


def _bech32_polymod(values: List[int]) -> int:
    gen = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for k in range(5):
            chk ^= gen[k] if (top >> k) & 1 else 0
    return chk


def _segwit_address(version: int, program: bytes, hrp: str = "bc") -> str:
    data, acc, bits = [version], 0, 0
    for b in program:
        acc, bits = acc << 8 | b, bits + 8
        while bits >= 5:
            bits -= 5
            data.append(acc >> bits & 31)
    if bits:
        data.append(acc << (5 - bits) & 31)
    const = 1 if version == 0 else 0x2BC830A3          # bech32 (BIP173) / bech32m (BIP350)
    hrp_exp = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    pm = _bech32_polymod(hrp_exp + data + [0] * 6) ^ const
    return hrp + "1" + "".join(_BECH32[d] for d in data + [pm >> 5 * (5 - k) & 31 for k in range(6)])


def script_address(spk: bytes) -> Optional[str]:
    """The mainnet address of a standard output script (P2PKH, P2SH, segwit v0..v16), as the node's RPC shows it;
    None for anything else (P2PK, multisig, OP_RETURN, ...), never a guess."""
    if len(spk) == 25 and spk[:3] == b"\x76\xa9\x14" and spk[23:] == b"\x88\xac":
        return _base58check(b"\x00" + spk[3:23])
    if len(spk) == 23 and spk[:2] == b"\xa9\x14" and spk[22] == 0x87:
        return _base58check(b"\x05" + spk[2:22])
    if 4 <= len(spk) <= 42 and (spk[0] == 0 or 0x51 <= spk[0] <= 0x60) and spk[1] == len(spk) - 2:
        version = 0 if spk[0] == 0 else spk[0] - 0x50
        if version == 0 and len(spk) - 2 not in (20, 32):
            return None
        return _segwit_address(version, spk[2:])
    return None


def full_block_fields(raw: bytes, header: bytes, merkle_root: str,
                      identify: Optional[Callable[[str, List[str]], Dict[str, Any]]]) -> Dict[str, Any]:
    """The stale_blocks full-block columns from a raw block whose header is the validated one; ValueError if the
    block doesn't check out."""
    blk = parse_block(raw)
    if blk["header"] != header:
        raise ValueError("the block's header isn't the validated header")
    if fold(blk["txids"][0], merkle_branches(blk["txids"]))[::-1].hex() != merkle_root:
        raise ValueError("the transactions don't fold to the header's merkle root")
    try:
        script_sig, outs = parse_coinbase(blk["coinbase"])
    except IndexError:
        raise ValueError("truncated coinbase")
    outputs = [{"value_sat": v, "script_pubkey": spk.hex(), "address": script_address(spk)} for v, spk in outs]
    # addresses by the value paid to them, highest first (bitcoin_utils.extract_coinbase_data's order)
    paid: Dict[str, int] = {}
    for o in outputs:
        if o["address"]:
            paid[o["address"]] = paid.get(o["address"], 0) + o["value_sat"]
    addresses = sorted((o["address"] for o in outputs if o["address"]), key=lambda a: paid[a], reverse=True)
    mining_pool: Dict[str, Any] = {}
    if identify:
        try:
            mining_pool = identify(script_sig.hex(), addresses) or {}
        except Exception as e:
            logger.error("Pool identification failed: %s", e)
    return {"full_block": True, "block_fetched_at": datetime.now(timezone.utc), "coinbase_script_sig": script_sig.hex(),
            "coinbase_outputs": outputs, "tx_count": len(blk["txs"]), "size": blk["size"], "weight": blk["weight"],
            "mining_pool": mining_pool or {"name": "Unknown", "id": "unknown"}}


# --- the import --------------------------------------------------------------------------------------------------------
def run(store: Any, dataset: Dict[str, Dict[str, Any]], blocks_dir: Optional[str] = None, dry_run: bool = False,
        from_height: Optional[int] = None, to_height: Optional[int] = None, chunk: int = CHUNK_HEIGHTS,
        identify: Optional[Callable[[str, List[str]], Dict[str, Any]]] = None,
        log: logging.Logger = logger) -> Dict[str, Any]:
    """Find candidates, validate them against the dataset and our best chain, store the valid ones (not with
    dry_run). store: a PostgresStore. Returns the summary."""
    s: Dict[str, Any] = {"dry_run": dry_run, "heights": None, "candidates_multi_pool": 0, "candidates_single_pool": 0,
                         "in_dataset_multi_pool": 0, "in_dataset_single_pool": 0, "validated": 0,
                         "difficulty_unchecked": 0, "stored": 0, "already_stored": 0, "full_blocks": 0,
                         "rejected": [], "full_block_rejected": [], "multi_pool_not_in_dataset": []}
    lo, hi = store.block_height_range()
    if lo is None:
        return s
    # templates at h build on the block at h - 1: blocks bound the heights (other chains' template heights don't)
    lo = max(lo + 1, from_height if from_height is not None else lo + 1)
    hi = min(hi + 1, to_height if to_height is not None else hi + 1)
    s["heights"] = [lo, hi]
    candidates = []
    for a in range(lo, hi + 1, chunk):
        for c in store.unknown_parent_candidates(a, min(a + chunk - 1, hi)):
            multi = c["pools"] >= 2
            s["candidates_multi_pool" if multi else "candidates_single_pool"] += 1
            if c["block_hash"] in dataset:
                s["in_dataset_multi_pool" if multi else "in_dataset_single_pool"] += 1
                candidates.append(c)
            elif multi:
                s["multi_pool_not_in_dataset"].append({"height": c["height"] - 1, "block_hash": c["block_hash"],
                                                       "pools": c["pools"]})
    best = store.best_blocks_at(sorted({c["height"] - k for c in candidates for k in (1, 2)}))
    for c in candidates:
        entry = dataset[c["block_hash"]]
        hd, reason = validate(c, entry, best)
        if reason:
            s["rejected"].append({"height": c["height"] - 1, "block_hash": c["block_hash"], "pools": c["pools"],
                                  "reason": reason})
            log.warning("Rejected %s (templates at %d, %d pools): %s", c["block_hash"], c["height"], c["pools"], reason)
            continue
        s["validated"] += 1
        s["difficulty_unchecked"] += not hd["difficulty_checked"]
        row = {"block_hash": hd["block_hash"], "height": c["height"] - 1, "prev_hash": hd["prev_hash"],
               "version": hd["version"], "block_time": datetime.fromtimestamp(hd["time"], timezone.utc),
               "bits": hd["bits"], "nonce": hd["nonce"], "merkle_root": hd["merkle_root"],
               "tip_hash": hd["block_hash"], "fork_height": c["height"] - 2, "first_seen": c["first_seen"],
               "full_block": False}
        path = pathlib.Path(blocks_dir) / f"{row['height']}-{row['block_hash']}.bin" if blocks_dir else None
        if path is not None and path.is_file():
            try:
                row.update(full_block_fields(path.read_bytes(), entry["header"], hd["merkle_root"], identify))
                s["full_blocks"] += 1
            except ValueError as e:
                s["full_block_rejected"].append({"block_hash": row["block_hash"], "reason": str(e)})
                log.warning("Full block %s rejected, storing the header only: %s", row["block_hash"], e)
        if dry_run:
            continue
        if store.insert_imported_stale_block(row):
            s["stored"] += 1
            log.info("Stored stale block %s at height %d (%d pools built on it, first at %s%s)", row["block_hash"],
                     row["height"], c["pools"], row["first_seen"], ", full block" if row["full_block"] else "")
        else:
            s["already_stored"] += 1
    return s


def _postgres_store() -> Any:
    # integrations/__init__.py connects to the configured store and to RabbitMQ at import; this needs neither, so
    # load the store module on its own.
    path = pathlib.Path(__file__).resolve().parent / "integrations" / "store.py"
    spec = importlib.util.spec_from_file_location("stale_import_store", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PostgresStore.from_env()


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(prog="python -m stale_import", description=__doc__.split("\n\n")[0])
    p.add_argument("--csv", required=True, help="stale-blocks.csv from github.com/bitcoin-data/stale-blocks")
    p.add_argument("--blocks-dir", help="its blocks/ directory (<height>-<hash>.bin), for full blocks")
    p.add_argument("--dry-run", action="store_true", help="validate and report, store nothing")
    p.add_argument("--from-height", type=int, help="lowest template height to read (default: above the first block)")
    p.add_argument("--to-height", type=int, help="highest template height to read (default: above the tip)")
    p.add_argument("--chunk", type=int, default=CHUNK_HEIGHTS, help="template heights per query")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr)
    dataset = read_dataset(args.csv)
    store = _postgres_store()
    from analytics.pool_identification import identify_pool_from_data
    pools = {p.get("id"): p for p in store.load_pools()}
    identify = (lambda script, addresses: identify_pool_from_data(pools, script, addresses)) if pools else None
    if not pools:
        logger.warning("No pool definitions in the pools table: full blocks are stored as Unknown")
    summary = run(store, dataset, args.blocks_dir, args.dry_run, args.from_height, args.to_height, args.chunk, identify)
    print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
