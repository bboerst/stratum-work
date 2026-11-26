"""Coinbase fill (#235): blocks stored before the backend recorded their merkle branches and coinbase get them from
the node. Each block is read once and everything is taken together: getblock verbosity 1 (the transaction ids give
the branches and the coinbase txid; size and weight come with it), then getrawtransaction <txid> false <block hash>
for the coinbase bytes (that one transaction from the block file: no txindex, a few hundred bytes).

Self-checks, before anything is stored (a block failing one is logged and skipped, never stored):
  - the branches must fold the coinbase txid to the block's merkle root (coinbase.coinbase_facts);
  - the witness-stripped coinbase bytes must hash to the coinbase txid.

One run, newest first in each pass, up to `max_blocks` blocks per pass:
  1. Coinbase bytes for blocks that have the txid but no coinbase_tx (blocks stored before the backend kept them).
  2. Everything for blocks without branches.
Each pass stops at the first block the node no longer has the data of (pruned): every older one is pruned too.

Pruned blocks from peers (off unless `peer_max_blocks` > 0): a pass continues past a pruned block by having the
node download it again (the gap filler's getblockfrompeer path, gap_fill.py), then reads everything from it at once
(the node may prune it again right away). Pass 2 does so only when pass 1 is caught up (it didn't stop at its
budget), because blocks the node downloads push its oldest block files out: blocks pass 1 can still read locally
would go first. Per run: at most
`peer_max_blocks` blocks, `peer_max_seconds` seconds, and it stops after `peer_max_failures` blocks in a row that no
peer delivered (bitcoind disconnects a peer that doesn't answer). The run keeps one peer list (gap_fill.py orders it:
the peer that delivered last is asked first, peers that didn't move to the back, disconnected ones are dropped). The
node's prune height is logged each such run, to watch its window of block data shrink and regrow.

Nothing is recorded as done: the next run continues. Postgres only.
"""
from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from coinbase import coinbase_facts, dsha256, strip_witness

logger = logging.getLogger("backend.coinbase_fill")


class Pruned(Exception):
    """The node no longer has the block's data."""


def _pruned(e: Exception) -> bool:
    """ "Block not available (pruned data)" (getblock) or "Block not available" (getrawtransaction with a block
    hash)."""
    msg = str(e).lower()
    return "pruned data" in msg or "block not available" in msg


class BlockCoinbaseFiller:
    """rpc(method, *args); store: blocks_missing_coinbase_tx, blocks_missing_branches, fill_block_coinbase and (with
    header_fields) fill_block_headers; fetcher: the gap filler (peers(), fetch_from_peers(height, hash, peers,
    store_step)), used only when peer_max_blocks > 0."""

    def __init__(self, rpc: Callable[..., Any], store: Any, max_blocks: int = 1000, batch: int = 200,
                 header_fields: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None, fetcher: Any = None,
                 peer_max_blocks: int = 0, peer_max_seconds: float = 1800.0, peer_max_failures: int = 3,
                 clock: Callable[[], float] = time.monotonic):
        self.rpc, self.store, self.max_blocks, self.batch = rpc, store, max_blocks, batch
        self.header_fields, self.fetcher = header_fields, fetcher
        self.peer_max_blocks, self.peer_max_seconds, self.peer_max_failures = peer_max_blocks, peer_max_seconds, peer_max_failures
        self.clock = clock

    def run(self) -> Dict[str, int]:
        self._peer: Dict[str, Any] = {"deadline": None, "peers": None, "in_a_row": 0, "stopped": ""}
        stats = {"from_peer": 0, "peer_failed": 0}
        stats.update(self._fill_coinbase_tx(stats))
        caught_up = stats["tx_missing"] < self.max_blocks or bool(stats["tx_pruned_at"])
        stats.update(self._fill_branches(stats, peers_allowed=caught_up))
        return stats

    def _from_peers(self, stats: Dict[str, int], block_hash: str, height: int) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """A pruned block from peers. (False, None): no peer fetching (off, or a per-run limit reached) - the pass
        stops; (True, None): not delivered - skip it; (True, doc): delivered and read."""
        st = self._peer
        if self.peer_max_blocks <= 0 or self.fetcher is None or st["stopped"]:
            return False, None
        if st["deadline"] is None:
            st["deadline"] = self.clock() + self.peer_max_seconds
            st["peers"] = self.fetcher.peers()
            self._log_prune_height()
        stop = self._peer_stop(stats, st["peers"], st["deadline"], st["in_a_row"])
        if stop:
            st["stopped"] = stop
            logger.info("coinbase fill: stopped fetching pruned blocks from peers: %s", stop)
            return False, None
        got: List[Optional[Dict[str, Any]]] = []
        if self.fetcher.fetch_from_peers(height, block_hash, st["peers"],   # reordered in place by the fetcher
                                         lambda: self._read_arrived(block_hash, got)):
            stats["from_peer"] += 1
            st["in_a_row"] = 0
            return True, (got[0] if got else None)
        stats["peer_failed"] += 1
        st["in_a_row"] += 1
        return True, None

    # one block's facts ---------------------------------------------------------------------------------------------
    def _coinbase_tx(self, block_hash: str, txid: str) -> str:
        """The coinbase bytes (hex, witness stripped), self-checked against the txid. Pruned / ValueError."""
        try:
            raw = self.rpc("getrawtransaction", txid, False, block_hash)
        except Exception as e:  # noqa: BLE001
            if _pruned(e):
                raise Pruned() from e
            raise
        cb = strip_witness(bytes.fromhex(raw))
        if dsha256(cb)[::-1].hex() != txid:
            raise ValueError("the witness-stripped coinbase doesn't hash to its txid")
        return cb.hex()

    def _block_doc(self, block_hash: str) -> Optional[Dict[str, Any]]:
        """Everything for one block, read from the node. Pruned if the node lacks its data; ValueError and friends
        if it fails a self-check; None for a block without a transaction list."""
        try:
            block = self.rpc("getblock", block_hash, 1)
        except Exception as e:  # noqa: BLE001
            if _pruned(e):
                raise Pruned() from e
            raise
        facts = coinbase_facts(block)
        if not facts:
            return None
        doc: Dict[str, Any] = {"block_hash": block_hash, **facts}
        doc["coinbase_tx"] = self._coinbase_tx(block_hash, facts["coinbase_txid"])
        if self.header_fields is not None:
            doc["header"] = {"block_hash": block_hash, **self.header_fields(block)}
        return doc

    # pass 1 --------------------------------------------------------------------------------------------------------
    def _fill_coinbase_tx(self, peer_stats: Dict[str, int]) -> Dict[str, int]:
        todo = self.store.blocks_missing_coinbase_tx(self.max_blocks)
        stats = {"tx_missing": len(todo), "tx_filled": 0, "tx_failed": 0, "tx_pruned_at": 0}
        docs: List[Dict[str, Any]] = []
        for block_hash, txid, height in todo:
            try:
                docs.append({"block_hash": block_hash, "coinbase_tx": self._coinbase_tx(block_hash, txid)})
            except Pruned:
                fetching, doc = self._from_peers(peer_stats, block_hash, height)
                if not fetching:
                    stats["tx_pruned_at"] = 1
                    break                      # older blocks are pruned too
                if doc:
                    docs.append(doc)
            except (ValueError, IndexError, TypeError) as e:
                stats["tx_failed"] += 1
                logger.warning("coinbase fill: coinbase of block %s fails the self-check, not stored: %s", block_hash, e)
                continue
            except Exception as e:  # noqa: BLE001
                stats["tx_failed"] += 1
                logger.warning("coinbase fill: getrawtransaction %s in %s failed (retried next run): %s", txid, block_hash, e)
                continue
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

    # pass 2 --------------------------------------------------------------------------------------------------------
    def _fill_branches(self, peer_stats: Dict[str, int], peers_allowed: bool) -> Dict[str, int]:
        todo: List[Tuple[str, int]] = self.store.blocks_missing_branches(self.max_blocks)
        stats = {"missing": len(todo), "filled": 0, "failed": 0, "pruned_at": 0}
        docs: List[Dict[str, Any]] = []
        for block_hash, height in todo:
            try:
                doc = self._block_doc(block_hash)
            except Pruned:
                fetching, doc = self._from_peers(peer_stats, block_hash, height) if peers_allowed else (False, None)
                if not fetching:
                    stats["pruned_at"] = 1
                    break                      # older blocks are pruned too
            except (ValueError, KeyError, IndexError, TypeError) as e:
                stats["failed"] += 1
                logger.warning("coinbase fill: block %s fails the self-check, not stored: %s", block_hash, e)
                continue
            except Exception as e:  # noqa: BLE001
                stats["failed"] += 1
                logger.warning("coinbase fill: reading block %s failed (retried next run): %s", block_hash, e)
                continue
            if doc:
                docs.append(doc)
            if len(docs) >= self.batch:
                stats["filled"] += self._flush(docs, stats)
                docs = []
        if docs:
            stats["filled"] += self._flush(docs, stats)
        if stats["missing"]:
            logger.info("coinbase fill: %(missing)d blocks without merkle branches, %(filled)d filled, %(failed)d failed"
                        "%(pruned)s", dict(stats, pruned=", stopped at a pruned block" if stats["pruned_at"] else ""))
        if peer_stats["from_peer"] or peer_stats["peer_failed"]:
            logger.info("coinbase fill: %(from_peer)d pruned blocks fetched from peers, %(peer_failed)d not delivered",
                        peer_stats)
        return stats

    def _peer_stop(self, stats: Dict[str, int], peers: Optional[List[int]], deadline: float, in_a_row: int) -> str:
        if not peers:
            return "no connected peer serves old blocks (NETWORK + WITNESS services)"
        if stats["from_peer"] + stats["peer_failed"] >= self.peer_max_blocks:
            return f"budget of {self.peer_max_blocks} blocks per run reached"
        if self.clock() >= deadline:
            return f"time budget of {self.peer_max_seconds:.0f}s per run reached"
        if in_a_row >= self.peer_max_failures:
            return f"{in_a_row} blocks in a row not delivered"
        return ""

    def _read_arrived(self, block_hash: str, got: List[Optional[Dict[str, Any]]]) -> str:
        """The gap filler's store_step: read the block the node just downloaded. "ok" | "pruned" | "error"."""
        try:
            got[:] = [self._block_doc(block_hash)]
            return "ok"
        except Pruned:
            return "pruned"
        except Exception as e:  # noqa: BLE001
            logger.warning("coinbase fill: block %s arrived from a peer but reading it failed: %s", block_hash, e)
            return "error"

    def _log_prune_height(self) -> None:
        try:
            info = self.rpc("getblockchaininfo")
            logger.info("coinbase fill: fetching pruned blocks from peers; node prune height %s, tip %s",
                        info.get("pruneheight"), info.get("blocks"))
        except Exception as e:  # noqa: BLE001
            logger.warning("coinbase fill: getblockchaininfo failed: %s", e)

    def _flush(self, docs: List[Dict[str, Any]], stats: Dict[str, int], failed: str = "failed") -> int:
        headers = [d.pop("header") for d in docs if "header" in d]
        try:
            self.store.fill_block_coinbase(docs)
            if headers:
                self.store.fill_block_headers(headers)
            return len(docs)
        except Exception as e:  # noqa: BLE001
            stats[failed] += len(docs)
            logger.warning("coinbase fill: storing %d blocks failed (retried next run): %s", len(docs), e)
            return 0
