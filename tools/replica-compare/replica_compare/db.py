"""Read templates for a window from a database with the stratum-work schema (db/migrations). Read-only."""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Optional

from .analyze import Template

QUERY = """
SELECT s.name, s.replica, t.received_at, t.height, t.job_id, t.prev_hash, t.coinbase1, t.coinbase2,
       t.merkle_branches, t.version, t.nbits, t.ntime, t.clean_jobs, t.extranonce1, t.extranonce2_length, t.chain
FROM (
    SELECT received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits,
           ntime, clean_jobs, extranonce1, extranonce2_length, 'btc'::text AS chain
    FROM templates WHERE received_at >= %(since)s AND received_at < %(until)s
    UNION ALL
    SELECT received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits,
           ntime, clean_jobs, extranonce1, extranonce2_length, chain::text
    FROM templates_other WHERE received_at >= %(since)s AND received_at < %(until)s
) t
JOIN sources s ON s.id = t.source_id
WHERE (%(site)s::text IS NULL OR s.site = %(site)s) AND s.replica = ANY(%(replicas)s)
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
