"""Postgres + TimescaleDB sink for mining.notify templates (#111; design: docs/design/postgres-timescale.md).

The collector builds one document per mining.notify (create_notification_document). This module:
  * routes it to `templates` (Bitcoin) or `templates_other` (everything else), see route();
  * converts it losslessly to the schema's types, see to_row();
  * writes it from a background thread with a bounded queue, so the Stratum loop never waits on the database and a
    database outage never crashes or stalls the collector (PostgresSink).
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional

LOG = logging.getLogger(__name__)

# Plausible template heights relative to the collector's own Bitcoin tip (design doc, section 2: ingest rules).
TIP_BEHIND = 6
TIP_AHEAD = 2

COLUMNS = (
    "received_at", "source_id", "height", "job_id", "prev_hash", "coinbase1", "coinbase2", "merkle_branches",
    "version", "nbits", "ntime", "clean_jobs", "extranonce1", "extranonce2_length", "latency_ms", "latency_method",
)


@dataclass(frozen=True)
class Route:
    table: str                    # "templates" or "templates_other"
    chain: Optional[str] = None   # templates_other only: "bch" | "unknown"
    reason: Optional[str] = None  # templates_other only


BTC = Route("templates")


def route(height: int, chain_family: Optional[str], tip: Optional[int]) -> Route:
    """Decide which table a template belongs in.

    height        BIP34 height from the collector (0 = could not be parsed).
    chain_family  the collector's chain classifier result ("bch", "unknown", or None for Bitcoin).
    tip           the collector's current Bitcoin tip, or None if unknown/stale (then height plausibility isn't
                  checked, which preserves today's behavior for collectors without a node).
    """
    if not height or height <= 0:
        return Route("templates_other", "unknown", "height_parse_failed")
    if chain_family == "bch":
        return Route("templates_other", "bch", "bch")
    if chain_family:
        return Route("templates_other", "unknown", "unknown_chain")
    if tip is not None and not (tip - TIP_BEHIND <= height <= tip + TIP_AHEAD):
        return Route("templates_other", "unknown", "height_implausible")
    return BTC


def _hex(value: str) -> bytes:
    return bytes.fromhex(value)


def _u32(value: str) -> int:
    v = int(value, 16)
    if not 0 <= v <= 0xFFFFFFFF:
        raise ValueError(f"not a 32-bit value: {value!r}")
    return v


def to_row(document: dict, source_id: int) -> tuple:
    """Convert a collector document to a `templates` row (column order = COLUMNS). Lossless: re-encoding the bytes as
    lowercase hex gives back what the pool sent. Raises ValueError on malformed input (non-hex fields etc.)."""
    ns = int(document["timestamp"], 16)
    received_at = datetime.fromtimestamp(ns // 1000 / 1_000_000, tz=timezone.utc)   # µs precision
    branches = b"".join(_hex(b) for b in document.get("merkle_branches") or [])
    latency_method = document.get("lat_m")
    return (
        received_at,
        source_id,
        int(document.get("height") or 0),
        str(document["job_id"]),
        _hex(document["prev_hash"]),
        _hex(document["coinbase1"]),
        _hex(document["coinbase2"]),
        branches,
        _u32(document["version"]),
        _u32(document["nbits"]),
        _u32(document["ntime"]),
        bool(document["clean_jobs"]),
        _hex(document["extranonce1"]),
        int(document["extranonce2_length"]),
        document.get("lat_ms"),
        latency_method if latency_method in ("tcp", "app") else None,
    )


@dataclass
class PostgresConfig:
    host: str
    port: int
    database: str
    user: str
    password: Optional[str]
    sslmode: str = "prefer"
    site: str = "local"
    replica: str = "a"   # several collectors per pool and site (redundant collection) register separate sources
    connect_timeout: int = 10

    def connect_kwargs(self) -> dict:
        # Keyword arguments, never a URL: libpq/psycopg errors then can't echo a password.
        kw = dict(host=self.host, port=self.port, dbname=self.database, user=self.user, sslmode=self.sslmode,
                  connect_timeout=self.connect_timeout, application_name="stratum-work-collector")
        if self.password:
            kw["password"] = self.password
        return kw


class PostgresSink:
    """Background, batched, never-blocking writer.

    submit() only appends to a bounded queue (oldest entries are dropped and counted when it's full). A worker thread
    connects, upserts this collector's `sources` row, and writes queued templates in batches. On any database error it
    reconnects with exponential backoff while the queue keeps buffering.
    """

    def __init__(self, config: PostgresConfig, source_name: str, stratum_url: Optional[str] = None,
                 tip_provider: Callable[[], Optional[int]] = lambda: None, max_queue: int = 50_000,
                 batch_size: int = 500, connect: Optional[Callable] = None, stats_interval: float = 600.0):
        self.config = config
        self.source_name = source_name
        self.stratum_url = stratum_url
        self.tip_provider = tip_provider
        self.batch_size = batch_size
        self._connect = connect or self._psycopg_connect
        self._queue: deque = deque(maxlen=max_queue)
        self._cond = threading.Condition()
        self._stop = False
        self._conn = None
        self._source_id: Optional[int] = None
        self._thread: Optional[threading.Thread] = None
        self.stats_interval = stats_interval
        self._last_stats_log = time.monotonic()
        self.stats = {"submitted": 0, "written": 0, "written_other": 0, "dropped_queue_full": 0,
                      "dropped_invalid": 0, "db_errors": 0}

    # ── public ──────────────────────────────────────────────────────────────────────────────────────
    def start(self) -> "PostgresSink":
        self._thread = threading.Thread(target=self._run, name="postgres-sink", daemon=True)
        self._thread.start()
        return self

    def submit(self, document: dict) -> None:
        """Queue a document. Never blocks, never raises."""
        with self._cond:
            if len(self._queue) == self._queue.maxlen:
                self.stats["dropped_queue_full"] += 1
            self._queue.append(document)
            self.stats["submitted"] += 1
            self._cond.notify()

    def close(self, timeout: float = 5.0) -> None:
        """Stop the worker after a best-effort flush of what's queued."""
        with self._cond:
            self._stop = True
            self._cond.notify()
        if self._thread:
            self._thread.join(timeout)
        self._disconnect()

    def queued(self) -> int:
        return len(self._queue)

    # ── worker ──────────────────────────────────────────────────────────────────────────────────────
    @staticmethod
    def _psycopg_connect(**kwargs):
        import psycopg  # imported lazily: MongoDB-only collectors don't need psycopg installed
        return psycopg.connect(**kwargs)

    def _ensure_connected(self) -> None:
        if self._conn is not None and not getattr(self._conn, "closed", False):
            return
        self._conn = self._connect(**self.config.connect_kwargs())
        with self._conn.cursor() as cur:
            cur.execute(
                """INSERT INTO sources (name, site, replica, stratum_url) VALUES (%s, %s, %s, %s)
                   ON CONFLICT (name, site, replica) DO UPDATE SET stratum_url = EXCLUDED.stratum_url
                   RETURNING id""",
                (self.source_name, self.config.site, self.config.replica, self.stratum_url),
            )
            self._source_id = cur.fetchone()[0]
        self._conn.commit()
        LOG.info("Postgres sink connected to %s:%s/%s as %s (source %r site %r replica %r -> id %s)",
                 self.config.host, self.config.port, self.config.database, self.config.user, self.source_name,
                 self.config.site, self.config.replica, self._source_id)

    def _disconnect(self) -> None:
        try:
            if self._conn is not None:
                self._conn.close()
        except Exception:  # pragma: no cover - best effort
            pass
        self._conn = None

    def _take_batch(self) -> list:
        with self._cond:
            while not self._queue and not self._stop:
                self._cond.wait(timeout=1.0)
            return [self._queue.popleft() for _ in range(min(self.batch_size, len(self._queue)))]

    def _requeue_front(self, batch: list) -> None:
        with self._cond:
            for doc in reversed(batch):
                if len(self._queue) == self._queue.maxlen:
                    self.stats["dropped_queue_full"] += 1
                    break
                self._queue.appendleft(doc)

    def _write(self, batch: list) -> None:
        self._ensure_connected()
        tip = self.tip_provider()
        btc, other = [], []
        for doc in batch:
            try:
                row = to_row(doc, self._source_id)
            except (KeyError, ValueError, TypeError) as exc:
                self.stats["dropped_invalid"] += 1
                LOG.warning("Postgres sink: dropping malformed template (job_id=%r): %s", doc.get("job_id"), exc)
                continue
            r = route(row[2], doc.get("chain_family"), tip)
            (btc if r is BTC else other).append(row if r is BTC else row + (r.chain, r.reason))
        cols = ", ".join(COLUMNS)
        with self._conn.cursor() as cur:
            if btc:
                cur.executemany(f"INSERT INTO templates ({cols}) VALUES ({', '.join(['%s'] * len(COLUMNS))})", btc)
            if other:
                cur.executemany(f"INSERT INTO templates_other ({cols}, chain, reason) "
                                f"VALUES ({', '.join(['%s'] * (len(COLUMNS) + 2))})", other)
        self._conn.commit()
        self.stats["written"] += len(btc)
        self.stats["written_other"] += len(other)

    def _maybe_log_stats(self) -> None:
        if time.monotonic() - self._last_stats_log >= self.stats_interval:
            self._last_stats_log = time.monotonic()
            LOG.info("Postgres sink stats: %s, queued=%s", self.stats, self.queued())

    def _run(self) -> None:
        backoff = 1.0
        while True:
            self._maybe_log_stats()
            batch = self._take_batch()
            if not batch:
                if self._stop:
                    return
                continue
            try:
                self._write(batch)
                backoff = 1.0
            except Exception as exc:
                self.stats["db_errors"] += 1
                LOG.error("Postgres sink write failed (%s queued, retrying in %.0fs): %s",
                          len(batch) + self.queued(), backoff, exc)
                self._disconnect()
                self._requeue_front(batch)
                if self._stop:
                    return
                time.sleep(backoff)
                backoff = min(backoff * 2, 60.0)
