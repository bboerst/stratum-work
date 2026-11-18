"""Best-chain reconciliation (#212): the stored best block at each recent height equals the node's active chain.

ZMQ `hashblock` announces only the new tip, and sync only fills heights that have no block at all. So after a reorg
the block our node accepted first (and later disconnected) used to stay "the block at height h", in MongoDB mode for
good. The reconciler doesn't depend on seeing the reorg happen. For every height in a window below the node's tip it
compares the node's block hash (getblockhash) with the stored best block(s) at that height:

  * no stored best block          -> fetch and store the node's block (a gap: e.g. the database was down)
  * stored best block != node's   -> store the node's block, then mark the stored one as no longer best

The window ends at the lower of the node's tip and the highest stored best block. Heights above the stored tip are
the sync's and ZMQ's job (running both on the same height would only duplicate work). Heights above the node's tip are
left alone: the node may just be behind (restarting, catching up), and once it passes them they are checked too.

"Store" means: the block is known already (a block that was replaced earlier and is active again) -> mark it best
again; otherwise store_block(hash), which fetches it and saves it as seen now (seen_at = detection time, not NULL).
"Mark as no longer best" is mode specific (mark_replaced): Postgres records a stale_blocks row (was_active) through the
stale-block tracker's own code, which hides it from blocks_best; MongoDB sets `stale: true` on the document, which
every best-chain read filters out.

Every height is checked, not just a walk back from the tip until the first match: the common reorg leaves the new tip
stored (ZMQ announces it) above a replaced block, so a match at the tip says nothing about the heights below it.
The cost is one database read plus one getblockhash per height (on one RPC connection) per run.

A failure at one height (RPC, database) is logged and the other heights continue; nothing is marked as done, so the
next run (next block, next sync, next poll) retries it.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("backend.reconcile")


class BestChainReconciler:
    """node_height() -> the node's block count; node_hashes(heights) -> {height: hash} (a height left out = failed);
    store: best_block_hashes_between, highest_block_height, known_block_hashes, mark_block_best;
    store_block(hash) -> bool (fetch, save as seen now); mark_replaced(hashes) marks stored blocks as not best."""

    def __init__(self, node_height: Callable[[], int], node_hashes: Callable[[List[int]], Dict[int, str]],
                 store: Any, store_block: Callable[[str], bool], mark_replaced: Callable[[List[str]], Any],
                 window: int, min_height: int, log: logging.Logger = logger):
        self.node_height, self.node_hashes, self.store = node_height, node_hashes, store
        self.store_block, self.mark_replaced = store_block, mark_replaced
        self.window, self.min_height, self.log = window, min_height, log

    def reconcile(self, low_height: Optional[int] = None) -> Dict[str, int]:
        """Check [low, min(node tip, stored tip)]. low = the window's (BLOCK_GAP_WINDOW heights below that; 0 turns
        the window off), or low_height when given (a reorg's fork point + 1 reported by the stale-block tracker),
        never below min_height."""
        stats = {"checked": 0, "stored": 0, "reactivated": 0, "replaced": 0, "failed": 0}
        if not getattr(self.store, "enabled", False):
            return stats
        if low_height is None and self.window <= 0:
            return stats
        stored_tip = self.store.highest_block_height()
        if stored_tip is None:
            return stats   # nothing stored yet: the initial sync's job
        top = min(int(self.node_height()), int(stored_tip))
        low = max(self.min_height, top - self.window + 1 if low_height is None else low_height)
        if low > top:
            return stats
        stored = self.store.best_block_hashes_between(low, top)
        heights = list(range(top, low - 1, -1))
        stats = self.reconcile_heights(heights, stored, self.node_hashes(heights))
        if stats["stored"] or stats["reactivated"] or stats["replaced"] or stats["failed"]:
            self.log.info("Best chain reconciled %d..%d: %s", low, top, stats)
        return stats

    def reconcile_heights(self, heights: List[int], stored: Dict[int, List[str]], node: Dict[int, str],
                          store_block: Optional[Callable[[str], bool]] = None,
                          replace_only_when_best: bool = False) -> Dict[str, int]:
        """Make the stored best block at each of `heights` the node's. stored: {height: [stored best hashes]};
        node: {height: the node's hash} (a height left out = failed). store_block: instead of self.store_block.
        replace_only_when_best: mark a stored block replaced only once the node's block at its height is stored (or
        already was). Without it (the window) a stored block is marked even when storing the node's block failed: the
        height then has no best block until the next run stores the node's as missing."""
        store_block = store_block or self.store_block
        stats = {"checked": 0, "stored": 0, "reactivated": 0, "replaced": 0, "failed": 0}
        replaced: List[str] = []
        for h in heights:
            want = node.get(h)
            if want is None:
                stats["failed"] += 1
                continue
            stats["checked"] += 1
            have = stored.get(h, [])
            losers = [x for x in have if x != want]
            if want in have or not replace_only_when_best:
                replaced.extend(losers)
            if want in have:
                continue
            try:
                if self.store.known_block_hashes([want]):
                    self.store.mark_block_best(want)
                    stats["reactivated"] += 1
                    self.log.info("Best chain: block %d (%s) is the node's again", h, want)
                elif store_block(want):
                    stats["stored"] += 1
                    self.log.info("Best chain: stored block %d (%s)%s", h, want,
                                  f", replacing {', '.join(losers)}" if have else " (was missing)")
                else:
                    stats["failed"] += 1
                    continue
            except Exception as e:
                stats["failed"] += 1
                self.log.error("Best chain: storing block %d (%s) failed (retried next time): %s", h, want, e)
                continue
            if replace_only_when_best:
                replaced.extend(losers)
        if replaced:
            try:
                self.mark_replaced(replaced)
                stats["replaced"] = len(replaced)
                self.log.info("Best chain: %d stored block(s) no longer on the node's chain: %s", len(replaced), replaced)
            except Exception as e:
                stats["failed"] += 1
                self.log.error("Best chain: marking %s as replaced failed (retried next time): %s", replaced, e)
        return stats
