"""m2p: MongoDB -> Postgres + TimescaleDB backfill and verification.

    python -m m2p migrate [--from-day D] [--to-day D] [--until TS] [--workers N] [--create-index]
    python -m m2p verify  [--sample 10000] [--out verify.json]
    python -m m2p report  [--verify-json verify.json] [--out report.md]
    python -m m2p cleanup --yes        # drop the tool's bookkeeping schema after sign-off

Source: MONGO_URI (env only: it may hold credentials) and --mongo-db. Never point it at a live production database:
use a throwaway MongoDB restored from the backups.
Target: --pg-host/--pg-port/--pg-database/--pg-user or libpq's PGHOST/PGPORT/PGDATABASE/PGUSER; the password only via
PGPASSWORD or PGPASSFILE. Connection details are passed as keywords, never as a URL, and never logged with secrets.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import date, datetime, timezone

LOG = logging.getLogger("m2p")


def _day(s: str) -> date:
    return date.fromisoformat(s)


def _instant(s: str) -> datetime:
    dt = datetime.fromisoformat(s)
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _gap(s: str) -> tuple[int, int]:
    a, _, b = s.partition("-")
    return int(a), int(b or a)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="m2p", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--mongo-db", default=os.environ.get("MONGO_DB", "stratum-logger"))
    common.add_argument("--pg-host", default=None)
    common.add_argument("--pg-port", default=None)
    common.add_argument("--pg-database", default=None)
    common.add_argument("--pg-user", default=None)
    common.add_argument("--pg-sslmode", default=None)
    common.add_argument("--site", default=os.environ.get("M2P_SITE", "old-cluster"),
                        help="sources.site for the backfilled history (default: old-cluster)")
    common.add_argument("--from-day", type=_day, help="first UTC day (default: the first day with documents)")
    common.add_argument("--to-day", type=_day, help="last UTC day, inclusive (default: the last day with documents)")
    common.add_argument("--batch-size", type=int, default=5000, help="MongoDB cursor batch size")
    common.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("migrate", parents=[common], help="copy days (resumable: completed days are skipped)")
    m.add_argument("--until", type=_instant,
                   help="exclusive cut-off for receive times, e.g. T0 (naive = UTC). Days still being written are "
                        "always cut 2 minutes behind now")
    m.add_argument("--workers", type=int, default=1, help="days processed in parallel (processes)")
    m.add_argument("--create-index", action="store_true",
                   help="create an index on mining_notify.timestamp (throwaway restore only)")
    m.add_argument("--skip-blocks", action="store_true")
    m.add_argument("--skip-pools", action="store_true")
    m.add_argument("--blocks-overwrite", action="store_true",
                   help="update blocks already in Postgres (default: keep them; the new backend's rows win)")
    m.add_argument("--pools-overwrite", action="store_true", help="replace a non-empty pools table")

    v = sub.add_parser("verify", parents=[common], help="check the migrated days against MongoDB")
    v.add_argument("--sample", type=int, default=10_000, help="templates for the byte-exact round trip")
    v.add_argument("--seed", type=int, default=42)
    v.add_argument("--known-gap", type=_gap, action="append",
                   help="expected missing template heights, e.g. 876883-876903 (repeatable; replaces the default)")
    v.add_argument("--out", help="write the full result as JSON")

    r = sub.add_parser("report", parents=[common], help="summarize the migration (Markdown)")
    r.add_argument("--verify-json", help="include a verify --out result")
    r.add_argument("--out", help="write to a file instead of stdout")

    c = sub.add_parser("cleanup", parents=[common], help="drop the tool's bookkeeping schema")
    c.add_argument("--yes", action="store_true")
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    logging.getLogger("pymongo").setLevel(logging.WARNING)
    from .target import SCHEMA, connect_kwargs, describe
    pg_kw = connect_kwargs(args)
    mongo_uri = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
    LOG.info("%s", describe(pg_kw))

    if args.cmd == "migrate":
        from .migrate import run
        return run(args, pg_kw, mongo_uri)

    if args.cmd == "verify":
        from .source import Source
        from .verify import DEFAULT_KNOWN_GAPS, Verifier
        src = Source(mongo_uri, args.mongo_db, args.batch_size)
        ver = Verifier(src, pg_kw, args.site, args.sample, args.seed, tuple(args.known_gap or DEFAULT_KNOWN_GAPS))
        checks = ver.run(args.from_day, args.to_day)
        result = dict(site=args.site, checked_at=datetime.now(timezone.utc).isoformat(),
                      checks=[c.as_dict() for c in checks])
        for c in checks:
            print(f"{c.status:4}  {c.name}")
            print("      " + json.dumps(c.details, default=str)[:2000])
        status = "FAIL" if any(c.status == "FAIL" for c in checks) else (
            "WARN" if any(c.status == "WARN" for c in checks) else "PASS")
        result["status"] = status
        print(f"OVERALL: {status}")
        if args.out:
            with open(args.out, "w") as f:
                json.dump(result, f, indent=1, default=str)
        return 1 if status == "FAIL" else 0

    if args.cmd == "report":
        from .report import build
        vj = json.load(open(args.verify_json)) if args.verify_json else None
        text = build(pg_kw, args.site, vj)
        if args.out:
            with open(args.out, "w") as f:
                f.write(text + "\n")
        else:
            print(text)
        return 0

    if args.cmd == "cleanup":
        if not args.yes:
            print(f"would drop schema {SCHEMA} (the migration's bookkeeping); pass --yes")
            return 1
        import psycopg
        with psycopg.connect(**pg_kw, autocommit=True) as c:
            c.execute(f"DROP SCHEMA IF EXISTS {SCHEMA} CASCADE")
        print(f"dropped schema {SCHEMA}")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
