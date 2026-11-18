"""Header fill: blocks stored before the backend recorded the header columns (tx_count, version, merkle_root, bits,
nonce, difficulty; size and weight) get them from the node.

New blocks carry them from the getblock the backend already makes (block_header_fields below). Blocks stored earlier
(the startup sync, the history backfill) have NULLs. One run takes up to `max_blocks` of them, newest first, asks the
node for each block's header (getblockheader: works on a pruned node too, but has no size or weight, so those stay
NULL for blocks whose data the node no longer has) and fills only the columns that are still NULL, in batches.
Anything that fails is logged and skipped; the next run tries again.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List

logger = logging.getLogger("backend.header_fill")


def block_header_fields(block: Dict[str, Any]) -> Dict[str, Any]:
    """The block's header facts as the node reports them (getblock / getblockheader), in the block document's field
    names (stored in blocks' header columns). Keys the node didn't report are left out. getblockheader has no size or
    weight.

    The RPC client returns JSON numbers with a fraction as Decimal: difficulty is stored as a float, the type of the
    column (double precision)."""
    difficulty = block.get("difficulty")
    out = {"transactions": block.get("nTx"), "size": block.get("size"), "weight": block.get("weight"),
           "version": block.get("version"), "merkle_root": block.get("merkleroot"), "bits": block.get("bits"),
           "nonce": block.get("nonce"), "difficulty": float(difficulty) if difficulty is not None else None}
    return {k: v for k, v in out.items() if v is not None}


class BlockHeaderFiller:
    def __init__(self, rpc: Callable[..., Any], store: Any, header_fields: Callable[[Dict[str, Any]], Dict[str, Any]],
                 max_blocks: int = 20_000, batch: int = 500):
        self.rpc, self.store, self.header_fields = rpc, store, header_fields
        self.max_blocks, self.batch = max_blocks, batch

    def run(self) -> Dict[str, int]:
        hashes = self.store.blocks_missing_header(self.max_blocks)
        stats = {"missing": len(hashes), "filled": 0, "failed": 0}
        if not hashes:
            return stats
        docs: List[Dict[str, Any]] = []
        for h in hashes:
            try:
                header = self.rpc("getblockheader", h)
            except Exception as e:  # noqa: BLE001 - logged and retried next run
                stats["failed"] += 1
                logger.warning("header fill: getblockheader %s failed (retried next run): %s", h, e)
                continue
            docs.append({"block_hash": h, **self.header_fields(header)})
            if len(docs) >= self.batch:
                stats["filled"] += self._flush(docs, stats)
                docs = []
        if docs:
            stats["filled"] += self._flush(docs, stats)
        logger.info("header fill: %(missing)d blocks without header columns, %(filled)d filled, %(failed)d failed", stats)
        return stats

    def _flush(self, docs: List[Dict[str, Any]], stats: Dict[str, int]) -> int:
        try:
            self.store.fill_block_headers(docs)
            return len(docs)
        except Exception as e:  # noqa: BLE001
            stats["failed"] += len(docs)
            logger.warning("header fill: storing %d headers failed (retried next run): %s", len(docs), e)
            return 0
