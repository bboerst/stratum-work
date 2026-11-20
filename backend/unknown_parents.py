"""The unknown-parents summary (unknown_parent_pools; db/migrations/20261119000003_unknown_parent_pools.sql), which the
web's /unknown-parents page reads for any range instead of scanning months of templates per request.

Per (unknown parent, pool) the table holds counted facts: de-duplicated templates, first / last receive time, how many
carry a merge-mining commitment, the connections that received them, and templates per height and per nbits. Never a
kind or a verdict: whether a parent is still unknown is judged when the page reads the table (bitcoin_parents), so a
parent later recorded as a block or a stale block drops out without any cleanup here.

refresh(store, t_from, t_to):
  1. narrow: the parents of templates received in [t_from, t_to] that are no block we know, with their heights and
     receive times there (reads received_at, height and prev_hash only);
  2. per parent, its WHOLE rows are recomputed from all its templates: the read is bounded by the heights and the time
     span seen in this range, merged with what the table already holds for the parent (so a parent that lasts longer
     than the range is still read whole), widened by MARGIN. The bounds are values, so TimescaleDB excludes chunks.
     unknown_parent_pools_refresh() de-duplicates and aggregates exactly as the web's live read does, upserts every
     pool's row and deletes the rows of pools with no template left. Idempotent.

Every template lies in some refreshed range: the backend refreshes the last WINDOW after each new block (and never
leaves a gap since its previous run), and STARTUP_WINDOW once after the startup sync. Anything older (a fresh
database, a longer outage) is the backfill's:

    python -m unknown_parents --backfill [--from 2024-06-01] [--to 2026-11-19T12:00Z] [--chunk 7d]

walks [from, to] (default: the first template to now) in chunks, logging each, and prints a JSON summary. Connects
like the backend (PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD, PG_SSLMODE, PG_SSLROOTCERT), as a user in the
stratum_backend role.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import logging
import pathlib
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

WINDOW = timedelta(hours=2)            # after each new block
STARTUP_WINDOW = timedelta(days=7)     # once after the startup sync
MARGIN = timedelta(hours=1)            # around a parent's known receive times
CHUNK = timedelta(days=7)              # backfill

logger = logging.getLogger("backend.unknown_parents")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def bounds(seen: Dict[str, Any], stored: Optional[Dict[str, Any]], margin: timedelta = MARGIN
           ) -> Tuple[List[int], datetime, datetime]:
    """The read bounds for one parent: the heights and [first - margin, last + margin] of its templates seen in this
    range, merged with the parent's stored extent."""
    heights, first, last = set(seen["heights"]), seen["first"], seen["last"]
    if stored:
        heights |= set(stored["heights"])
        first, last = min(first, stored["first"]), max(last, stored["last"])
    return sorted(heights), first - margin, last + margin


def refresh(store: Any, t_from: datetime, t_to: datetime, margin: timedelta = MARGIN) -> Dict[str, Any]:
    """Recompute the whole rows of every unknown parent with a template received in [t_from, t_to]. Returns
    {parents: [prev_hash, ...], rows: (parent, pool) rows written}."""
    seen = store.unknown_parents_received_between(t_from, t_to)
    stored = store.unknown_parent_extents([s["prev_hash"] for s in seen]) if seen else {}
    rows = 0
    for s in seen:
        heights, lo, hi = bounds(s, stored.get(s["prev_hash"]), margin)
        rows += store.refresh_unknown_parent(s["prev_hash"], heights, lo, hi)
    return {"parents": [s["prev_hash"] for s in seen], "rows": rows}


def windows(t_from: datetime, t_to: datetime, chunk: timedelta = CHUNK) -> List[Tuple[datetime, datetime]]:
    """[t_from, t_to] as consecutive closed chunks, oldest first; neighbours share their boundary instant."""
    if chunk <= timedelta(0):
        raise ValueError("chunk must be positive")
    out, a = [], t_from
    while a < t_to:
        b = min(a + chunk, t_to)
        out.append((a, b))
        a = b
    return out


def backfill(store: Any, t_from: datetime, t_to: datetime, chunk: timedelta = CHUNK, margin: timedelta = MARGIN,
             log: logging.Logger = logger, clock: Callable[[], float] = time.monotonic) -> Dict[str, Any]:
    """refresh() over [t_from, t_to], chunk by chunk. A parent seen in several chunks is recomputed whole each time
    (its stored extent widens the read), so the last write holds all its templates."""
    ws = windows(t_from, t_to, chunk)
    started, parents, rows = clock(), set(), 0
    for i, (a, b) in enumerate(ws, 1):
        t0 = clock()
        s = refresh(store, a, b, margin)
        parents.update(s["parents"])
        rows += s["rows"]
        log.info("Unknown parents backfill %d/%d [%s, %s]: %d parents, %d rows written, %.1f s",
                 i, len(ws), a.isoformat(), b.isoformat(), len(s["parents"]), s["rows"], clock() - t0)
    summary = {"from": t_from.isoformat(), "to": t_to.isoformat(), "chunk_s": chunk.total_seconds(),
               "chunks": len(ws), "parents": len(parents), "rows_written": rows,
               "seconds": round(clock() - started, 1)}
    log.info("Unknown parents backfill done: %s", summary)
    return summary


class UnknownParentsRefresher:
    """The backend's schedule: once over STARTUP_WINDOW, then after each new block (request()) over the last WINDOW,
    starting no later than where the previous successful run ended, so nothing between runs is skipped. Runs on
    its own thread with its own store (own connection), never on the block processor."""

    def __init__(self, store: Any, window: timedelta = WINDOW, startup_window: timedelta = STARTUP_WINDOW,
                 margin: timedelta = MARGIN, now: Callable[[], datetime] = _utcnow, log: logging.Logger = logger):
        self.store, self.window, self.startup_window, self.margin = store, window, startup_window, margin
        self.now, self.log = now, log
        self.covered_to: Optional[datetime] = None
        self._wake = threading.Event()

    def request(self) -> None:
        """Refresh now (a new block)."""
        self._wake.set()

    def range(self) -> Tuple[datetime, datetime]:
        to = self.now()
        if self.covered_to is None:
            return to - self.startup_window, to
        return min(to - self.window, self.covered_to), to

    label = "Unknown parents"

    def refresh(self, a: datetime, b: datetime) -> Dict[str, Any]:
        return refresh(self.store, a, b, self.margin)

    def run_once(self) -> Dict[str, Any]:
        a, b = self.range()
        t0 = time.monotonic()
        s = self.refresh(a, b)
        self.covered_to = b
        self.log.info("%s refreshed [%s, %s]: %d parents, %d rows written, %.1f s", self.label,
                      a.isoformat(), b.isoformat(), len(s["parents"]), s["rows"], time.monotonic() - t0)
        return s

    def run_forever(self) -> None:
        while True:
            try:
                self.run_once()
            except Exception as e:
                # covered_to stays: the next run starts where the last good one ended
                self.log.error("%s refresh failed (retried on the next block): %s", self.label, e)
            self._wake.wait()
            self._wake.clear()


# --- CLI -----------------------------------------------------------------------------------------------------------
def parse_duration(s: str) -> timedelta:
    m = re.fullmatch(r"\s*(\d+)\s*([dhm])\s*", s)
    if not m or int(m.group(1)) == 0:
        raise argparse.ArgumentTypeError(f"not a duration like 7d, 12h or 30m: {s!r}")
    return timedelta(**{{"d": "days", "h": "hours", "m": "minutes"}[m.group(2)]: int(m.group(1))})


def parse_time(s: str) -> datetime:
    try:
        t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        raise argparse.ArgumentTypeError(f"not an ISO date or time: {s!r}")
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def _postgres_store() -> Any:
    # integrations/__init__.py connects to the configured store and to RabbitMQ at import; this needs neither, so
    # load the store module on its own.
    path = pathlib.Path(__file__).resolve().parent / "integrations" / "store.py"
    spec = importlib.util.spec_from_file_location("unknown_parents_store", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PostgresStore.from_env()


def main(argv: Optional[List[str]] = None, store: Any = None) -> int:
    p = argparse.ArgumentParser(prog="python -m unknown_parents", description=__doc__.split("\n\n")[0])
    p.add_argument("--backfill", action="store_true", help="recompute the summary over [--from, --to]")
    p.add_argument("--from", dest="t_from", type=parse_time, help="start (ISO, UTC unless given; default: the first template)")
    p.add_argument("--to", dest="t_to", type=parse_time, help="end (default: now)")
    p.add_argument("--chunk", type=parse_duration, default=CHUNK, help="time per narrow read (default 7d)")
    args = p.parse_args(argv)
    if not args.backfill:
        p.print_help(sys.stderr)
        return 2
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr)
    store = store or _postgres_store()
    t_to = args.t_to or _utcnow()
    t_from = args.t_from or store.first_template_received()
    if t_from is None:
        print(json.dumps({"chunks": 0, "parents": 0, "rows_written": 0, "note": "no templates"}))
        return 0
    print(json.dumps(backfill(store, t_from, t_to, args.chunk), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
