"""Coinbase fill (#235): blocks stored before the backend recorded their merkle branches and coinbase get them from
the node, in two passes per run, each newest first and up to `max_blocks` blocks:

1. Branches and coinbase txid, for blocks without branches: getblock verbosity 1 (the transaction ids, enough for
   both). Self-checked by coinbase.coinbase_facts: the branches must fold the coinbase txid to the block's merkle root.
2. Coinbase bytes, for blocks with a coinbase txid but no coinbase_tx (pass 1's blocks, and blocks stored before the
   backend kept them): getrawtransaction <txid> false <block hash>, which reads that one transaction from the block
   file (no txindex needed, a few hundred bytes instead of the whole block). Self-checked: the witness-stripped bytes
   must hash to the stored txid.

A block that fails a check is skipped and logged, never stored. Each pass stops at the first block the node no longer
has the data of (pruned): every older one is pruned too. The next run continues; nothing is recorded as done.
Postgres only.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List

from coinbase import coinbase_facts, dsha256, strip_witness

logger = logging.getLogger("backend.coinbase_fill")


def _pruned(e: Exception) -> bool:
    """The node no longer has the block's data: "Block not available (pruned data)" (getblock) or "Block not
    available" (getrawtransaction with a block hash)."""
    msg = str(e).lower()
    return "pruned data" in msg or "block not available" in msg


class BlockCoinbaseFiller:
    def __init__(self, rpc: Callable[..., Any], store: Any, max_blocks: int = 1000, batch: int = 200):
        self.rpc, self.store, self.max_blocks, self.batch = rpc, store, max_blocks, batch

    def run(self) -> Dict[str, int]:
        hashes = self.store.blocks_missing_branches(self.max_blocks)
        stats = {"missing": len(hashes), "filled": 0, "failed": 0, "pruned_at": 0}
        docs: List[Dict[str, Any]] = []
        for h in hashes:
            try:
                block = self.rpc("getblock", h, 1)
            except Exception as e:  # noqa: BLE001
                if _pruned(e):
                    stats["pruned_at"] = 1
                    break                      # older blocks are pruned too
                stats["failed"] += 1
                logger.warning("coinbase fill: getblock %s failed (retried next run): %s", h, e)
                continue
            try:
                facts = coinbase_facts(block)
            except (ValueError, KeyError, IndexError) as e:
                stats["failed"] += 1
                logger.warning("coinbase fill: block %s fails the self-check, not stored: %s", h, e)
                continue
            if facts:
                docs.append({"block_hash": h, **facts})
            if len(docs) >= self.batch:
                stats["filled"] += self._flush(docs, stats)
                docs = []
        if docs:
            stats["filled"] += self._flush(docs, stats)
        if stats["missing"]:
            logger.info("coinbase fill: %(missing)d blocks without merkle branches, %(filled)d filled, %(failed)d failed"
                        "%(pruned)s", dict(stats, pruned=", stopped at a pruned block" if stats["pruned_at"] else ""))
        stats.update(self._fill_coinbase_tx())
        return stats

    def _fill_coinbase_tx(self) -> Dict[str, int]:
        """Pass 2: the coinbase bytes of blocks that have a coinbase txid but no coinbase_tx."""
        todo = self.store.blocks_missing_coinbase_tx(self.max_blocks)
        stats = {"tx_missing": len(todo), "tx_filled": 0, "tx_failed": 0, "tx_pruned_at": 0}
        docs: List[Dict[str, Any]] = []
        for block_hash, txid in todo:
            try:
                raw = self.rpc("getrawtransaction", txid, False, block_hash)
            except Exception as e:  # noqa: BLE001
                if _pruned(e):
                    stats["tx_pruned_at"] = 1
                    break                      # older blocks are pruned too
                stats["tx_failed"] += 1
                logger.warning("coinbase fill: getrawtransaction %s in %s failed (retried next run): %s", txid, block_hash, e)
                continue
            try:
                cb = strip_witness(bytes.fromhex(raw))
                if dsha256(cb)[::-1].hex() != txid:
                    raise ValueError("the witness-stripped coinbase doesn't hash to the stored txid")
            except (ValueError, IndexError, TypeError) as e:
                stats["tx_failed"] += 1
                logger.warning("coinbase fill: coinbase of block %s fails the self-check, not stored: %s", block_hash, e)
                continue
            docs.append({"block_hash": block_hash, "coinbase_tx": cb.hex()})
            if len(docs) >= self.batch:
                stats["tx_filled"] += self._flush(docs, stats, "tx_failed")
                docs = []
        if docs:
            stats["tx_filled"] += self._flush(docs, stats, "tx_failed")
        if stats["tx_missing"]:
            logger.info("coinbase fill: %(tx_missing)d blocks without coinbase bytes, %(tx_filled)d filled, "
                        "%(tx_failed)d failed%(pruned)s",
                        dict(stats, pruned=", stopped at a pruned block" if stats["tx_pruned_at"] else ""))
        return stats

    def _flush(self, docs: List[Dict[str, Any]], stats: Dict[str, int], failed: str = "failed") -> int:
        try:
            self.store.fill_block_coinbase(docs)
            return len(docs)
        except Exception as e:  # noqa: BLE001
            stats[failed] += len(docs)
            logger.warning("coinbase fill: storing %d blocks failed (retried next run): %s", len(docs), e)
            return 0
