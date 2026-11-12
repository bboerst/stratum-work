"""Builders for synthetic mining_notify / blocks documents (shared by the unit tests and the e2e fixture)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

UTC = timezone.utc


def coinbase1(height=None, raw_script: bytes | None = None, tag: bytes = b"/m2p-test/") -> str:
    """A coinbase1 with a BIP34 height push (minimal CScriptNum), or with an arbitrary scriptSig start."""
    if raw_script is None:
        n = height.to_bytes((height.bit_length() + 8) // 8, "little")   # leaves room for the sign bit
        raw_script = bytes([len(n)]) + n
    script = raw_script + tag + b"\x00" * 8
    return ("01000000" + "01" + "00" * 32 + "ffffffff" + format(len(script) + 8, "02x") + script.hex())


def hex_ts(dt: datetime) -> str:
    us = int((dt - datetime(1970, 1, 1, tzinfo=UTC)) / timedelta(microseconds=1))
    return format(us * 1000 + 123, "016x")   # + a sub-µs remainder, as time.time_ns() has


def iso_naive(dt: datetime) -> str:
    return dt.astimezone(UTC).replace(tzinfo=None).isoformat()


def doc(_id, ts, height=975_500, source="PoolA", job_id="j1", ntime: datetime | None = None, **over):
    nt = ntime or datetime(2026, 11, 12, 6, 0, tzinfo=UTC)
    d = {
        "_id": _id, "timestamp": ts, "pool_name": source, "height": height, "job_id": job_id,
        "prev_hash": "11" * 32, "coinbase1": coinbase1(height), "coinbase2": "ffffffff" + "00" * 4,
        "merkle_branches": ["aa" * 32, "bb" * 32], "version": "20000000", "nbits": "1701e5ac",
        "ntime": format(int(nt.timestamp()), "08x"), "clean_jobs": True, "extranonce1": "abcd",
        "extranonce2_length": 8, "lat_ms": 31.1805, "lat_m": "tcp",
    }
    d.update(over)
    return d


def block(height, t: datetime, block_hash=None, **over):
    b = {"height": height, "block_hash": block_hash or format(height, "064x"), "timestamp": int(t.timestamp()),
         "coinbase_script_sig": "03" + height.to_bytes(3, "little").hex() + "00",
         "mining_pool": {"id": 7, "name": "Example", "slug": "example"}, "analysis": {"pool_identification": {"ok": True}}}
    b.update(over)
    return b
