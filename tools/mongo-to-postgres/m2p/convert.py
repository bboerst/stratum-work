"""Per-document conversion: MongoDB `mining_notify` document -> `templates` / `templates_other` row.

Lossless by construction: a document is converted only if re-encoding the row gives back exactly what MongoDB holds
(lowercase, even-length hex; 4-byte version/nbits/ntime; 32-byte merkle branches; string job_id; ...). Anything else
is rejected with a reason, stored in the tool's `rejected` table, and reported; it is never silently changed.
"""
from __future__ import annotations

import bisect
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Optional

from .shared import BTC, parse_bip34_height, route

UTC = timezone.utc
EPOCH = datetime(1970, 1, 1, tzinfo=UTC)

HEX_NS = re.compile(r"^[0-9a-f]{16}$")             # time.time_ns() as 16 lowercase hex digits (current collectors)
ISO_PREFIX = re.compile(r"^\d{4}-\d{2}-\d{2}")      # older collectors: ISO-8601, normally without a timezone
TZ_SUFFIX = re.compile(r"(?:Z|[+-]\d{2}:?\d{2})$")  # an explicit UTC offset at the end of an ISO string

# Fields a document may carry. Everything else would be lost, so it is counted and reported.
KNOWN_FIELDS = frozenset({
    "_id", "timestamp", "pool_name", "height", "job_id", "prev_hash", "coinbase1", "coinbase2", "merkle_branches",
    "version", "nbits", "ntime", "clean_jobs", "extranonce1", "extranonce2_length", "lat_ms", "lat_m", "chain_family",
})

FMT_HEX, FMT_ISO_NAIVE, FMT_ISO_TZ, FMT_DATETIME = "hex_ns", "iso_naive", "iso_tz", "bson_datetime"


class Reject(ValueError):
    """A document that can't be converted losslessly. `reason` is a short, stable code."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason


# ── timestamps ──────────────────────────────────────────────────────────────────────────────────────────────────
def parse_timestamp(value) -> tuple[datetime, str]:
    """`mining_notify.timestamp` -> (aware UTC datetime at µs precision, format).

    * 16 hex digits: nanoseconds since the epoch (the ns remainder below 1 µs is dropped)
    * ISO-8601 with an offset ("Z", "+02:00", "-0600"): by its offset
    * ISO-8601 without an offset: **UTC** (never the machine's local time; design doc section 5)
    * BSON datetime (pymongo returns naive UTC datetimes): UTC, ms precision
    """
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=UTC)
        return dt.astimezone(UTC), FMT_DATETIME
    if not isinstance(value, str):
        raise Reject("timestamp_unparseable", f"type {type(value).__name__}")
    if HEX_NS.match(value):
        ns = int(value, 16)
        return EPOCH + timedelta(microseconds=ns // 1000), FMT_HEX
    if ISO_PREFIX.match(value):
        try:
            dt = datetime.fromisoformat(value)
        except ValueError as exc:
            raise Reject("timestamp_unparseable", f"{value!r}: {exc}") from None
        if dt.tzinfo is None:
            return dt.replace(tzinfo=UTC), FMT_ISO_NAIVE
        return dt.astimezone(UTC), FMT_ISO_TZ
    raise Reject("timestamp_unparseable", repr(value[:40]))


def utc_day(dt: datetime) -> date:
    return dt.astimezone(UTC).date()


def day_start(d: date) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=UTC)


def hex_ns(dt: datetime) -> str:
    """The 16-hex-digit timestamp string for an instant (inverse of the hex format, for range queries)."""
    us = (dt - EPOCH) // timedelta(microseconds=1)
    return format(us * 1000, "016x")


def epoch_us(dt: datetime) -> int:
    return (dt - EPOCH) // timedelta(microseconds=1)


# ── Bitcoin tip at a moment, from blocks ────────────────────────────────────────────────────────────────────────
def stratum_prev_hash(block_hash_hex: str) -> bytes:
    """A block hash (display hex) as it appears in mining.notify prev_hash: the 8 32-bit words in reverse order."""
    words = [block_hash_hex[i:i + 8] for i in range(0, 64, 8)]
    return bytes.fromhex("".join(reversed(words)))


class TipIndex:
    """The Bitcoin tip known at a moment: max(height) over blocks with block_time <= t (the design's "tip at receive
    time"), plus block time by height and block height by stratum prev_hash.

    Header times aren't monotonic, so this is a running maximum over blocks sorted by time; that's exactly the set
    {blocks with block_time <= t}. Header times can also be minutes *ahead* of when the block really arrived, which
    makes this tip lag; DayTips corrects for that with evidence from the templates themselves.
    """

    def __init__(self, blocks: Iterable[tuple]):   # (height, block time as unix seconds[, block hash hex])
        blocks = list(blocks)
        pairs = sorted((b[1], b[0]) for b in blocks)
        self._times = [t for t, _ in pairs]
        self._tips = []
        running = None
        for _, h in pairs:
            running = h if running is None else max(running, h)
            self._tips.append(running)
        self.block_time: dict[int, int] = {}   # height -> earliest header time at that height (forks: min)
        for t, h in pairs:
            if h not in self.block_time:
                self.block_time[h] = t
        self.height_by_prev: dict[bytes, int] = {}
        for b in blocks:
            if len(b) > 2 and isinstance(b[2], str) and len(b[2]) == 64:
                self.height_by_prev[stratum_prev_hash(b[2])] = b[0]

    def __len__(self):
        return len(self._times)

    def tip_at(self, dt: datetime) -> Optional[int]:
        i = bisect.bisect_right(self._times, (dt - EPOCH).total_seconds()) - 1
        return self._tips[i] if i >= 0 else None


class DayTips:
    """TipIndex plus evidence from a day's templates: a template whose prev_hash is a known block at height b proves
    that block was out by the time the template was received, whatever its header time says. So

        tip(t) = max(header-time tip at t, highest known block any template had built on by t)

    which is what the live collector's node knew far more closely than header times alone (production has blocks
    whose header time is minutes after the templates building on them). Evidence never lowers the tip."""

    def __init__(self, tips: TipIndex, rows: Iterable["Converted"]):
        self.tips = tips
        self.block_time = tips.block_time
        events = sorted((c.received_at, h) for c in rows
                        if (h := tips.height_by_prev.get(c.values[1])) is not None)
        self._times = [t for t, _ in events]
        self._max, running = [], None
        for _, h in events:
            running = h if running is None else max(running, h)
            self._max.append(running)

    def tip_at(self, dt: datetime) -> Optional[int]:
        base = self.tips.tip_at(dt)
        i = bisect.bisect_right(self._times, dt) - 1
        if i < 0:
            return base
        return self._max[i] if base is None else max(base, self._max[i])


# ── document -> row ─────────────────────────────────────────────────────────────────────────────────────────────
@dataclass
class Converted:
    raw_received_at: datetime   # as recorded (parsed), before any timezone correction
    fmt: str
    source: str                 # pool_name
    height: int                 # re-derived from coinbase1; 0 if it doesn't parse (the collector's sentinel)
    stored_height: object       # what MongoDB has, for the "height changed" statistic
    chain_family: Optional[str]
    values: tuple               # COLUMNS[3:] (job_id .. latency_method), i.e. everything but time, source, height
    ntime: int
    offset_s: int = 0           # set by the timezone safety net: received_at = raw_received_at - offset_s
    unknown_fields: tuple = field(default_factory=tuple)
    mongo_id: str = ""
    received_at: datetime = None   # raw_received_at - offset_s (kept in step by set_offset)

    def __post_init__(self):
        self.received_at = self.raw_received_at - timedelta(seconds=self.offset_s)

    def set_offset(self, offset_s: int) -> None:
        self.offset_s = offset_s
        self.received_at = self.raw_received_at - timedelta(seconds=offset_s)

    def key(self) -> tuple:
        """Dedup key: (source, received_at µs, job_id)."""
        return (self.source, epoch_us(self.received_at), self.values[0])


def _lossless_bytes(v) -> Optional[bytes]:
    """bytes for a hex string, but only if re-encoding gives back exactly the same string (lowercase, even length,
    no whitespace, which bytes.fromhex would otherwise accept)."""
    if not isinstance(v, str):
        return None
    try:
        b = bytes.fromhex(v)
    except ValueError:
        return None
    return b if b.hex() == v else None


def _hexfield(doc: dict, name: str, exact_len: Optional[int] = None) -> bytes:
    v = doc.get(name)
    b = _lossless_bytes(v)
    if b is None:
        raise Reject("non_lossless_hex", f"{name}={v!r:.60}")
    if exact_len is not None and len(v) != exact_len:
        raise Reject("non_lossless_hex", f"{name} has {len(v)} hex digits, expected {exact_len}")
    return b


def _u32(doc: dict, name: str) -> int:
    v = doc.get(name)
    b = _lossless_bytes(v)
    if b is None or len(b) != 4:
        raise Reject("non_lossless_hex", f"{name}={v!r:.60}")
    return int.from_bytes(b, "big")


def convert(doc: dict) -> Converted:
    """Validate and convert one document. Raises Reject for anything that wouldn't round-trip exactly."""
    raw, fmt = parse_timestamp(doc.get("timestamp"))
    source = doc.get("pool_name")
    if source is None:
        source = ""
    if not isinstance(source, str):
        raise Reject("bad_pool_name", repr(source))
    job_id = doc.get("job_id")
    if not isinstance(job_id, str):
        raise Reject("bad_job_id", repr(job_id))
    branches = doc.get("merkle_branches")
    if branches is None:
        branches = []
    # each branch 32 bytes; the joined string must re-encode exactly
    if not isinstance(branches, list) or not all(isinstance(b, str) and len(b) == 64 for b in branches) \
            or (branch_bytes := _lossless_bytes("".join(branches))) is None:
        raise Reject("non_lossless_hex", "merkle_branches")
    clean_jobs = doc.get("clean_jobs")
    if not isinstance(clean_jobs, bool):
        raise Reject("bad_clean_jobs", repr(clean_jobs))
    e2 = doc.get("extranonce2_length")
    if isinstance(e2, bool) or not isinstance(e2, int) or not 0 <= e2 <= 32767:
        raise Reject("bad_extranonce2_length", repr(e2))
    lat_ms, lat_m = doc.get("lat_ms"), doc.get("lat_m")
    if lat_ms is not None and (isinstance(lat_ms, bool) or not isinstance(lat_ms, (int, float))):
        raise Reject("bad_latency", repr(lat_ms))
    if lat_m not in (None, "tcp", "app"):
        raise Reject("bad_latency", repr(lat_m))
    chain_family = doc.get("chain_family")
    if chain_family is not None and not isinstance(chain_family, str):
        raise Reject("bad_chain_family", repr(chain_family))

    coinbase1 = doc.get("coinbase1")
    values = (
        job_id,
        _hexfield(doc, "prev_hash", 64),
        _hexfield(doc, "coinbase1"),
        _hexfield(doc, "coinbase2"),
        branch_bytes,
        _u32(doc, "version"),
        _u32(doc, "nbits"),
        _u32(doc, "ntime"),
        clean_jobs,
        _hexfield(doc, "extranonce1"),
        e2,
        float(lat_ms) if lat_ms is not None else None,
        lat_m,
    )
    height = parse_bip34_height(coinbase1) or 0
    unknown = tuple(sorted(k for k in doc if k not in KNOWN_FIELDS))
    return Converted(raw, fmt, source, height, doc.get("height"), chain_family, values, values[7], 0, unknown,
                     str(doc.get("_id", "")))


def route_converted(c: Converted, tips):
    """The live collector's routing (collector/pgsink.route) with the Bitcoin tip at the (corrected) receive time."""
    return route(c.height, c.chain_family, tips.tip_at(c.received_at))


def is_btc(r) -> bool:
    return r is BTC or r.table == "templates"
