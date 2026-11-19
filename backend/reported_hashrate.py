"""Hashrate as pools report it, from a third-party pool-statistics site, stored in reported_hashrate
(db/migrations/20261119000005_reported_hashrate.sql). A claim each pool makes about itself, never a measurement of
ours: kept apart from block shares and anything else measured here (docs/methodology.md "Reported hashrate").

    python -m reported_hashrate

fetches the site's data file once and upserts every pool's hourly series. Off unless configured, all from env:

    REPORTED_HASHRATE_URL         the data file (JSON); "?t=<unix seconds>" is appended. Unset: exit 0, nothing done.
    REPORTED_HASHRATE_USER_AGENT  User-Agent header (optional)
    REPORTED_HASHRATE_REFERER     Referer header (optional)
    REPORTED_HASHRATE_SOURCE      the source label stored with every row (default: miningpoolstats)

The file: top-level `hashrate` (the site's network estimate, H/s) and `data`, one entry per pool with a stable `id`,
`url`, `hashrate_average_1h` and `history`: hourly points from `history_start` (unix seconds) every
`history_interval` seconds, delta-encoded (the first number is absolute, each later one the difference from the
previous number; strings such as "x" mark hours without a value, and the next number is still a difference from the
last number). Reconstructed, a pool's last point equals its `hashrate_average_1h`: the points are hourly averages.

Each point is stored at its time floored to the hour, so a later fetch overwrites the hours it covers again (the
site's latest values) instead of adding near-duplicates. Before writing anything the file must look sane: at least
MIN_POOLS pools, a positive network estimate, and the reconstructed last point within MAX_LAST_DEVIATION of
`hashrate_average_1h` for at least MIN_MATCHING of the pools that have both. Otherwise nothing is written and the
exit status is 1. One request per run, no retries: the schedule decides when to try again.

Connects like the backend (PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD, PG_SSLMODE, PG_SSLROOTCERT), as a
user in the stratum_backend role.
"""
from __future__ import annotations

import importlib.util
import json
import logging
import os
import pathlib
import sys
import time
import urllib.request
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

MIN_POOLS = 20
MIN_MATCHING = 0.90
MAX_LAST_DEVIATION = 0.01
TIMEOUT_S = 60
HOUR = 3600

logger = logging.getLogger("backend.reported_hashrate")


def _num(x: Any) -> Optional[float]:
    """A JSON number as float; anything else (null, a marker string, a bool) is no value."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    return float(x)


def reconstruct(history: List[Any]) -> List[Optional[float]]:
    """The delta-encoded series as values: the first number absolute, each later number added to the running value.
    Non-numbers are hours without a value (None); the running value carries across them."""
    out: List[Optional[float]] = []
    value: Optional[float] = None
    for x in history:
        d = _num(x)
        if d is None:
            out.append(None)
            continue
        value = d if value is None else value + d
        out.append(value)
    return out


def pool_points(entry: Dict[str, Any]) -> List[Tuple[int, float]]:
    """(hour as unix seconds, hashrate) for every hour of the entry's history that has a value."""
    start, interval = _num(entry.get("history_start")), _num(entry.get("history_interval"))
    if start is None or interval != HOUR:
        return []
    points = {}
    for i, v in enumerate(reconstruct(entry.get("history") or [])):
        if v is not None:
            t = int(start) + i * HOUR
            points[t - t % HOUR] = v
    return sorted(points.items())


def check(doc: Dict[str, Any]) -> Tuple[List[str], Dict[str, Any]]:
    """Sanity checks on the whole file. Returns (problems, counts); no problems = safe to write."""
    pools = doc.get("data") if isinstance(doc.get("data"), list) else []
    network = _num(doc.get("hashrate"))
    comparable = matching = 0
    for e in pools:
        series = reconstruct(e.get("history") or [])
        last, avg = (series[-1] if series else None), _num(e.get("hashrate_average_1h"))
        if last is None or avg is None or avg <= 0:
            continue
        comparable += 1
        if abs(last - avg) <= MAX_LAST_DEVIATION * avg:
            matching += 1
    counts = {"pools": len(pools), "comparable": comparable, "matching": matching, "network_hashrate": network}
    problems = []
    if len(pools) < MIN_POOLS:
        problems.append(f"{len(pools)} pools, fewer than {MIN_POOLS}")
    if network is None or network <= 0:
        problems.append(f"network hashrate {doc.get('hashrate')!r} is not positive")
    if comparable == 0 or matching < MIN_MATCHING * comparable:
        problems.append(f"last point within {MAX_LAST_DEVIATION:.0%} of the 1h average for {matching} of "
                        f"{comparable} pools, fewer than {MIN_MATCHING:.0%}")
    return problems, counts


def rows(doc: Dict[str, Any], source: str, fetched_at: datetime) -> List[Dict[str, Any]]:
    """Every pool's points as reported_hashrate rows."""
    network = float(doc["hashrate"])
    out = []
    for e in doc["data"]:
        if e.get("id") is None:
            continue
        for t, v in pool_points(e):
            out.append(dict(source=source, pool_key=str(e["id"]), at=datetime.fromtimestamp(t, tz=timezone.utc),
                            pool_url=e.get("url"), hashrate=v, network_hashrate=network, fetched_at=fetched_at))
    return out


def fetch(url: str, user_agent: Optional[str], referer: Optional[str], now: float) -> Dict[str, Any]:
    """One GET of the data file; no retries."""
    full = f"{url}{'&' if '?' in url else '?'}t={int(now)}"
    headers = {"Accept": "application/json, text/javascript, */*"}
    if user_agent:
        headers["User-Agent"] = user_agent
    if referer:
        headers["Referer"] = referer
    with urllib.request.urlopen(urllib.request.Request(full, headers=headers), timeout=TIMEOUT_S) as r:
        return json.loads(r.read())


def _postgres_store() -> Any:
    # integrations/__init__.py connects to the store and RabbitMQ at import; load the store module on its own.
    path = pathlib.Path(__file__).resolve().parent / "integrations" / "store.py"
    spec = importlib.util.spec_from_file_location("reported_hashrate_store", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PostgresStore.from_env()


def main(env: Optional[Dict[str, str]] = None, store: Any = None, fetcher=fetch, clock=time.time) -> int:
    env = os.environ if env is None else env
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr)
    url = env.get("REPORTED_HASHRATE_URL", "").strip()
    if not url:
        logger.info("Reported hashrate not configured (REPORTED_HASHRATE_URL unset): nothing to do")
        return 0
    source = env.get("REPORTED_HASHRATE_SOURCE", "").strip() or "miningpoolstats"
    now = clock()
    try:
        doc = fetcher(url, env.get("REPORTED_HASHRATE_USER_AGENT") or None, env.get("REPORTED_HASHRATE_REFERER") or None,
                      now)
    except Exception as e:   # the URL carries no credentials; the error names the status or the network failure
        logger.error("Reported hashrate fetch failed: %s", e)
        return 1
    if not isinstance(doc, dict):
        logger.error("Reported hashrate: the file is not a JSON object; nothing written")
        return 1
    problems, counts = check(doc)
    if problems:
        logger.error("Reported hashrate: the file failed its sanity checks, nothing written: %s (%s)",
                     "; ".join(problems), counts)
        return 1
    out = rows(doc, source, datetime.fromtimestamp(now, tz=timezone.utc))
    written = (store or _postgres_store()).upsert_reported_hashrate(out)
    logger.info("Reported hashrate (%s): %d pools in the file, %d with a comparable last point (%d match the 1h "
                "average), %d pools with points, %d rows upserted; network estimate %.4g H/s",
                source, counts["pools"], counts["comparable"], counts["matching"], len({r["pool_key"] for r in out}),
                written, counts["network_hashrate"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
