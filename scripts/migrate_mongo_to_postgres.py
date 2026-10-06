#!/usr/bin/env python3
"""One-time conversion of the legacy MongoDB data (`stratum-logger`) into the Postgres/TimescaleDB schema.

Collections:
  templates  Mongo `mining_notify` -> `templates`, loaded one UTC day at a time, compressed and
             count-verified per day. Progress lives in `migration_progress`, so a rerun resumes at
             the first day that is not recorded there.
  blocks     Mongo `blocks` -> `blocks` (same upsert as the backend's `upsert_block`).
  pools      Mongo `pools`  -> `pools`  (same DELETE + insert as the backend's `replace_pools`).

Cutover (`--before-hex-ns`): only Mongo templates strictly older than T are migrated. Use the first
timestamp the stream ingester wrote, before migrating anything:
    SELECT lpad(to_hex(min(ts_ns)), 16, '0') FROM templates;
Stream rows and migrated rows have different `mid`s for the same notification (the stream hashes
the RabbitMQ body, this script hashes the canonical JSON of the Mongo document), so overlapping
ranges would produce duplicates.

Credentials: pass connection strings via the environment (MONGO_URL, PG_URL) rather than flags so
they do not show up in `ps`. They are never logged. Use a read-only Mongo user, e.g.:
    use stratum-logger
    db.createUser({user: "migrate_ro", pwd: passwordPrompt(), roles: [{role: "read", db: "stratum-logger"}]})
The Postgres user must own `templates` (required by `compress_chunk`) and be able to create
`migration_progress`.

    pip install -r scripts/requirements-migrate.txt
    MONGO_URL=... PG_URL=... python scripts/migrate_mongo_to_postgres.py --before-hex-ns <T>
"""
import argparse
import datetime as dt
import hashlib
import json
import logging
import os
import sys

LEGACY_SITE = "us-ash-legacy"
KNOWN = {"_id", "timestamp", "pool_name", "height", "job_id", "prev_hash", "coinbase1", "coinbase2", "merkle_branches",
         "version", "nbits", "ntime", "clean_jobs", "extranonce1", "extranonce2_length", "lat_ms", "lat_m",
         "chain_family", "site", "connection_id", "mode", "account", "endpoint_ip"}
TEMPLATE_COLS = ["ts", "ts_ns", "mid", "doc_id", "pool", "connection_id", "site", "mode", "account", "endpoint_ip",
                 "height", "prev_hash", "job_id", "version", "nbits", "ntime", "clean_jobs", "coinbase1", "coinbase2",
                 "extranonce1", "extranonce2_length", "merkle_branches", "chain_family", "lat_ms", "lat_m", "extra"]
REQUIRED_TEXT = ["pool", "connection_id", "site", "mode", "prev_hash", "job_id", "version", "coinbase1", "coinbase2"]
BLOCK_COLUMNS = ["height", "block_hash", "timestamp", "coinbase_script_sig", "mining_pool", "analysis",
                 "transactions", "size", "weight", "version", "merkle_root", "bits", "nonce", "difficulty"]
JSON_COLUMNS = {"mining_pool", "analysis"}
MONGO_COLLECTIONS = {"templates": "mining_notify", "blocks": "blocks", "pools": "pools"}
PROGRESS_TABLE = "migration_progress"
INSERT_TEMPLATES = (f"INSERT INTO templates ({','.join(TEMPLATE_COLS)}) VALUES ({','.join(['%s'] * len(TEMPLATE_COLS))}) "
                    "ON CONFLICT (mid, ts) DO NOTHING")
EPOCH = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
NS_PER_DAY = 86_400 * 1_000_000_000
INT32 = (-2 ** 31, 2 ** 31 - 1)
LOG = logging.getLogger("migrate")


class CountMismatch(Exception):
    pass


class InvalidDocument(Exception):
    pass


def _dumps(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"), default=str)


def _json_safe(v):
    return json.loads(_dumps(v))


def _canonical(doc):
    d = {k: (str(v) if k == "_id" else v) for k, v in doc.items()}
    return _dumps(d).encode()


def _int_or_zero(v):
    if v is None:
        return 0
    try:
        return int(v)
    except (TypeError, ValueError):
        return v


def _or(v, default):
    return default if v is None else v


def doc_to_row(doc):
    """Same row as stream/src/serialize.ts#messageToTemplateRow for this document as the message body."""
    ts_ns = int(doc["timestamp"], 16)
    extra = {k: v for k, v in doc.items() if k not in KNOWN}
    cj = doc.get("clean_jobs")
    pool = _or(doc.get("pool_name"), "unknown")
    job_id = doc.get("job_id")
    return {
        "ts": EPOCH + dt.timedelta(milliseconds=ts_ns // 1_000_000), "ts_ns": ts_ns,
        "mid": hashlib.sha256(_canonical(doc)).digest()[:16],
        "doc_id": str(doc["_id"]) if doc.get("_id") is not None else None,
        "pool": pool, "connection_id": _or(doc.get("connection_id"), pool),
        "site": _or(doc.get("site"), LEGACY_SITE), "mode": _or(doc.get("mode"), "observe"),
        "account": doc.get("account"), "endpoint_ip": doc.get("endpoint_ip"),
        "height": _int_or_zero(doc.get("height")), "prev_hash": doc.get("prev_hash"),
        "job_id": None if job_id is None else str(job_id), "version": doc.get("version"),
        "nbits": doc.get("nbits"), "ntime": doc.get("ntime"),
        "clean_jobs": cj is True or cj == "true", "coinbase1": doc.get("coinbase1"), "coinbase2": doc.get("coinbase2"),
        "extranonce1": doc.get("extranonce1"), "extranonce2_length": _int_or_zero(doc.get("extranonce2_length")),
        "merkle_branches": list(_or(doc.get("merkle_branches"), [])), "chain_family": doc.get("chain_family"),
        "lat_ms": doc.get("lat_ms"), "lat_m": doc.get("lat_m"), "extra": _json_safe(extra) if extra else None,
    }


def _is_int32(v):
    return isinstance(v, int) and not isinstance(v, bool) and INT32[0] <= v <= INT32[1]


def template_row_problem(row):
    """First column Postgres would reject (mirrors stream/src/db.ts#templateRowProblem plus NUL checks), or None."""
    if not 0 <= row["ts_ns"] < 2 ** 63:
        return "ts_ns"
    for c in REQUIRED_TEXT:
        if not isinstance(row[c], str):
            return c
    if not _is_int32(row["height"]):
        return "height"
    if not _is_int32(row["extranonce2_length"]):
        return "extranonce2_length"
    if not all(isinstance(b, str) for b in row["merkle_branches"]):
        return "merkle_branches"
    lat = row["lat_ms"]
    if lat is not None and (isinstance(lat, bool) or not isinstance(lat, (int, float))):
        return "lat_ms"
    for c in TEMPLATE_COLS:
        v = row[c]
        if c == "extra":
            if v is not None and "\\u0000" in _dumps(v):
                return c
        elif isinstance(v, str) and "\x00" in v:
            return c
        elif isinstance(v, list) and any(isinstance(x, str) and "\x00" in x for x in v):
            return c
        elif v is not None and c in ("nbits", "ntime", "account", "endpoint_ip", "doc_id", "extranonce1",
                                     "chain_family", "lat_m") and not isinstance(v, str):
            return c
    return None


def checked_row(doc):
    doc_id = doc.get("_id")
    try:
        row = doc_to_row(doc)
    except (TypeError, ValueError, KeyError):
        raise InvalidDocument(f"document {doc_id} has invalid timestamp") from None
    problem = template_row_problem(row)
    if problem:
        raise InvalidDocument(f"document {doc_id} has invalid {problem}")
    return row


def normalize_hex(h):
    return format(int(h, 16), "016x")


def day_bounds_hex(day):
    start = dt.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
    end = start + dt.timedelta(days=1)
    to_hex = lambda t: format(int(t.timestamp()) * 1_000_000_000, "016x")  # noqa: E731
    return to_hex(start), to_hex(end)


def day_of_hex(h):
    return (EPOCH + dt.timedelta(days=int(h, 16) // NS_PER_DAY)).date().isoformat()


def next_day(day):
    return (dt.date.fromisoformat(day) + dt.timedelta(days=1)).isoformat()


def days_between(first, last):
    day = first
    while day <= last:
        yield day
        day = next_day(day)


def day_filter(day, before):
    lo, hi = day_bounds_hex(day)
    upper = min(hi, before)
    return {"timestamp": {"$gte": lo, "$lt": upper}} if lo < upper else None


def _utc(day):
    return dt.datetime.fromisoformat(day).replace(tzinfo=dt.timezone.utc)


def ensure_progress_table(pg):
    with pg.cursor() as cur:
        cur.execute(f"CREATE TABLE IF NOT EXISTS {PROGRESS_TABLE} "
                    "(day date PRIMARY KEY, mongo_count bigint NOT NULL, pg_count bigint NOT NULL)")


def recorded_days(pg):
    with pg.cursor() as cur:
        cur.execute(f"SELECT day::text FROM {PROGRESS_TABLE}")
        return {r[0] for r in cur.fetchall()}


def oldest_day(coll):
    for doc in coll.find({"timestamp": {"$gte": "0" * 16}}, {"timestamp": 1}).sort("timestamp", 1).limit(1):
        return day_of_hex(doc["timestamp"])
    return None


def pg_template_count(pg, flt):
    rng = flt["timestamp"]
    lo, hi = int(rng["$gte"], 16), int(rng["$lt"], 16)
    day = day_of_hex(rng["$gte"])
    with pg.cursor() as cur:
        cur.execute("SELECT count(*) FROM templates WHERE ts >= %s AND ts < %s AND ts_ns >= %s AND ts_ns < %s",
                    (_utc(day), _utc(next_day(day)), lo, hi))
        return cur.fetchone()[0]


def _template_params(row):
    from psycopg.types.json import Jsonb
    return [Jsonb(row[c], dumps=_dumps) if c == "extra" and row[c] is not None else row[c] for c in TEMPLATE_COLS]


def _insert_template_batch(pg, rows):
    with pg.transaction(), pg.cursor() as cur:
        cur.executemany(INSERT_TEMPLATES, [_template_params(r) for r in rows])


def load_day(coll, pg, day, before, batch):
    flt = day_filter(day, before)
    rows, streamed = [], 0
    for doc in coll.find(flt).batch_size(batch):
        rows.append(checked_row(doc))
        streamed += 1
        if len(rows) >= batch:
            _insert_template_batch(pg, rows)
            rows = []
    if rows:
        _insert_template_batch(pg, rows)
    if next_day(day) <= day_of_hex(before):
        with pg.cursor() as cur:
            cur.execute("SELECT compress_chunk(c, if_not_compressed => true) "
                        "FROM show_chunks('templates', older_than => %s::timestamptz) c", (_utc(next_day(day)),))
    mongo_count, pg_count = coll.count_documents(flt), pg_template_count(pg, flt)
    LOG.info("templates %s: streamed=%d mongo=%d pg=%d", day, streamed, mongo_count, pg_count)
    if mongo_count != pg_count:
        raise CountMismatch(f"templates {day}: mongo_count={mongo_count} pg_count={pg_count}")
    with pg.cursor() as cur:
        cur.execute(f"INSERT INTO {PROGRESS_TABLE} (day, mongo_count, pg_count) VALUES (%s, %s, %s) "
                    "ON CONFLICT (day) DO UPDATE SET mongo_count = EXCLUDED.mongo_count, pg_count = EXCLUDED.pg_count",
                    (day, mongo_count, pg_count))
    return mongo_count, pg_count


def migrate_templates(coll, pg, start_day, before_hex, batch, verify_only=False):
    """Loads (or with verify_only, only counts) every day from start_day through the day containing T.

    Returns [(day, mongo_count, pg_count)] for the days processed. Loading raises CountMismatch on the
    first day whose counts differ; verify_only returns all counts and leaves judging them to the caller.
    """
    before = normalize_hex(before_hex)
    done = set()
    if not verify_only:
        ensure_progress_table(pg)
        done = recorded_days(pg)
    results = []
    for day in days_between(start_day, day_of_hex(before)):
        flt = day_filter(day, before)
        if day in done or flt is None:
            continue
        if verify_only:
            counts = coll.count_documents(flt), pg_template_count(pg, flt)
            LOG.info("templates %s: mongo=%d pg=%d", day, *counts)
        else:
            counts = load_day(coll, pg, day, before, batch)
        results.append((day, *counts))
    return results


def block_doc_to_row(doc):
    d = dict(doc)
    if "mining_pool" not in d and "pool" in d:
        d["mining_pool"] = d["pool"]
    row = {c: d[c] for c in BLOCK_COLUMNS if c in d}
    ts = row.get("timestamp")
    if isinstance(ts, dt.datetime):
        row["timestamp"] = int((ts if ts.tzinfo else ts.replace(tzinfo=dt.timezone.utc)).timestamp())
    for c in JSON_COLUMNS & row.keys():
        if row[c] is not None:
            row[c] = _json_safe(row[c])
    return row


def block_upsert_statement(row):
    from psycopg.types.json import Jsonb
    cols = [c for c in BLOCK_COLUMNS if c in row]
    params = {c: (Jsonb(row[c]) if c in JSON_COLUMNS and row[c] is not None else row[c]) for c in cols}
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols if c != "block_hash")
    sql = (f"INSERT INTO blocks ({', '.join(cols)}) VALUES ({', '.join('%(' + c + ')s' for c in cols)}) "
           f"ON CONFLICT (block_hash) DO UPDATE SET {updates}")
    return sql, params


def _upsert_block_batch(pg, rows):
    with pg.transaction(), pg.cursor() as cur:
        for row in rows:
            cur.execute("DELETE FROM blocks WHERE height = %(height)s AND block_hash <> %(block_hash)s",
                        {"height": row["height"], "block_hash": row["block_hash"]})
            cur.execute(*block_upsert_statement(row))


def migrate_blocks(coll, pg, batch, verify_only=False):
    heights, rows = set(), []
    projection = {"height": 1} if verify_only else None
    for doc in coll.find({}, projection).batch_size(batch):
        heights.add(doc["height"])
        if verify_only:
            continue
        rows.append(block_doc_to_row(doc))
        if len(rows) >= batch:
            _upsert_block_batch(pg, rows)
            rows = []
    if rows:
        _upsert_block_batch(pg, rows)
    with pg.cursor() as cur:
        cur.execute("SELECT count(*) FROM blocks WHERE height = ANY(%s)", (sorted(heights),))
        pg_count = cur.fetchone()[0]
    LOG.info("blocks: mongo_heights=%d pg=%d", len(heights), pg_count)
    if pg_count != len(heights):
        raise CountMismatch(f"blocks: mongo_heights={len(heights)} pg_count={pg_count}")
    return len(heights), pg_count


def pool_doc_to_json(doc):
    return _json_safe({k: v for k, v in doc.items() if k != "_id"})


def migrate_pools(coll, pg, verify_only=False):
    from psycopg.types.json import Jsonb
    docs = [pool_doc_to_json(d) for d in coll.find({})]
    if not verify_only:
        with pg.transaction(), pg.cursor() as cur:
            cur.execute("DELETE FROM pools")
            for d in docs:
                cur.execute("INSERT INTO pools (name, tag, addresses, doc) VALUES (%s, %s, %s, %s)",
                            (d.get("name"), d.get("tag"), list(d.get("addresses") or []), Jsonb(d)))
    with pg.cursor() as cur:
        cur.execute("SELECT count(*) FROM pools")
        pg_count = cur.fetchone()[0]
    LOG.info("pools: mongo=%d pg=%d", len(docs), pg_count)
    if pg_count != len(docs):
        raise CountMismatch(f"pools: mongo_count={len(docs)} pg_count={pg_count}")
    return len(docs), pg_count


def warn_if_mongo_user_can_write(db):
    try:
        status = db.command("connectionStatus", showPrivileges=True)
    except Exception:  # noqa: BLE001 - informational only
        return
    roles = {r.get("role") for r in status.get("authInfo", {}).get("authenticatedUserRoles", [])}
    if roles - {"read"}:
        LOG.warning("Mongo user has roles beyond 'read' (%s); a read-only user is recommended", ", ".join(sorted(roles)))


def build_parser():
    p = argparse.ArgumentParser(description="One-time MongoDB -> Postgres/TimescaleDB conversion. "
                                            "Prefer the MONGO_URL and PG_URL environment variables over the URL flags.")
    p.add_argument("--mongo-url", default=os.environ.get("MONGO_URL"), help="Mongo URL of a read-only user (env MONGO_URL)")
    p.add_argument("--mongo-db", default="stratum-logger")
    p.add_argument("--pg-url", default=os.environ.get("PG_URL"), help="Postgres URL (env PG_URL)")
    p.add_argument("--before-hex-ns", help="Cutover T: migrate templates with timestamp < T (hex ns); required for templates")
    p.add_argument("--start-day", help="YYYY-MM-DD; default: day of the oldest Mongo template")
    p.add_argument("--collections", default="templates,blocks,pools")
    p.add_argument("--batch", type=int, default=5000)
    p.add_argument("--verify-only", action="store_true", help="Only compare counts; write nothing")
    return p


def main(argv=None):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = build_parser()
    args = parser.parse_args(argv)
    collections = [c.strip() for c in args.collections.split(",") if c.strip()]
    unknown = set(collections) - MONGO_COLLECTIONS.keys()
    if unknown:
        parser.error(f"unknown collections: {', '.join(sorted(unknown))}")
    if not args.mongo_url or not args.pg_url:
        parser.error("Mongo and Postgres URLs are required (MONGO_URL / PG_URL or --mongo-url / --pg-url)")
    if "templates" in collections and not args.before_hex_ns:
        parser.error("--before-hex-ns is required when migrating templates")

    import psycopg
    import pymongo

    mongo = pymongo.MongoClient(args.mongo_url)
    db = mongo[args.mongo_db]
    warn_if_mongo_user_can_write(db)
    failures = []
    try:
        with psycopg.connect(args.pg_url, autocommit=True) as pg:
            for name in collections:
                coll = db[MONGO_COLLECTIONS[name]]
                if name == "templates":
                    start = args.start_day or oldest_day(coll)
                    if start is None:
                        LOG.info("templates: Mongo collection is empty")
                        continue
                    results = migrate_templates(coll, pg, start, args.before_hex_ns, args.batch, args.verify_only)
                    failures += [f"templates {d}: mongo_count={m} pg_count={c}" for d, m, c in results if m != c]
                    LOG.info("templates: %d days processed, %d documents", len(results), sum(r[1] for r in results))
                elif name == "blocks":
                    migrate_blocks(coll, pg, args.batch, args.verify_only)
                else:
                    migrate_pools(coll, pg, args.verify_only)
    except (CountMismatch, InvalidDocument) as e:
        failures.append(str(e))
    finally:
        mongo.close()
    for f in failures:
        LOG.error("FAILED %s", f)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
