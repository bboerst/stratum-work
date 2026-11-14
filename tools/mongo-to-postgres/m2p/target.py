"""Writing to Postgres: the tool's own bookkeeping schema, per-day loads, blocks and pools.

Bookkeeping lives in a separate schema, `mongo_to_postgres`, created by the tool (not by the app's migrations: it's
state of a one-off job, and `m2p cleanup` drops it once the backfill is signed off). Each day is loaded in **one
transaction** together with its progress row, so a day is either fully loaded and recorded, or not at all: a crash
or Ctrl-C at any point leaves nothing to clean up, and a re-run simply redoes the unfinished days.
"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import date, datetime, timedelta
from typing import Iterable, Optional

import psycopg

from .shared import COLUMNS, store

LOG = logging.getLogger("m2p.target")
SCHEMA = "mongo_to_postgres"

# templates columns in COPY order (live COLUMNS plus the migration-only offset), and their types for binary COPY
TEMPLATE_COLS = (COLUMNS[0], "received_at_offset_s") + COLUMNS[1:]
OTHER_COLS = TEMPLATE_COLS + ("chain", "reason")
TEMPLATE_TYPES = ["timestamptz", "int4", "int2", "int4", "text", "bytea", "bytea", "bytea", "bytea", "int8", "int8",
                  "int8", "bool", "bytea", "int2", "float4", "text"]   # enums travel as their label in binary COPY
OTHER_TYPES = TEMPLATE_TYPES + ["text", "text"]

DDL = f"""
CREATE SCHEMA IF NOT EXISTS {SCHEMA};
CREATE TABLE IF NOT EXISTS {SCHEMA}.days (
    site            text        NOT NULL,
    day             date        NOT NULL,
    until           timestamptz,             -- documents recorded at/after this were excluded (NULL: the whole day)
    mongo_docs      integer     NOT NULL,
    templates       integer     NOT NULL,
    templates_other integer     NOT NULL,
    duplicates      integer     NOT NULL,
    rejected        integer     NOT NULL,
    seconds         real        NOT NULL,
    finished_at     timestamptz NOT NULL DEFAULT now(),
    stats           jsonb       NOT NULL DEFAULT '{{}}',
    PRIMARY KEY (site, day)
);
CREATE TABLE IF NOT EXISTS {SCHEMA}.day_sources (
    site text NOT NULL, day date NOT NULL, source text NOT NULL,
    mongo_docs integer NOT NULL, templates integer NOT NULL, templates_other integer NOT NULL,
    duplicates integer NOT NULL, rejected integer NOT NULL,
    PRIMARY KEY (site, day, source)
);
CREATE TABLE IF NOT EXISTS {SCHEMA}.tz_findings (
    site text NOT NULL, day date NOT NULL, height integer NOT NULL,
    offset_s integer NOT NULL, count integer NOT NULL, corrected boolean NOT NULL, evidence jsonb NOT NULL,
    PRIMARY KEY (site, day, height)
);
CREATE TABLE IF NOT EXISTS {SCHEMA}.rejected (
    site text NOT NULL, day date NOT NULL, mongo_id text NOT NULL, source text, reason text NOT NULL,
    detail text, doc jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS {SCHEMA}.duplicates (
    site text NOT NULL, day date NOT NULL, kept_id text NOT NULL, dropped_id text NOT NULL, identical boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS rejected_day ON {SCHEMA}.rejected (site, day);
"""


def connect_kwargs(args) -> dict:
    """Keyword arguments, never a URL, so errors can't echo a password. Unset values fall back to libpq's own
    environment (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD / PGPASSFILE, PGSSLMODE)."""
    # TimeZone=UTC: day boundaries (date -> timestamptz casts) are UTC days, whatever the server default is.
    kw = dict(application_name="stratum-work-mongo-to-postgres", connect_timeout=10, options="-c TimeZone=UTC")
    for key, val in (("host", args.pg_host), ("port", args.pg_port), ("dbname", args.pg_database),
                     ("user", args.pg_user), ("sslmode", args.pg_sslmode)):
        if val:
            kw[key] = val
    return kw


def describe(kw: dict) -> str:
    return "postgres {}:{}/{} as {}".format(kw.get("host") or os.environ.get("PGHOST", "(default)"),
                                            kw.get("port") or os.environ.get("PGPORT", "5432"),
                                            kw.get("dbname") or os.environ.get("PGDATABASE", "(default)"),
                                            kw.get("user") or os.environ.get("PGUSER", "(default)"))


def raw_day_bounds(d: date, until: Optional[datetime] = None) -> tuple[datetime, datetime]:
    from .convert import day_start
    start, end = day_start(d), day_start(d + timedelta(days=1))
    return start, min(end, until) if until else end


# SQL for "a row's recorded UTC day" (received_at + offset = as recorded) and a chunk-prunable outer bound
# (offsets are within -7 h .. 0, so received_at is within a day of the recorded time either way).
RAW_DAY_FILTER = """t.received_at >= %(lo)s::date - 1 AND t.received_at < %(hi)s::date + 2
    AND (t.received_at + make_interval(secs => t.received_at_offset_s)) >= %(lo)s
    AND (t.received_at + make_interval(secs => t.received_at_offset_s)) < (%(hi)s::date + 1)"""


class Target:
    def __init__(self, kw: dict, site: str):
        self.kw = kw
        self.site = site
        self.conn = psycopg.connect(**kw)
        self._meta = psycopg.connect(**kw, autocommit=True)   # sources upserts: committed at once, never held
        self._source_ids: dict[str, int] = {}

    def close(self):
        for c in (self.conn, self._meta):
            try:
                c.close()
            except Exception:
                pass

    def setup(self) -> None:
        with self._meta.cursor() as cur:
            cur.execute(DDL)
            for t in ("templates", "templates_other", "sources", "blocks", "pools"):
                cur.execute("SELECT to_regclass(%s)", (f"public.{t}",))
                if cur.fetchone()[0] is None:
                    raise SystemExit(f"table {t} is missing: run the dbmate migrations (db/migrations) first")

    # ── progress ────────────────────────────────────────────────────────────────────────────────────────
    def done_days(self) -> dict[date, Optional[datetime]]:
        rows = self._meta.execute(f"SELECT day, until FROM {SCHEMA}.days WHERE site = %s", (self.site,)).fetchall()
        return {d: u for d, u in rows}

    # ── sources ─────────────────────────────────────────────────────────────────────────────────────────
    def source_ids(self, names_first_seen: dict[str, datetime]) -> dict[str, int]:
        missing = sorted(n for n in names_first_seen if n not in self._source_ids)
        with self._meta.cursor() as cur:
            for name in missing:   # sorted: concurrent workers take row locks in the same order
                cur.execute("""INSERT INTO sources (name, site, first_seen_at) VALUES (%s, %s, %s)
                               ON CONFLICT (name, site, replica) DO NOTHING""", (name, self.site, names_first_seen[name]))
            for name, first in sorted(names_first_seen.items()):
                cur.execute("""UPDATE sources SET first_seen_at = LEAST(first_seen_at, %s)
                               WHERE name = %s AND site = %s AND replica = 'a' RETURNING id""", (first, name, self.site))
                self._source_ids[name] = cur.fetchone()[0]
        return {n: self._source_ids[n] for n in names_first_seen}

    # ── one day ─────────────────────────────────────────────────────────────────────────────────────────
    def write_day(self, d: date, until: Optional[datetime], btc_rows: list, other_rows: list, rejected: list,
                  duplicates: list, findings: list, per_source: dict, summary: dict, started: float, redo: bool) -> float:
        """Load one day and record it, atomically. Returns the day's total seconds (since `started`, monotonic)."""
        t_copy = time.monotonic()
        with self.conn.transaction(), self.conn.cursor() as cur:
            if redo:
                self._delete_day(cur, d)
            with cur.copy(f"COPY templates ({', '.join(TEMPLATE_COLS)}) FROM STDIN (FORMAT BINARY)") as cp:
                cp.set_types(TEMPLATE_TYPES)
                for r in btc_rows:
                    cp.write_row(r)
            with cur.copy(f"COPY templates_other ({', '.join(OTHER_COLS)}) FROM STDIN (FORMAT BINARY)") as cp:
                cp.set_types(OTHER_TYPES)
                for r in other_rows:
                    cp.write_row(r)
            if rejected:
                with cur.copy(f"COPY {SCHEMA}.rejected (site, day, mongo_id, source, reason, detail, doc) FROM STDIN") as cp:
                    for r in rejected:
                        cp.write_row((self.site, d) + r)
            if duplicates:
                with cur.copy(f"COPY {SCHEMA}.duplicates (site, day, kept_id, dropped_id, identical) FROM STDIN") as cp:
                    for r in duplicates:
                        cp.write_row((self.site, d) + r)
            for f in findings:
                cur.execute(f"""INSERT INTO {SCHEMA}.tz_findings (site, day, height, offset_s, count, corrected, evidence)
                                VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                            (self.site, d, f.height, f.offset_s, f.count, f.corrected, json.dumps(f.as_dict())))
            for src, s in sorted(per_source.items()):
                cur.execute(f"""INSERT INTO {SCHEMA}.day_sources VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                            (self.site, d, src, s["mongo_docs"], s["templates"], s["templates_other"],
                             s["duplicates"], s["rejected"]))
            summary["seconds_copy"] = round(time.monotonic() - t_copy, 3)
            seconds = time.monotonic() - started
            cur.execute(f"""INSERT INTO {SCHEMA}.days (site, day, until, mongo_docs, templates, templates_other, duplicates,
                                                       rejected, seconds, stats)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                        (self.site, d, until, summary["mongo_docs"], len(btc_rows), len(other_rows),
                         summary["duplicates"], len(rejected), seconds, json.dumps(summary, default=str)))
        return seconds

    def _delete_day(self, cur, d: date) -> None:
        """Remove everything a previous run loaded for day d (same site), inside the caller's transaction."""
        p = dict(site=self.site, lo=d, hi=d)
        for table in ("templates", "templates_other"):
            cur.execute(f"""DELETE FROM {table} t USING sources s
                            WHERE t.source_id = s.id AND s.site = %(site)s AND {RAW_DAY_FILTER}""", p)
        for table in ("days", "day_sources", "tz_findings", "rejected", "duplicates"):
            cur.execute(f"DELETE FROM {SCHEMA}.{table} WHERE site = %s AND day = %s", (self.site, d))

    # ── blocks and pools ────────────────────────────────────────────────────────────────────────────────
    def load_blocks(self, docs: Iterable[dict], overwrite: bool) -> dict:
        """Blocks, de-duplicated on block_hash (the newest MongoDB document wins), in the backend's row shape
        (backend/integrations/store.PostgresStore._block_params). Existing rows are kept unless overwrite."""
        kept: dict[str, dict] = {}
        dups, dup_differs, bad = 0, 0, []
        for doc in docs:   # sorted by _id ascending: later documents replace earlier ones
            h = doc.get("block_hash")
            if h in kept:
                dups += 1
                a = {k: v for k, v in kept[h].items() if k != "_id"}
                b = {k: v for k, v in doc.items() if k != "_id"}
                dup_differs += a != b
            kept[h] = doc
        params = []
        for doc in kept.values():
            try:
                params.append(store.PostgresStore._block_params(None, doc, seen_now=False))
            except (KeyError, TypeError, ValueError) as exc:
                bad.append({"_id": str(doc.get("_id")), "error": str(exc)[:200]})
        cols = ("block_hash", "height", "block_time", "seen_at", "coinbase_script_sig", "pool_id", "mining_pool", "analysis")
        conflict = ("DO UPDATE SET height = EXCLUDED.height, block_time = EXCLUDED.block_time, "
                    "coinbase_script_sig = EXCLUDED.coinbase_script_sig, pool_id = EXCLUDED.pool_id, "
                    "mining_pool = EXCLUDED.mining_pool, analysis = EXCLUDED.analysis") if overwrite else "DO NOTHING"
        with self.conn.transaction(), self.conn.cursor() as cur:
            cur.execute("CREATE TEMP TABLE m2p_blocks (LIKE blocks INCLUDING DEFAULTS) ON COMMIT DROP")
            with cur.copy(f"COPY m2p_blocks ({', '.join(cols)}) FROM STDIN") as cp:
                for p in params:
                    cp.write_row([p[c] for c in cols])
            cur.execute(f"""INSERT INTO blocks ({', '.join(cols)}) SELECT {', '.join(cols)} FROM m2p_blocks
                            ON CONFLICT (block_hash) {conflict}""")
            written = cur.rowcount
        return dict(mongo_docs=len(kept) + dups, distinct=len(kept), duplicates=dups,
                    duplicates_differing=dup_differs, rejected=bad, written=written,
                    already_present_kept=0 if overwrite else len(params) - written)

    def load_pools(self, pools: list[dict], overwrite: bool) -> dict:
        n = self._meta.execute("SELECT count(*) FROM pools").fetchone()[0]
        if n and not overwrite:
            return dict(mongo_docs=len(pools), written=0, skipped=f"pools already has {n} rows (use --pools-overwrite)")
        st = store.PostgresStore(self.kw)   # the backend's own replace_pools: full definition, same columns
        st.replace_pools(pools)
        st._conn.close()
        return dict(mongo_docs=len(pools), written=self._meta.execute("SELECT count(*) FROM pools").fetchone()[0])
