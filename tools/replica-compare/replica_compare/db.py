"""Read templates for a window from a database with the stratum-work schema (db/migrations). Read-only."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Optional

from .analyze import Template

QUERY = """
SELECT s.name, s.replica, t.received_at, t.height, t.job_id, t.prev_hash, t.coinbase1, t.coinbase2,
       t.merkle_branches, t.version, t.nbits, t.ntime, t.clean_jobs, t.extranonce1, t.extranonce2_length,
       -- judged at read time, as the web's other-chains view: built on a block we know, or not
       CASE WHEN EXISTS (SELECT 1 FROM bitcoin_parents p WHERE p.prev_hash = t.prev_hash) THEN 'btc' ELSE 'unknown' END
FROM templates t
JOIN sources s ON s.id = t.source_id
WHERE t.received_at >= %(since)s AND t.received_at < %(until)s
  AND (%(site)s::text IS NULL OR s.site = %(site)s) AND s.replica = ANY(%(replicas)s)
  AND (%(pools)s::text[] IS NULL OR s.name = ANY(%(pools)s))
ORDER BY s.name, t.received_at
"""


def connect_kwargs(args) -> dict:
    """Keyword arguments, never a URL, so errors can't echo a password. Unset values fall back to libpq's
    environment (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD / PGPASSFILE, PGSSLMODE)."""
    kw = dict(application_name="stratum-work-replica-compare", connect_timeout=10, options="-c TimeZone=UTC")
    for k, v in (("host", args.pg_host), ("port", args.pg_port), ("dbname", args.pg_database),
                 ("user", args.pg_user), ("sslmode", args.pg_sslmode)):
        if v:
            kw[k] = v
    return kw


def fetch(conn, since: datetime, until: datetime, replicas: list[str], site: Optional[str] = None,
          pools: Optional[list[str]] = None) -> dict[str, list[Template]]:
    by_pool: dict[str, list[Template]] = defaultdict(list)
    with conn.cursor() as cur:
        cur.execute(QUERY, {"since": since, "until": until, "site": site, "replicas": replicas,
                            "pools": pools or None})
        for (name, replica, received_at, height, job_id, prev_hash, cb1, cb2, merkle, version, nbits, ntime, clean,
             en1, en2len, chain) in cur:
            by_pool[name].append(Template(replica, received_at, height, job_id, bytes(prev_hash), bytes(cb1),
                                          bytes(cb2), bytes(merkle), version, nbits, ntime, clean, bytes(en1),
                                          en2len, chain))
    return dict(by_pool)


DEDUP_COLUMNS = ("day", "pool", "site", "rows", "primary_rows", "secondary_rows", "secondary_hidden",
                 "secondary_shown", "extra_copies", "near_misses", "near_miss_ntime_1s", "near_miss_ntime_2s",
                 "near_miss_ntime_3s", "near_miss_ntime_4_10s", "near_miss_ntime_over_10s", "gap_fills",
                 "first_seen_gains", "gain_ms_p50", "gain_ms_p95", "gain_ms_max")
# One stream per pool (20261116200001_one_stream_per_pool.sql): read when the database has them, None otherwise.
DEDUP_COLUMNS_OPTIONAL = ("exact_copies", "secondary_stream")


def fetch_dedup_report(conn, since: datetime, until: datetime, pools: Optional[list[str]] = None) -> Optional[list[dict]]:
    """The database's template_dedup_report (db/migrations/20261115000001_templates_dedup.sql) for the window: what
    the read path's de-duplication does per UTC day, pool and site (site None = the pool's total). None if the
    database doesn't have the function yet. Counts and times only."""
    with conn.cursor() as cur:
        cur.execute("SELECT to_regprocedure('template_dedup_report(timestamptz, timestamptz)') IS NOT NULL")
        if not cur.fetchone()[0]:
            return None
        cur.execute("SELECT * FROM template_dedup_report(%(since)s, %(until)s)"
                    " WHERE %(pools)s::text[] IS NULL OR pool = ANY(%(pools)s)",
                    {"since": since, "until": until, "pools": pools or None})
        names = [d.name for d in cur.description]
        out = []
        for row in cur:
            got = dict(zip(names, row))
            out.append({k: (got[k].isoformat() if k == "day" else got.get(k))
                        for k in DEDUP_COLUMNS + DEDUP_COLUMNS_OPTIONAL})
        return out

