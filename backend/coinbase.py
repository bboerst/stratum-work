"""A block's coinbase and merkle branches, as facts that link it to the Stratum job it was built from (#235).

A Stratum job (mining.notify) carries `merkle_branches`: the siblings on the coinbase's path to the merkle root, in
internal byte order (the bytes as hashed). The block has the same branches, computable from its transaction ids. So:
- the block's branches equal a template's exactly <=> the template carried exactly the block's transaction set;
- the first k branches equal <=> the first 2^k - 1 transactions after the coinbase are identical, in order
  (branch 0 is the first transaction's txid, branch k hashes the next 2^k transactions).
The branches don't depend on the coinbase, so they can be computed from the txids alone (getblock verbosity 1).

Everything is self-checked before it is stored: the witness-stripped coinbase must hash to the node's txid, and folding
the coinbase txid through the branches must give the node's merkle root. A block that fails either check stores none
of these facts (logged), never unverified ones.
"""
from __future__ import annotations

import hashlib
from typing import Dict, List, Optional, Sequence, Tuple


def dsha256(b: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(b).digest()).digest()


def _varint(b: bytes, i: int) -> Tuple[int, int]:
    x = b[i]
    if x < 0xFD:
        return x, i + 1
    if x == 0xFD:
        return int.from_bytes(b[i + 1:i + 3], "little"), i + 3
    if x == 0xFE:
        return int.from_bytes(b[i + 1:i + 5], "little"), i + 5
    return int.from_bytes(b[i + 1:i + 9], "little"), i + 9


def strip_witness(raw: bytes) -> bytes:
    """The non-witness serialization of a transaction (the bytes its txid hashes; what Stratum's coinbase1 + extranonce
    + coinbase2 make up). A transaction without the segwit marker is returned unchanged."""
    if len(raw) < 6 or raw[4:6] != b"\x00\x01":
        return raw
    i = 6
    n_in, i = _varint(raw, i)
    for _ in range(n_in):
        i += 36                       # prevout
        l, i = _varint(raw, i)
        i += l + 4                    # scriptSig, sequence
    n_out, i = _varint(raw, i)
    for _ in range(n_out):
        i += 8                        # value
        l, i = _varint(raw, i)
        i += l                        # scriptPubKey
    io_end = i
    for _ in range(n_in):             # witness stacks
        items, i = _varint(raw, i)
        for _ in range(items):
            l, i = _varint(raw, i)
            i += l
    if i + 4 != len(raw):
        raise ValueError("unexpected transaction layout")
    return raw[:4] + raw[6:io_end] + raw[i:i + 4]


def merkle_branches(txids: Sequence[bytes]) -> List[bytes]:
    """The coinbase's merkle path (siblings, Stratum order) for a block with these txids (internal byte order,
    coinbase first). Odd levels duplicate their last node, as Bitcoin does."""
    level = list(txids)
    out: List[bytes] = []
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        out.append(level[1])
        level = [dsha256(level[i] + level[i + 1]) for i in range(0, len(level), 2)]
    return out


def fold(coinbase_txid: bytes, branches: Sequence[bytes]) -> bytes:
    acc = coinbase_txid
    for b in branches:
        acc = dsha256(acc + b)
    return acc


def coinbase_facts(block: Dict) -> Optional[Dict[str, str]]:
    """From a getblock result (verbosity 1: txids; verbosity 2: full transactions), the block document's fields:
    `merkle_branches` (hex, internal byte order, concatenated), `coinbase_txid` (hex, display order as RPC shows it)
    and, with verbosity 2, `coinbase_tx` (hex, witness stripped). None without a transaction list; ValueError if
    the node's data doesn't check out (callers store nothing then)."""
    txs = block.get("tx") or []
    if not txs or "merkleroot" not in block:
        return None
    txids_display = [t["txid"] if isinstance(t, dict) else t for t in txs]
    txids = [bytes.fromhex(t)[::-1] for t in txids_display]
    branches = merkle_branches(txids)
    if fold(txids[0], branches)[::-1].hex() != block["merkleroot"]:
        raise ValueError("merkle branches don't reproduce the block's merkle root")
    out = {"merkle_branches": b"".join(branches).hex(), "coinbase_txid": txids_display[0]}
    first = txs[0]
    if isinstance(first, dict) and first.get("hex"):
        cb = strip_witness(bytes.fromhex(first["hex"]))
        if dsha256(cb)[::-1].hex() != txids_display[0]:
            raise ValueError("the witness-stripped coinbase doesn't hash to its txid")
        out["coinbase_tx"] = cb.hex()
    return out
