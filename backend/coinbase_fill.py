"""Coinbase fill (#235): blocks stored before the backend recorded their merkle branches and coinbase txid get them
from the node (getblock verbosity 1: the transaction ids, enough for both; the coinbase bytes need the full
transactions, so older blocks don't get coinbase_tx).

One run: up to `max_blocks` blocks without branches, newest first. Each is self-checked (coinbase.coinbase_facts:
the branches must fold the coinbase txid to the block's merkle root) and stored in batches; a block that fails the
check is skipped and logged. The run stops at the first block the node no longer has the data of (pruned): every
older one is pruned too. The next run continues; nothing is recorded as done. Postgres only.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List

from coinbase import coinbase_facts

logger = logging.getLogger("backend.coinbase_fill")


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
                if "pruned data" in str(e).lower():
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
        return stats

    def _flush(self, docs: List[Dict[str, Any]], stats: Dict[str, int]) -> int:
        try:
            self.store.fill_block_coinbase(docs)
            return len(docs)
        except Exception as e:  # noqa: BLE001
            stats["failed"] += len(docs)
            logger.warning("coinbase fill: storing %d blocks failed (retried next run): %s", len(docs), e)
            return 0
