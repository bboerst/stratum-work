"""Stale (orphaned) blocks the node knows about (#180, slice 3).

On every new block (ZMQ) and on a timer, StaleBlockTracker.poll() asks the node for getchaintips. Every tip that
isn't the active one is a branch that forks off the active chain `branchlen` blocks below the tip. Its blocks are
walked back to the fork point (getblockheader, following previousblockhash) and recorded in stale_blocks: always the
header, plus the coinbase, size and pool identification when the node has the full block (getblock verbosity 2;
"Block not available" means headers only).

Reorgs: when our active chain switches, the blocks it disconnected become a non-active branch, so they are found the
same way. A block counts as previously active if the backend stored it in `blocks` (it does that for each new tip) or
it had been recorded stale and then came back. Such a branch gets a chain_reorgs row (depth = previously active blocks
in it), and on_reorg() is called so the caller can bring the newly active blocks in (ZMQ only announces the new tip).

The tracker is not what keeps blocks_best right: the best-chain reconciler (reconcile.py, #212) compares the stored
best block at each recent height with the node's and calls record_replaced() for every block it replaces, which writes
the same rows. The tracker adds the side-branch metadata (never-active forks, headers-only tips, the exact tip status).

A recorded stale block that is on the active chain again (a later reorg made its branch win) is marked
reorged_in_at; the stale-tip read then treats it as the best chain.

Bounds (named constants below): branches whose tip is more than STALE_MAX_DEPTH blocks below the active tip, or whose
tip header is older than STALE_MAX_AGE_DAYS, are ignored; at most STALE_MAX_BRANCH_BLOCKS blocks are recorded per
branch. Branches ahead of the active tip (headers the node is still downloading) wait until they aren't.

Idempotent: a branch whose tip is already recorded with the same status costs no RPC call besides getchaintips. A
branch is saved in one transaction, fork point first, so a recorded tip means the whole branch is recorded.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Callable, Dict, List, Optional

from bitcoin_utils import extract_coinbase_data

STALE_POLL_INTERVAL_S = 60        # timer between polls (a new block triggers one immediately)
STALE_MAX_DEPTH = 288             # ignore branches whose tip is more than this many blocks below the active tip
STALE_MAX_AGE_DAYS = 7            # ignore branches whose tip header time is older than this
STALE_MAX_BRANCH_BLOCKS = 20      # record at most this many blocks per branch (the ones nearest its tip)

NOT_ACTIVE_STATUSES = ("valid-fork", "valid-headers", "headers-only", "invalid")

logger = logging.getLogger("backend.stale_blocks")


def block_unavailable(exc: Exception) -> bool:
    """getblock failed because the node doesn't have the block's data (headers only, or pruned): not retried."""
    msg = str(exc).lower()
    return "not available" in msg or "not found on disk" in msg or "pruned data" in msg


def _sat(value: Any) -> int:
    return int((Decimal(str(value)) * 100_000_000).to_integral_value())


def coinbase_outputs(block: Dict[str, Any]) -> List[Dict[str, Any]]:
    out = []
    for vout in block["tx"][0].get("vout", []):
        spk = vout.get("scriptPubKey", {}) or {}
        out.append({"value_sat": _sat(vout.get("value", 0)), "script_pubkey": spk.get("hex", ""),
                    "address": spk.get("address") or (spk.get("addresses") or [None])[0]})
    return out


class StaleBlockTracker:
    """rpc(method, *args) calls the node; store is a PostgresStore."""

    def __init__(self, rpc: Callable[..., Any], store: Any,
                 identify_pool: Optional[Callable[[str, List[str]], Dict[str, Any]]] = None,
                 on_reorg: Optional[Callable[[int, int, str], None]] = None,
                 now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
                 max_depth: int = STALE_MAX_DEPTH, max_age_days: int = STALE_MAX_AGE_DAYS,
                 max_branch_blocks: int = STALE_MAX_BRANCH_BLOCKS, log: logging.Logger = logger):
        self.rpc, self.store, self.identify_pool, self.on_reorg, self.now = rpc, store, identify_pool, on_reorg, now
        self.max_depth, self.max_age, self.max_branch_blocks = max_depth, timedelta(days=max_age_days), max_branch_blocks
        self.log = log
        self._wake = threading.Event()
        self._lock = threading.Lock()   # poll() and record_replaced() run on different threads; one records at a time

    # --- one poll -------------------------------------------------------------------------------------------------
    def poll(self) -> Dict[str, int]:
        with self._lock:
            return self._poll()

    def _poll(self) -> Dict[str, int]:
        stats = {"tips": 0, "branches_recorded": 0, "blocks_recorded": 0, "full_blocks": 0, "reorgs": 0,
                 "reactivated": 0, "skipped_known": 0, "skipped_bounds": 0}
        tips = self.rpc("getchaintips")
        active = next((t for t in tips if t.get("status") == "active"), None)
        if active is None:
            self.log.warning("getchaintips returned no active tip")
            return stats
        tip_height = int(active["height"])
        stats["reactivated"] = self._mark_reactivated(tip_height)
        for tip in tips:
            status = tip.get("status")
            if status not in NOT_ACTIVE_STATUSES:
                continue
            stats["tips"] += 1
            height, branchlen = int(tip["height"]), int(tip.get("branchlen", 0))
            if branchlen <= 0:
                continue
            if tip_height - height > self.max_depth or (height > tip_height and status != "invalid"):
                stats["skipped_bounds"] += 1
                continue
            known = self.store.stale_block_states([tip["hash"]]).get(tip["hash"])
            if known and known["last_status"] == status and known["reorged_in_at"] is None:
                stats["skipped_known"] += 1
                continue
            n_blocks, n_full, reorged = self._record_branch(tip, status, tip_height, active["hash"])
            if n_blocks < 0:
                stats["skipped_bounds"] += 1
                continue
            stats["branches_recorded"] += 1
            stats["blocks_recorded"] += n_blocks
            stats["full_blocks"] += n_full
            stats["reorgs"] += int(reorged)
        if stats["branches_recorded"] or stats["reactivated"]:
            self.log.info("Stale blocks: %s", stats)
        return stats

    def _mark_reactivated(self, tip_height: int) -> int:
        """Recorded stale blocks that are on the active chain now (a later reorg made their branch win)."""
        n = 0
        for row in self.store.current_stale_blocks(tip_height - self.max_depth):
            if row["height"] > tip_height:
                continue
            if self.rpc("getblockhash", row["height"]) == row["block_hash"]:
                self.store.mark_stale_block_reactivated(row["block_hash"])
                self.log.info("Stale block %s at height %d is on the active chain again", row["block_hash"], row["height"])
                n += 1
        return n

    def _record_branch(self, tip: Dict[str, Any], status: str, active_height: int, active_hash: str):
        height, branchlen = int(tip["height"]), int(tip["branchlen"])
        fork_height = height - branchlen
        # walk from the tip back to the fork point: headers only (cheap)
        headers: List[Dict[str, Any]] = []
        h = tip["hash"]
        while h and len(headers) < min(branchlen, self.max_branch_blocks):
            header = self.rpc("getblockheader", h)
            if int(header["height"]) <= fork_height:
                break
            if not headers and datetime.fromtimestamp(int(header["time"]), timezone.utc) < self.now() - self.max_age:
                return -1, 0, False
            headers.append(header)
            h = header.get("previousblockhash")
        if branchlen > self.max_branch_blocks:
            self.log.warning("Stale branch at %s is %d blocks long; recording the %d nearest its tip",
                             tip["hash"], branchlen, self.max_branch_blocks)
        n_rows, n_full, reorg = self._save_branch(headers, status, tip["hash"], fork_height, active_height, active_hash)
        if reorg and self.on_reorg:
            try:
                self.on_reorg(fork_height, active_height, active_hash)
            except Exception as e:
                self.log.error("on_reorg failed: %s", e)
        return n_rows, n_full, reorg is not None

    def _save_branch(self, headers: List[Dict[str, Any]], status: str, tip_hash: str, fork_height: int,
                     active_height: int, active_hash: str, was_active: bool = False):
        """Record one branch (headers tip first) in one transaction, with a chain_reorgs row when it disconnected
        previously active blocks. was_active=True: the caller knows every block was on our active chain (the
        best-chain reconciler replacing a block it had stored as best)."""
        hashes = [x["hash"] for x in headers]
        states = self.store.stale_block_states(hashes)
        in_blocks = self.store.known_block_hashes(hashes)
        now = self.now()
        rows = []
        for header in reversed(headers):   # fork point first
            bh = header["hash"]
            state = states.get(bh)
            row = {
                "block_hash": bh, "height": int(header["height"]), "prev_hash": header.get("previousblockhash") or "",
                "version": int(header["version"]), "block_time": datetime.fromtimestamp(int(header["time"]), timezone.utc),
                "bits": int(str(header["bits"]), 16), "nonce": int(header["nonce"]), "merkle_root": header["merkleroot"],
                "status": status, "tip_hash": tip_hash, "fork_height": fork_height, "first_seen": now,
                # previously active: stored as a tip by the backend, or recorded stale before and then back on the chain
                "was_active": was_active or bh in in_blocks or bool(state and state["reorged_in_at"] is not None),
                "newly_stale": state is None or state["reorged_in_at"] is not None,
                "full_block": False,
            }
            if not (state and state["full_block"]):
                self._add_full_block(row)
            rows.append(row)
        reorg = None
        disconnected = [r for r in rows if r["was_active"] and r["newly_stale"]]
        if disconnected:
            old_tip = max(disconnected, key=lambda r: r["height"])
            reorg = {"fork_height": fork_height, "depth": len(disconnected), "old_tip_hash": old_tip["block_hash"],
                     "old_tip_height": old_tip["height"], "new_tip_hash": active_hash, "new_tip_height": active_height,
                     "detected_at": now}
        self.store.save_stale_branch(rows, reorg)
        n_full = sum(1 for r in rows if r["full_block"])
        self.log.info("Recorded stale branch %s (%s, %d blocks from height %d, %d full)%s", tip_hash, status,
                      len(rows), fork_height + 1, n_full,
                      f"; reorg of depth {reorg['depth']} from {reorg['old_tip_hash']}" if reorg else "")
        return len(rows), n_full, reorg

    # --- blocks the best-chain reconciler replaced (#212) -------------------------------------------------------------
    def record_replaced(self, block_hashes: List[str]) -> int:
        """Record blocks we had stored as best that the node's active chain no longer has at their height, so
        blocks_best hides them even when no poll saw their branch (tracker off, backend down across the reorg, a
        branch beyond the poll's bounds). Same rows and chain_reorgs rows as a poll; no cap on the branch length (the
        caller's window bounds it) and no on_reorg (the caller stores the winners itself). Blocks are grouped into
        branches by previousblockhash; a branch forks off right below its lowest block. Returns blocks recorded."""
        with self._lock:
            tips = self.rpc("getchaintips")
            active = next((t for t in tips if t.get("status") == "active"), None)
            if active is None:
                raise RuntimeError("getchaintips returned no active tip")
            tip_status = {t["hash"]: t["status"] for t in tips if t.get("status") in NOT_ACTIVE_STATUSES}
            headers = []
            for bh in dict.fromkeys(block_hashes):
                try:
                    headers.append(self.rpc("getblockheader", bh))
                except Exception as e:
                    self.log.error("Replaced block %s: no header from the node, not recorded: %s", bh, e)
            branches: List[List[Dict[str, Any]]] = []   # each fork point first
            branch_of: Dict[str, List[Dict[str, Any]]] = {}
            for header in sorted(headers, key=lambda x: int(x["height"])):
                parent = branch_of.get(header.get("previousblockhash"))
                if parent is None:
                    branch = [header]
                    branches.append(branch)
                elif parent[-1]["hash"] == header.get("previousblockhash"):
                    branch = parent
                    branch.append(header)
                else:   # a sibling of a block already in a branch: its own branch sharing the prefix
                    branch = parent[:[x["hash"] for x in parent].index(header["previousblockhash"]) + 1] + [header]
                    branches.append(branch)
                branch_of[header["hash"]] = branch
            n = 0
            for branch in branches:
                tip = branch[-1]
                # A block that was active was fully validated: 'valid-fork' unless the node reports its tip otherwise
                # (e.g. 'invalid' after invalidateblock).
                status = tip_status.get(tip["hash"], "valid-fork")
                rows, _, _ = self._save_branch(list(reversed(branch)), status, tip["hash"],
                                               int(branch[0]["height"]) - 1, int(active["height"]), active["hash"],
                                               was_active=True)
                n += rows
            return n

    def _add_full_block(self, row: Dict[str, Any]) -> None:
        try:
            block = self.rpc("getblock", row["block_hash"], 2)
        except Exception as e:
            if block_unavailable(e):
                return
            raise
        script_sig, addresses = extract_coinbase_data(block)
        mining_pool: Dict[str, Any] = {}
        if self.identify_pool:
            try:
                mining_pool = self.identify_pool(script_sig, addresses) or {}
            except Exception as e:
                self.log.error("Pool identification failed for stale block %s: %s", row["block_hash"], e)
        row.update(full_block=True, block_fetched_at=self.now(), coinbase_script_sig=script_sig,
                   coinbase_outputs=coinbase_outputs(block), tx_count=int(block.get("nTx", len(block.get("tx", [])))),
                   size=int(block["size"]) if "size" in block else None,
                   weight=int(block["weight"]) if "weight" in block else None,
                   mining_pool=mining_pool or {"name": "Unknown", "id": "unknown"})

    # --- loop -----------------------------------------------------------------------------------------------------
    def request_poll(self) -> None:
        """Poll now (e.g. on a new block) instead of waiting for the timer."""
        self._wake.set()

    def run_forever(self, interval_s: float = STALE_POLL_INTERVAL_S,
                    after_poll: Optional[Callable[[Dict[str, int]], None]] = None) -> None:
        while True:
            try:
                stats = self.poll()
                if after_poll:
                    after_poll(stats)
            except Exception as e:
                self.log.error("Stale block poll failed: %s", e)
            self._wake.wait(interval_s)
            self._wake.clear()
