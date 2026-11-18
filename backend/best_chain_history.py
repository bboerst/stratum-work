"""Full-history best-chain check: the stored best block at every height from MIN_BLOCK_HEIGHT to the stored tip equals
the node's active chain.

The best-chain reconciler (reconcile.py) only checks the last BLOCK_GAP_WINDOW heights, or a reorg's fork point. A
wrong best block deeper than that stays wrong: e.g. a history backfill that stored a stale block as the block at its
height (it won the race on the node that stored it, then lost) while the block that won isn't stored at all. This
check covers every height, once after the startup sync and then every BEST_CHAIN_HISTORY_INTERVAL_S seconds.

One run, in chunks of `chunk` heights from min_height up to min(node tip, stored tip):
  1. Outside the block processor: the stored best hashes (one indexed read) and the node's hashes (getblockhash per
     height on one connection). A height whose stored best blocks are anything other than exactly the node's block
     is a mismatch. A height with no stored block is left to the gap filler (gap_fill.py), which rate-limits fetches.
  2. On the block processor, only for a chunk's mismatched heights: re-read both sides for those heights (a new block
     or reorg may have changed them since step 1), store the node's block, and only then mark the stored one
     replaced (BestChainReconciler.reconcile_heights with replace_only_when_best). Then read the heights again and
     count a height fixed only if its one best block is the node's.
  3. A node's block the node has pruned: outside the block processor, the gap filler's getblockfrompeer path fetches
     it, then step 2 runs again for that height.

A block stored here was not seen live: it is stored like the sync and the gap fill store blocks (seen_at and seen_via
NULL), never with the detection time, which would pass for an arrival time.

Postgres records a replaced block in stale_blocks through the stale-block tracker's record_replaced (blocks_best then
hides it), which needs the block's header from the node (getblockheader). A node that never saw the stale block
has no header for it; then nothing is recorded, the stale block stays best next to the node's block, the height
counts as failed (logged), and the next run tries again. Nothing is recorded as done: every run checks every height.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Dict, List

logger = logging.getLogger("backend.best_chain_history")


def _mismatched(heights: List[int], stored: Dict[int, List[str]], node: Dict[int, str]) -> List[int]:
    return [h for h in heights if h in node and stored.get(h) and sorted(stored[h]) != [node[h]]]


class BestChainHistoryCheck:
    """reconciler: BestChainReconciler (its reconcile_heights and store); node_height() -> block count;
    node_hashes(heights) -> {height: hash}; store_block(hash) -> "ok" | "pruned" | "error" (fetch, save as synced);
    on_block_processor(fn) -> fn's result, run on the block processor; fetcher: the HistoricalGapFiller (peers(),
    fetch_from_peers(height, hash, peers, store_step))."""

    def __init__(self, reconciler: Any, node_height: Callable[[], int], node_hashes: Callable[[List[int]], Dict[int, str]],
                 store_block: Callable[[str], str], on_block_processor: Callable[[Callable[[], Any]], Any],
                 fetcher: Any, min_height: int, chunk: int = 2000, clock: Callable[[], float] = time.monotonic,
                 log: logging.Logger = logger):
        self.reconciler, self.store = reconciler, reconciler.store
        self.node_height, self.node_hashes, self.store_block = node_height, node_hashes, store_block
        self.on_block_processor, self.fetcher = on_block_processor, fetcher
        self.min_height, self.chunk, self.clock, self.log = min_height, max(1, chunk), clock, log

    def chunks(self, top: int) -> List[List[int]]:
        """[min_height, top] in chunks of `chunk` heights, oldest chunk first; each chunk newest first."""
        return [list(range(min(low + self.chunk - 1, top), low - 1, -1))
                for low in range(self.min_height, top + 1, self.chunk)]

    def run(self) -> Dict[str, Any]:
        stats: Dict[str, Any] = {"checked": 0, "mismatched": 0, "stored": 0, "reactivated": 0, "replaced": 0,
                                 "from_peer": 0, "failed": 0}
        if not getattr(self.store, "enabled", False):
            return stats
        start = self.clock()
        stored_tip = self.store.highest_block_height()
        if stored_tip is None:
            return stats
        top = min(int(self.node_height()), int(stored_tip))
        peers = None   # getpeerinfo once per run, only if a block is pruned
        for heights in self.chunks(top):
            try:
                stored = self.store.best_block_hashes_between(heights[-1], heights[0])
                node = self.node_hashes(heights)
            except Exception as e:
                stats["failed"] += len(heights)
                self.log.error("Best-chain history: reading %d..%d failed (retried next run): %s", heights[-1], heights[0], e)
                continue
            stats["failed"] += len(heights) - len(node)
            stats["checked"] += len(node)
            bad = _mismatched(heights, stored, node)
            if not bad:
                continue
            stats["mismatched"] += len(bad)
            self.log.info("Best-chain history: %d height(s) whose stored best block isn't the node's: %s",
                          len(bad), ", ".join(f"{h} ({','.join(stored[h])} != {node[h]})" for h in bad))
            outcome = self._fix(bad, stats)
            for h in bad:
                if outcome.get(h) == "error":
                    stats["failed"] += 1
                elif outcome.get(h) == "pruned":
                    if peers is None:
                        peers = self.fetcher.peers()
                    if not peers:
                        stats["failed"] += 1
                        self.log.warning("Best-chain history: block %d (%s) is pruned and no connected peer serves "
                                         "old blocks; retried next run", h, node[h])
                    elif self.fetcher.fetch_from_peers(h, node[h], peers,
                                                       store_step=lambda h=h: self._fix([h], stats).get(h, "error")):
                        stats["from_peer"] += 1
                    else:
                        stats["failed"] += 1
        stats["duration_s"] = round(self.clock() - start, 1)
        self.log.info("Best-chain history check %d..%d: %s", self.min_height, top, stats)
        return stats

    def _fix(self, heights: List[int], stats: Dict[str, Any]) -> Dict[int, str]:
        """Fix these heights on the block processor. {height: "ok" | "pruned" | "error"}; stats gets the counts."""
        try:
            return self.on_block_processor(lambda: self._fix_on_processor(heights, stats))
        except Exception as e:
            self.log.error("Best-chain history: fixing %s failed (retried next run): %s", heights, e)
            return {h: "error" for h in heights}

    def _fix_on_processor(self, heights: List[int], stats: Dict[str, Any]) -> Dict[int, str]:
        low, high = min(heights), max(heights)
        stored = self.store.best_block_hashes_between(low, high)
        node = self.node_hashes(heights)
        bad = _mismatched(heights, stored, node)
        status: Dict[str, str] = {}

        def store_block(block_hash: str) -> bool:
            status[block_hash] = self.store_block(block_hash)
            return status[block_hash] == "ok"

        result = self.reconciler.reconcile_heights(bad, stored, node, store_block=store_block,
                                                   replace_only_when_best=True)
        stats["stored"] += result["stored"]
        stats["reactivated"] += result["reactivated"]
        after = self.store.best_block_hashes_between(low, high) if bad else stored
        outcome: Dict[int, str] = {}
        for h in heights:
            want = node.get(h)
            if want is None:
                outcome[h] = "error"
            elif after.get(h) == [want] or h not in bad:
                outcome[h] = "ok"   # fixed, or nothing to fix any more (a new block, or empty: the gap filler's)
            elif status.get(want) == "pruned":
                outcome[h] = "pruned"
            else:
                outcome[h] = "error"
                if want in after.get(h, []):
                    self.log.warning("Best-chain history: block %d (%s) stored, but %s still best (not recorded as "
                                     "replaced, e.g. the node has no header for it); retried next run", h, want,
                                     [x for x in after[h] if x != want])
            if h in bad:
                stats["replaced"] += sum(1 for x in stored.get(h, []) if x != want and x not in after.get(h, []))
        return outcome
