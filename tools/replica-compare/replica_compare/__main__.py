"""replica-compare: how two collector replicas (connections) of one pool see the same jobs.

    python -m replica_compare --last 3h [--site S] [--pool NAME ...] [--replicas a,b] [--out report.md] [--json r.json]
    python -m replica_compare --since 2026-01-01T00:00:00Z --until 2026-01-01T03:00:00Z

Postgres: --pg-host/--pg-port/--pg-database/--pg-user/--pg-sslmode or libpq's PGHOST/PGPORT/PGDATABASE/PGUSER/
PGSSLMODE; the password only via PGPASSWORD or PGPASSFILE. Read-only: any role that can SELECT templates,
sources and bitcoin_parents (e.g. stratum_backend or stratum_web). If the database has template_dedup_report, its
per-pool, per-day, per-site summary of the read path's de-duplication is included (all sites; --site doesn't filter it). The output holds counts, shares, offsets and byte
positions only, never coinbase, extranonce or job id values.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone

from .analyze import analyze_pool
from .report import render


def _instant(s: str) -> datetime:
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _duration(s: str) -> timedelta:
    m = re.fullmatch(r"(\d+(?:\.\d+)?)([smhd])", s)
    if not m:
        raise argparse.ArgumentTypeError("use e.g. 90m, 3h, 1d")
    return timedelta(seconds=float(m[1]) * {"s": 1, "m": 60, "h": 3600, "d": 86400}[m[2]])


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="replica_compare", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    w = p.add_mutually_exclusive_group(required=True)
    w.add_argument("--last", type=_duration, help="window ending now (or at --until), e.g. 3h")
    w.add_argument("--since", type=_instant, help="window start (naive = UTC)")
    p.add_argument("--until", type=_instant, help="window end, exclusive (default: now)")
    p.add_argument("--site", help="only sources at this site")
    p.add_argument("--pool", action="append", dest="pools", help="only this sources.name (repeatable)")
    p.add_argument("--replicas", default="a,b", help="the two replicas to compare (default: a,b)")
    p.add_argument("--max-offset", type=float, default=2.0,
                   help="seconds: paired templates are at most this far apart (default: 2)")
    p.add_argument("--tie-ms", type=float, default=0.0,
                   help="first-seen offsets at most this many ms count as a tie (default: 0)")
    p.add_argument("--out", help="write the Markdown report here (default: stdout)")
    p.add_argument("--json", dest="json_out", help="write the full result as JSON here")
    for opt in ("host", "port", "database", "user", "sslmode"):
        p.add_argument(f"--pg-{opt}")
    return p


def run(by_pool: dict, since: datetime, until: datetime, replicas: tuple[str, str], max_offset: float,
        tie_ms: float = 0.0, site=None, dedup=None) -> dict:
    """dedup: rows of the database's template_dedup_report for the window (None: not available)."""
    return {"meta": {"since": since.isoformat(), "until": until.isoformat(), "replicas": list(replicas),
                     "site": site, "max_offset_s": max_offset, "tie_ms": tie_ms},
            "pools": {name: analyze_pool(rows, replicas, max_offset, tie_ms) for name, rows in sorted(by_pool.items())},
            "dedup": dedup}


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    replicas = tuple(r.strip() for r in args.replicas.split(","))
    if len(replicas) != 2 or not all(replicas) or replicas[0] == replicas[1]:
        print("--replicas takes two different names, e.g. a,b", file=sys.stderr)
        return 2
    until = args.until or datetime.now(timezone.utc)
    since = args.since or until - args.last
    import psycopg  # only needed against a database; the analysis itself has no dependencies

    from .db import connect_kwargs, fetch, fetch_dedup_report
    with psycopg.connect(**connect_kwargs(args)) as conn:
        conn.read_only = True
        by_pool = fetch(conn, since, until, list(replicas), args.site, args.pools)
        dedup = fetch_dedup_report(conn, since, until, args.pools)
    result = run(by_pool, since, until, replicas, args.max_offset, args.tie_ms, args.site, dedup)
    md = render(result)
    if args.out:
        with open(args.out, "w") as f:
            f.write(md + "\n")
    else:
        print(md)
    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump(result, f, indent=2, default=str)
    return 0


if __name__ == "__main__":
    sys.exit(main())
