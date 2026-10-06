import json
import logging
import os
import threading

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

LOG = logging.getLogger("backend.postgres")

TRUE_VALUES = {"1", "true", "t", "yes", "y", "on"}
FALSE_VALUES = {"0", "false", "f", "no", "n", "off"}


def parse_enabled(value):
    v = str(value).strip().lower()
    if v in TRUE_VALUES:
        return True
    if v in FALSE_VALUES:
        return False
    LOG.error("Invalid value for ENABLE_HISTORICAL_DATA: %s. Defaulting to True.", value)
    return True


DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://stratum:stratum@localhost:5432/stratum")
ENABLED = parse_enabled(os.getenv("ENABLE_HISTORICAL_DATA", "true"))
LEGACY_SITE = "us-ash-legacy"
BLOCK_COLUMNS = ["height", "block_hash", "timestamp", "coinbase_script_sig", "mining_pool", "analysis",
                 "transactions", "size", "weight", "version", "merkle_root", "bits", "nonce", "difficulty"]
JSON_COLUMNS = {"mining_pool", "analysis"}

_conn = None
# One shared connection is used by several worker threads; the lock keeps
# multi-statement transactions from interleaving with other threads' queries.
_lock = threading.RLock()


def connect():
    global _conn
    if not ENABLED:
        LOG.info("Historical data disabled; Postgres not connected")
        return None
    with _lock:
        try:
            _conn = psycopg.connect(DATABASE_URL, autocommit=True, row_factory=dict_row)
            LOG.info("Connected to Postgres")
        except Exception as e:
            LOG.error("Error connecting to Postgres: %s", e)
            _conn = None
        return _conn


def is_enabled():
    return ENABLED


def _db():
    if not ENABLED:
        raise RuntimeError("Historical data disabled")
    if _conn is None or _conn.closed:
        connect()
    if _conn is None:
        raise RuntimeError("Postgres not connected")
    return _conn


def block_upsert_statement(doc):
    cols = [c for c in BLOCK_COLUMNS if c in doc]
    params = {c: (Jsonb(doc[c]) if c in JSON_COLUMNS and doc[c] is not None else doc[c]) for c in cols}
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in cols if c != "block_hash")
    sql = (f"INSERT INTO blocks ({', '.join(cols)}) VALUES ({', '.join('%(' + c + ')s' for c in cols)}) "
           f"ON CONFLICT (block_hash) DO UPDATE SET {updates}")
    return sql, params


def upsert_block(doc):
    if not ENABLED:
        return
    sql, params = block_upsert_statement(doc)
    with _lock:
        conn = _db()
        with conn.transaction(), conn.cursor() as cur:
            cur.execute("DELETE FROM blocks WHERE height = %(height)s AND block_hash <> %(block_hash)s",
                        {"height": doc["height"], "block_hash": doc["block_hash"]})
            cur.execute(sql, params)


def _fetchall(sql, params=None):
    with _lock, _db().cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def _fetchone(sql, params=None):
    with _lock, _db().cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()


def list_block_hashes():
    return _fetchall("SELECT block_hash, height FROM blocks ORDER BY height DESC")


def highest_block():
    return _fetchone("SELECT * FROM blocks ORDER BY height DESC LIMIT 1")


def lowest_block():
    return _fetchone("SELECT * FROM blocks ORDER BY height ASC LIMIT 1")


def heights_between(min_h, max_h_exclusive):
    rows = _fetchall("SELECT height FROM blocks WHERE height >= %s AND height < %s", (min_h, max_h_exclusive))
    return [r["height"] for r in rows]


def get_block(height):
    return _fetchone("SELECT * FROM blocks WHERE height = %s", (height,))


def replace_pools(pool_docs):
    if not ENABLED:
        return
    with _lock:
        conn = _db()
        with conn.transaction(), conn.cursor() as cur:
            cur.execute("DELETE FROM pools")
            for d in pool_docs:
                cur.execute("INSERT INTO pools (name, tag, addresses, doc) VALUES (%s, %s, %s, %s)",
                            (d.get("name"), d.get("tag"), list(d.get("addresses") or []), Jsonb(d)))


def list_pools():
    return [r["doc"] for r in _fetchall("SELECT doc FROM pools ORDER BY id")]


def row_to_template_doc(r):
    doc = {}
    if r.get("doc_id") is not None:
        doc["_id"] = r["doc_id"]
    doc["timestamp"] = format(int(r["ts_ns"]), "x")
    doc.update({"pool_name": r["pool"], "height": r["height"], "job_id": r["job_id"], "prev_hash": r["prev_hash"],
                "coinbase1": r["coinbase1"], "coinbase2": r["coinbase2"], "merkle_branches": list(r["merkle_branches"]),
                "version": r["version"]})
    for k in ("nbits", "ntime"):
        if r.get(k) is not None:
            doc[k] = r[k]
    doc["clean_jobs"] = r["clean_jobs"]
    doc["extranonce1"] = r["extranonce1"]
    doc["extranonce2_length"] = r["extranonce2_length"]
    for k in ("lat_ms", "lat_m", "chain_family"):
        if r.get(k) is not None:
            doc[k] = r[k]
    if not (r["site"] == LEGACY_SITE and r["connection_id"] == r["pool"] and r["mode"] == "observe"):
        doc.update({"site": r["site"], "connection_id": r["connection_id"], "mode": r["mode"]})
    for k in ("account", "endpoint_ip"):
        if r.get(k) is not None:
            doc[k] = r[k]
    if r.get("extra"):
        doc.update(r["extra"] if isinstance(r["extra"], dict) else json.loads(r["extra"]))
    return doc


def btc_templates_for_height(height):
    rows = _fetchall("SELECT * FROM templates WHERE height = %s AND chain_family IS NULL ORDER BY ts", (height,))
    return [row_to_template_doc(r) for r in rows]
