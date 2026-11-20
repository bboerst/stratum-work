"""The stale-parents summary (stale_parent_pools; db/migrations/20261120000001_stale_parent_pools.sql), which the web's
Forks page reads instead of every stale block's templates per request. The twin of unknown_parents.py, for parents
that are blocks we recorded as stale.

Per (stale block, pool) the table holds counted facts about the templates at the block's height + 1 that build on it,
received inside that height's window (template_height_windows()): de-duplicated templates, first / last receive time,
the connections that received them, and templates per height and per nbits. Never a kind or a verdict: whether the
block is still stale is judged when the page reads the table (stale_blocks.reorged_in_at), and rows are kept for every
stale block and every pool.

refresh(store, t_from, t_to):
  the stale blocks to recompute are those whose window overlaps [t_from, t_to] (new templates on them can only arrive
  inside it, and a window changes when a block at its heights is stored, i.e. while it is recent) and those with no
  row yet (recorded since: by the tracker, imported from the stale-blocks dataset, or marked replaced by the
  best-chain check). A block with no row because it has no templates is tried once per process, not on every run.
  Each block is recomputed whole by stale_parent_pools_refresh(), its window passed as values (so TimescaleDB
  excludes chunks), which de-duplicates and aggregates exactly as the web's live read does. Idempotent.

The backend runs it on the unknown parents' schedule (unknown_parents.UnknownParentsRefresher: after each new block over
the last WINDOW, once over STARTUP_WINDOW after the startup sync, and after the stale-block tracker records a block).
A window that changes long after the fact (a block stored late at an old height) is the backfill's:

    python -m stale_parents --backfill [--from-height 840000] [--to-height 976000] [--chunk 2016]

recomputes every stale block in [from, to] (default: all of them) once, CHUNK heights per step, logging each, and
prints a JSON summary. Connects like the backend (PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD, PG_SSLMODE,
PG_SSLROOTCERT), as a user in the stratum_backend role.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from unknown_parents import STARTUP_WINDOW, WINDOW, UnknownParentsRefresher, _postgres_store, _utcnow

CHUNK = 2016                            # backfill: heights per step (a difficulty epoch)

logger = logging.getLogger("backend.stale_parents")


def _recompute(store: Any, blocks: List[Dict[str, Any]], attempted: Optional[Set[bytes]] = None) -> Dict[str, Any]:
    rows = 0
    for b in blocks:
        rows += store.refresh_stale_parent(b["block_hash"], b["height"], b["w_from"], b["w_to"])
        if attempted is not None:
            attempted.add(b["block_hash"])
    return {"parents": [b["block_hash"] for b in blocks], "rows": rows}


def refresh(store: Any, t_from: datetime, t_to: datetime, attempted: Optional[Set[bytes]] = None) -> Dict[str, Any]:
    """Recompute every stale block whose window overlaps [t_from, t_to] or that has no row yet (skipping those already
    in `attempted`, when given, that have neither). Returns {parents: [block_hash, ...], rows: rows written}."""
    blocks = [b for b in store.stale_parents_to_refresh(t_from, t_to)
              if b["overlaps"] or attempted is None or b["block_hash"] not in attempted]
    return _recompute(store, blocks, attempted)


def height_chunks(h_from: int, h_to: int, chunk: int = CHUNK) -> List[Tuple[int, int]]:
    """[h_from, h_to] as consecutive disjoint closed ranges of `chunk` heights, lowest first."""
    if chunk <= 0:
        raise ValueError("chunk must be positive")
    return [(a, min(a + chunk - 1, h_to)) for a in range(h_from, h_to + 1, chunk)]


def backfill(store: Any, h_from: int, h_to: int, chunk: int = CHUNK, log: logging.Logger = logger,
             clock: Callable[[], float] = time.monotonic) -> Dict[str, Any]:
    """Every stale block at heights [h_from, h_to] recomputed once, chunk by chunk."""
    cs = height_chunks(h_from, h_to, chunk)
    started, parents, rows = clock(), 0, 0
    for i, (a, b) in enumerate(cs, 1):
        t0 = clock()
        s = _recompute(store, store.stale_parents_between_heights(a, b))
        parents += len(s["parents"])
        rows += s["rows"]
        log.info("Stale parents backfill %d/%d [heights %d, %d]: %d blocks, %d rows written, %.1f s",
                 i, len(cs), a, b, len(s["parents"]), s["rows"], clock() - t0)
    summary = {"from_height": h_from, "to_height": h_to, "chunk": chunk, "chunks": len(cs), "parents": parents,
               "rows_written": rows, "seconds": round(clock() - started, 1)}
    log.info("Stale parents backfill done: %s", summary)
    return summary


class StaleParentsRefresher(UnknownParentsRefresher):
    """The unknown parents' schedule (once over STARTUP_WINDOW, then on request() over the last WINDOW, never leaving
    a gap), with this summary's refresh. Its own thread and store (own connection)."""
    label = "Stale parents"

    def __init__(self, store: Any, window=WINDOW, startup_window=STARTUP_WINDOW, now: Callable[[], datetime] = _utcnow,
                 log: logging.Logger = logger):
        super().__init__(store, window=window, startup_window=startup_window, now=now, log=log)
        self.attempted: Set[bytes] = set()

    def refresh(self, a: datetime, b: datetime) -> Dict[str, Any]:
        return refresh(self.store, a, b, self.attempted)


# --- CLI -----------------------------------------------------------------------------------------------------------
def main(argv: Optional[List[str]] = None, store: Any = None) -> int:
    p = argparse.ArgumentParser(prog="python -m stale_parents", description=__doc__.split("\n\n")[0])
    p.add_argument("--backfill", action="store_true", help="recompute every stale block in [--from-height, --to-height]")
    p.add_argument("--from-height", type=int, help="lowest stale block height (default: the lowest)")
    p.add_argument("--to-height", type=int, help="highest stale block height (default: the highest)")
    p.add_argument("--chunk", type=int, default=CHUNK, help=f"heights per step (default {CHUNK})")
    args = p.parse_args(argv)
    if not args.backfill or args.chunk <= 0:
        p.print_help(sys.stderr)
        return 2
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr)
    store = store or _postgres_store()
    span = store.stale_block_heights()
    if span is None:
        print(json.dumps({"chunks": 0, "parents": 0, "rows_written": 0, "note": "no stale blocks"}))
        return 0
    h_from = span[0] if args.from_height is None else args.from_height
    h_to = span[1] if args.to_height is None else args.to_height
    print(json.dumps(backfill(store, h_from, h_to, args.chunk), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
