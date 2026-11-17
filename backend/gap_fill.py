"""Historical gap fill: store every missing block between MIN_BLOCK_HEIGHT and the stored tip, also on a pruned node.

The startup sync extends the stored range at both ends and the best-chain reconciler (reconcile.py) covers the recent
BLOCK_GAP_WINDOW heights. A block missing deeper than that (the database was unreachable for a while, a failed fetch
during the initial sync) stayed missing. On a node that still has the block, storing it is a plain getblock. A pruned
node answers "Block not available (pruned data)": then the node is asked to download it again from a peer
(`getblockfrompeer <hash> <peer_id>`, Bitcoin Core 23+), and once it has it, getblock works (until the node prunes it
again, which doesn't matter: it is needed once).

One run:
  1. One store read for the stored tip and one indexed read of the stored heights in [min_height, tip]. No gaps: done,
     with no RPC at all.
  2. The missing heights, newest first, at most `max_blocks` of them. For each: getblockhash, then store it (on the
     block processor, so it never races a new block). Stored, or a block known already and marked best again: done.
  3. Pruned: getpeerinfo once per run; candidates are peers that advertise NETWORK (full block history), outbound ones
     first (peers this node chose). NETWORK_LIMITED-only peers serve just the last 288 blocks, which a pruned node
     keeps anyway. Up to `max_peers` of them: getblockfrompeer, then poll getblock (verbosity 1, a few hundred kB on
     mainnet) every `poll_interval` seconds for up to `peer_timeout` seconds, outside the block processor, so a slow
     peer never delays a new block. Once the node has it, store it on the block processor.
  4. Anything that fails is logged and skipped. Nothing is recorded as done, so the next run tries again.

A historical block is stored as synced, not seen live (Postgres: seen_at NULL), like the startup backfill.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("backend.gap_fill")

# NETWORK (1 << 0): serves the full block history. NETWORK_LIMITED (1 << 10): only the last 288 blocks.
NODE_NETWORK = 1


def is_pruned_error(exc: BaseException) -> bool:
    return "pruned data" in str(exc).lower()


def full_history_peers(peers: List[Dict[str, Any]]) -> List[int]:
    """Peer ids that serve old blocks (NETWORK service bit), outbound first, then by id."""
    def full(p: Dict[str, Any]) -> bool:
        names = p.get("servicesnames")
        if names is not None:
            return "NETWORK" in names
        try:
            return bool(int(str(p.get("services", "0")), 16) & NODE_NETWORK)
        except ValueError:
            return False
    usable = [p for p in peers if isinstance(p.get("id"), int) and full(p)]
    usable.sort(key=lambda p: (bool(p.get("inbound")), p["id"]))
    return [p["id"] for p in usable]


class HistoricalGapFiller:
    """rpc(method, *args) -> one node RPC (raises on error); store: enabled, highest_block_height,
    block_heights_between(low, high_exclusive), has_block_at_height, known_block_hashes, mark_block_best;
    store_block(hash) -> "ok" | "pruned" | "error" (fetch with getblock, analyse, save as synced);
    on_block_processor(fn) -> fn's result, run on the block processor (serialised with new blocks)."""

    def __init__(self, rpc: Callable[..., Any], store: Any, store_block: Callable[[str], str],
                 on_block_processor: Callable[[Callable[[], Any]], Any], min_height: int,
                 max_blocks: int = 50, max_peers: int = 3, peer_timeout: float = 30.0, poll_interval: float = 1.0,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic,
                 log: logging.Logger = logger):
        self.rpc, self.store, self.store_block, self.on_block_processor = rpc, store, store_block, on_block_processor
        self.min_height, self.max_blocks, self.max_peers = min_height, max_blocks, max_peers
        self.peer_timeout, self.poll_interval = peer_timeout, poll_interval
        self.sleep, self.clock, self.log = sleep, clock, log

    def missing_heights(self) -> List[int]:
        """Missing heights in [min_height, stored tip], newest first. Two store reads, no RPC."""
        tip = self.store.highest_block_height()
        if tip is None or tip < self.min_height:
            return []
        have = self.store.block_heights_between(self.min_height, tip + 1)
        return [h for h in range(tip, self.min_height - 1, -1) if h not in have]

    def run(self) -> Dict[str, int]:
        stats = {"missing": 0, "attempted": 0, "stored": 0, "from_peer": 0, "no_peer": 0, "failed": 0}
        if not getattr(self.store, "enabled", False):
            return stats
        missing = self.missing_heights()
        stats["missing"] = len(missing)
        if not missing:
            return stats
        todo = missing[: self.max_blocks] if self.max_blocks > 0 else missing
        self.log.info("Gap fill: %d block(s) missing between %d and the stored tip; trying %d this run (%s)",
                      len(missing), self.min_height, len(todo), _ranges(todo))
        peers: Optional[List[int]] = None   # getpeerinfo once per run, only if a block is pruned
        for height in todo:
            stats["attempted"] += 1
            try:
                block_hash = self.rpc("getblockhash", height)
            except Exception as e:
                stats["failed"] += 1
                self.log.error("Gap fill: getblockhash(%d) failed (retried next run): %s", height, e)
                continue
            result = self.on_block_processor(lambda: self._store(height, block_hash))
            if result == "ok":
                stats["stored"] += 1
                continue
            if result != "pruned":
                stats["failed"] += 1
                continue
            if peers is None:
                peers = self._peers()
            if not peers:
                stats["no_peer"] += 1
                self.log.warning("Gap fill: block %d (%s) is pruned and no connected peer serves old blocks "
                                 "(NETWORK service); retried next run", height, block_hash)
                continue
            if self._fetch_from_peers(height, block_hash, peers):
                stats["stored"] += 1
                stats["from_peer"] += 1
            else:
                stats["failed"] += 1
        self.log.info("Gap fill done: %s", stats)
        return stats

    def _store(self, height: int, block_hash: str) -> str:
        """On the block processor. A block stored meanwhile (the reconciler, the sync) counts as done."""
        try:
            if self.store.has_block_at_height(height):
                return "ok"
            if self.store.known_block_hashes([block_hash]):
                self.store.mark_block_best(block_hash)   # stored earlier, marked as replaced, active again
                self.log.info("Gap fill: block %d (%s) is the node's again", height, block_hash)
                return "ok"
        except Exception as e:
            self.log.error("Gap fill: store check for block %d failed (retried next run): %s", height, e)
            return "error"
        result = self.store_block(block_hash)
        if result == "ok":
            self.log.info("Gap fill: stored block %d (%s)", height, block_hash)
        return result

    def _peers(self) -> List[int]:
        try:
            return full_history_peers(self.rpc("getpeerinfo") or [])
        except Exception as e:
            self.log.error("Gap fill: getpeerinfo failed: %s", e)
            return []

    def _fetch_from_peers(self, height: int, block_hash: str, peers: List[int]) -> bool:
        for peer in peers[: max(1, self.max_peers)]:
            try:
                self.rpc("getblockfrompeer", block_hash, peer)
            except Exception as e:
                if "already downloaded" not in str(e).lower():
                    self.log.warning("Gap fill: getblockfrompeer(%d, peer %d) failed: %s", height, peer, e)
                    continue
            if not self._wait_for_block(block_hash):
                self.log.warning("Gap fill: peer %d didn't deliver block %d within %.0fs", peer, height, self.peer_timeout)
                continue
            result = self.on_block_processor(lambda: self._store(height, block_hash))
            if result == "ok":
                self.log.info("Gap fill: block %d (%s) fetched from peer %d", height, block_hash, peer)
                return True
            self.log.warning("Gap fill: block %d arrived from peer %d but storing it failed (%s)", height, peer, result)
            if result != "pruned":
                return False   # not a fetch problem: another peer won't help
        self.log.warning("Gap fill: block %d (%s) not fetched from any of %d peer(s); retried next run",
                         height, block_hash, min(len(peers), max(1, self.max_peers)))
        return False

    def _wait_for_block(self, block_hash: str) -> bool:
        """getblockfrompeer only queues the request: poll until the node has the block data."""
        deadline = self.clock() + self.peer_timeout
        while True:
            try:
                self.rpc("getblock", block_hash, 1)
                return True
            except Exception as e:
                if not is_pruned_error(e):
                    self.log.warning("Gap fill: getblock(%s) while waiting: %s", block_hash, e)
            if self.clock() >= deadline:
                return False
            self.sleep(self.poll_interval)


def _ranges(heights: List[int], limit: int = 10) -> str:
    """'905120-905144, 904990' for a newest-first height list (at most `limit` ranges)."""
    out: List[str] = []
    for h in sorted(heights):
        if out and out[-1][1] == h - 1:
            out[-1][1] = h
        else:
            out.append([h, h])
    text = ", ".join(f"{a}-{b}" if a != b else str(a) for a, b in out[:limit])
    return text + (f", ... ({len(out)} ranges)" if len(out) > limit else "")
