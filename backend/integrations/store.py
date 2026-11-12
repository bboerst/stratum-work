"""Storage for the backend: blocks, pools, and the templates analytics read (#112).

One small interface, two implementations, selected by DB_BACKEND (default: mongodb):
  * MongoStore     today's MongoDB queries, unchanged
  * PostgresStore  Postgres + TimescaleDB (design: docs/design/postgres-timescale.md)

Both return the same shapes, so main.py and the analytics plug-ins don't care which is in use:
  * templates_at_height() returns dicts with the MongoDB field names and hex strings (pool_name, prev_hash,
    coinbase1, coinbase2, extranonce1, extranonce2_length, merkle_branches [list of hex], version, nbits, ntime, ...)
  * blocks are dicts {height, block_hash (hex), timestamp (unix s), coinbase_script_sig (hex), mining_pool, analysis}
  * pools are the mempool/mining-pools `pools-v2.json` entries, as loaded
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Iterator, List, Optional, Set

logger = logging.getLogger("backend.store")


class MongoStore:
    """Today's behavior, verbatim."""

    def __init__(self, db: Any):
        self.db = db

    @property
    def enabled(self) -> bool:
        return self.db is not None

    # blocks
    def save_block(self, doc: Dict[str, Any], is_new_block: bool) -> None:
        # New blocks upsert (avoid duplicates); blocks synced during backfill were checked for existence first.
        if is_new_block:
            self.db.blocks.update_one({"block_hash": doc["block_hash"]}, {"$set": doc}, upsert=True)
        else:
            self.db.blocks.insert_one(doc)

    def replace_block(self, doc: Dict[str, Any]) -> None:
        self.db.blocks.replace_one({"block_hash": doc["block_hash"]}, doc, upsert=True)

    def block_hashes_by_height_desc(self) -> Iterator[Dict[str, Any]]:
        return iter(self.db.blocks.find({}, {"block_hash": 1, "height": 1, "_id": 0}).sort("height", -1))

    def blocks_for_reidentify(self) -> Iterator[Dict[str, Any]]:
        """What pool identification needs, newest first: hash, height, coinbase scriptSig, current result (#135)."""
        cursor = self.db.blocks.find({}, {"_id": 0, "block_hash": 1, "height": 1, "coinbase_script_sig": 1,
                                          "mining_pool": 1, "analysis": 1}).sort("height", -1)
        for d in cursor:
            analysis = d.get("analysis")
            yield {"block_hash": d.get("block_hash"), "height": d.get("height"),
                   "coinbase_script_sig": d.get("coinbase_script_sig"), "mining_pool": d.get("mining_pool"),
                   "pool_identification": analysis.get("pool_identification") if isinstance(analysis, dict) else None,
                   "analysis_is_object": isinstance(analysis, dict)}

    def update_block_pool(self, block_hash: str, mining_pool: Dict[str, Any], pool_identification: Dict[str, Any],
                          analysis_is_object: bool = True) -> None:
        """Update only the pool fields of one block; every other analysis result is kept (#135)."""
        if analysis_is_object:
            update = {"mining_pool": mining_pool, "analysis.pool_identification": pool_identification}
        else:   # analysis missing or not an object: a dotted $set would fail on null
            update = {"mining_pool": mining_pool, "analysis": {"pool_identification": pool_identification}}
        self.db.blocks.update_one({"block_hash": block_hash}, {"$set": update})

    def highest_block_height(self) -> Optional[int]:
        b = self.db.blocks.find_one(sort=[("height", -1)])
        return b["height"] if b else None

    def lowest_block_height(self) -> Optional[int]:
        b = self.db.blocks.find_one(sort=[("height", 1)])
        return b["height"] if b else None

    def block_heights_between(self, low: int, high_exclusive: int) -> Set[int]:
        return {d["height"] for d in self.db.blocks.find({"height": {"$gte": low, "$lt": high_exclusive}}, {"height": 1, "_id": 0})}

    def has_block_at_height(self, height: int) -> bool:
        return self.db.blocks.find_one({"height": height}) is not None

    # templates
    def templates_at_height(self, height: int) -> List[Dict[str, Any]]:
        return list(self.db.mining_notify.find({"height": height, "chain_family": {"$exists": False}}))

    # pools
    def replace_pools(self, pool_data: List[Dict[str, Any]]) -> None:
        self.db.pools.delete_many({})
        self.db.pools.insert_many(pool_data)

    def load_pools(self) -> List[Dict[str, Any]]:
        return list(self.db.pools.find({}, {"_id": 0}))


def _to_bytes(hex_str: Optional[str]) -> bytes:
    return bytes.fromhex(hex_str or "")


def _pool_id(mining_pool: Any) -> Optional[int]:
    pid = (mining_pool or {}).get("id") if isinstance(mining_pool, dict) else None
    if isinstance(pid, bool):
        return None
    if isinstance(pid, int):
        return pid
    if isinstance(pid, str) and pid.isdigit():
        return int(pid)
    return None


class PostgresStore:
    """Postgres + TimescaleDB. Connects as a user in the stratum_backend role (least privilege)."""

    _BLOCK_UPSERT = """
        INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig, pool_id, mining_pool, analysis)
        VALUES (%(block_hash)s, %(height)s, %(block_time)s, %(seen_at)s, %(coinbase_script_sig)s, %(pool_id)s,
                %(mining_pool)s, %(analysis)s)
        ON CONFLICT (block_hash) DO UPDATE SET
            height = EXCLUDED.height, block_time = EXCLUDED.block_time,
            seen_at = COALESCE(blocks.seen_at, EXCLUDED.seen_at),   -- first time we saw it live is kept
            coinbase_script_sig = EXCLUDED.coinbase_script_sig, pool_id = EXCLUDED.pool_id,
            mining_pool = EXCLUDED.mining_pool, analysis = EXCLUDED.analysis"""

    def __init__(self, connect_kwargs: Dict[str, Any], connect=None):
        self._connect_kwargs = connect_kwargs
        self._connect = connect or self._psycopg_connect
        self._conn = None
        self._lock = threading.Lock()   # the backend is multi-threaded (ZMQ listener, sync, pool updater)

    @classmethod
    def from_env(cls) -> "PostgresStore":
        # Keyword arguments, never a URL: connection errors then can't echo the password.
        kw = dict(host=os.getenv("PG_HOST", "postgres"), port=int(os.getenv("PG_PORT", "5432")),
                  dbname=os.getenv("PG_DATABASE", "stratum"), user=os.getenv("PG_USER", "backend"),
                  sslmode=os.getenv("PG_SSLMODE", "prefer"), connect_timeout=10, application_name="stratum-work-backend")
        if os.getenv("PG_PASSWORD"):
            kw["password"] = os.environ["PG_PASSWORD"]
        return cls(kw)

    enabled = True

    @staticmethod
    def _psycopg_connect(**kwargs):
        import psycopg
        return psycopg.connect(**kwargs)

    def _run(self, fn):
        """Run fn(conn) in a transaction; reconnect and retry once if the connection was lost."""
        with self._lock:
            for attempt in (1, 2):
                try:
                    if self._conn is None or getattr(self._conn, "closed", False):
                        self._conn = self._connect(**self._connect_kwargs)
                    result = fn(self._conn)
                    self._conn.commit()
                    return result
                except Exception as exc:
                    try:
                        if self._conn is not None:
                            self._conn.rollback()
                    except Exception:
                        pass
                    if attempt == 2 or not self._is_connection_error(exc):
                        raise
                    logger.warning("Postgres connection lost (%s); reconnecting", exc)
                    try:
                        self._conn.close()
                    except Exception:
                        pass
                    self._conn = None

    @staticmethod
    def _is_connection_error(exc: Exception) -> bool:
        try:
            import psycopg
            return isinstance(exc, (psycopg.OperationalError, psycopg.InterfaceError))
        except ImportError:  # pragma: no cover
            return False

    # blocks
    def _block_params(self, doc: Dict[str, Any], seen_now: bool) -> Dict[str, Any]:
        return dict(
            block_hash=_to_bytes(doc["block_hash"]), height=int(doc["height"]),
            block_time=datetime.fromtimestamp(int(doc["timestamp"]), tz=timezone.utc),
            seen_at=datetime.now(timezone.utc) if seen_now else None,
            coinbase_script_sig=_to_bytes(doc.get("coinbase_script_sig")), pool_id=_pool_id(doc.get("mining_pool")),
            mining_pool=json.dumps(doc.get("mining_pool") or {}, default=str),
            analysis=json.dumps(doc.get("analysis") or {}, default=str),
        )

    def save_block(self, doc: Dict[str, Any], is_new_block: bool) -> None:
        # Always an upsert keyed by hash: unlike the MongoDB insert during backfill, this can't create duplicates.
        params = self._block_params(doc, seen_now=is_new_block)
        self._run(lambda c: c.execute(self._BLOCK_UPSERT, params))

    def replace_block(self, doc: Dict[str, Any]) -> None:
        params = self._block_params(doc, seen_now=False)
        self._run(lambda c: c.execute(self._BLOCK_UPSERT, params))

    def block_hashes_by_height_desc(self) -> Iterator[Dict[str, Any]]:
        rows = self._run(lambda c: c.execute("SELECT encode(block_hash, 'hex'), height FROM blocks ORDER BY height DESC").fetchall())
        return iter({"block_hash": h, "height": height} for h, height in rows)

    def blocks_for_reidentify(self) -> Iterator[Dict[str, Any]]:
        rows = self._run(lambda c: c.execute(
            "SELECT encode(block_hash, 'hex'), height, encode(coinbase_script_sig, 'hex'), mining_pool,"
            " analysis -> 'pool_identification' FROM blocks ORDER BY height DESC").fetchall())
        return iter({"block_hash": h, "height": height, "coinbase_script_sig": script, "mining_pool": mp,
                     "pool_identification": pi, "analysis_is_object": True} for h, height, script, mp, pi in rows)

    _BLOCK_POOL_UPDATE = """
        UPDATE blocks SET mining_pool = %(mining_pool)s::jsonb, pool_id = %(pool_id)s,
            analysis = jsonb_set(CASE WHEN jsonb_typeof(analysis) = 'object' THEN analysis ELSE '{}'::jsonb END,
                                 '{pool_identification}', %(pool_identification)s::jsonb)
        WHERE block_hash = %(block_hash)s"""

    def update_block_pool(self, block_hash: str, mining_pool: Dict[str, Any], pool_identification: Dict[str, Any],
                          analysis_is_object: bool = True) -> None:
        params = dict(block_hash=_to_bytes(block_hash), pool_id=_pool_id(mining_pool),
                      mining_pool=json.dumps(mining_pool or {}, default=str),
                      pool_identification=json.dumps(pool_identification or {}, default=str))
        self._run(lambda c: c.execute(self._BLOCK_POOL_UPDATE, params))

    def highest_block_height(self) -> Optional[int]:
        return self._run(lambda c: c.execute("SELECT max(height) FROM blocks").fetchone()[0])

    def lowest_block_height(self) -> Optional[int]:
        return self._run(lambda c: c.execute("SELECT min(height) FROM blocks").fetchone()[0])

    def block_heights_between(self, low: int, high_exclusive: int) -> Set[int]:
        rows = self._run(lambda c: c.execute("SELECT height FROM blocks WHERE height >= %s AND height < %s",
                                             (low, high_exclusive)).fetchall())
        return {r[0] for r in rows}

    def has_block_at_height(self, height: int) -> bool:
        return self._run(lambda c: c.execute("SELECT EXISTS (SELECT 1 FROM blocks WHERE height = %s)", (height,)).fetchone()[0])

    # templates (Bitcoin only by construction: other chains live in templates_other)
    _TEMPLATES_AT_HEIGHT = """
        SELECT s.name, t.height, t.job_id, encode(t.prev_hash, 'hex'), encode(t.coinbase1, 'hex'), encode(t.coinbase2, 'hex'),
               encode(t.merkle_branches, 'hex'), lpad(to_hex(t.version), 8, '0'), lpad(to_hex(t.nbits), 8, '0'),
               lpad(to_hex(t.ntime), 8, '0'), t.clean_jobs, encode(t.extranonce1, 'hex'), t.extranonce2_length,
               t.latency_ms, t.latency_method::text, (extract(epoch FROM t.received_at) * 1000000)::bigint
          FROM templates t JOIN sources s ON s.id = t.source_id
         WHERE t.height = %s
         ORDER BY t.received_at"""

    def templates_at_height(self, height: int) -> List[Dict[str, Any]]:
        rows = self._run(lambda c: c.execute(self._TEMPLATES_AT_HEIGHT, (height,)).fetchall())
        out = []
        for (pool_name, h, job_id, prev_hash, cb1, cb2, branches, version, nbits, ntime, clean, en1, en2len,
             lat_ms, lat_m, received_us) in rows:
            doc = {
                "pool_name": pool_name, "height": h, "job_id": job_id, "prev_hash": prev_hash,
                "coinbase1": cb1, "coinbase2": cb2,
                "merkle_branches": [branches[i:i + 64] for i in range(0, len(branches), 64)],
                "version": version, "nbits": nbits, "ntime": ntime, "clean_jobs": clean,
                "extranonce1": en1, "extranonce2_length": en2len,
                "timestamp": format(received_us * 1000, "x"),   # same hex-ns format collectors write to MongoDB
            }
            if lat_ms is not None:
                doc["lat_ms"] = lat_ms
            if lat_m is not None:
                doc["lat_m"] = lat_m
            out.append(doc)
        return out

    # pools: full pools-v2.json entries kept in pools.definition so nothing is lost
    def replace_pools(self, pool_data: List[Dict[str, Any]]) -> None:
        def tx(c):
            ids = []
            for p in pool_data:
                pid = _pool_id(p)
                if pid is None:
                    continue
                ids.append(pid)
                c.execute("""INSERT INTO pools (id, name, slug, link, tags, addresses, definition, updated_at)
                             VALUES (%s, %s, %s, %s, %s, %s, %s, now())
                             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, link = EXCLUDED.link,
                               tags = EXCLUDED.tags, addresses = EXCLUDED.addresses, definition = EXCLUDED.definition,
                               updated_at = now()""",
                          (pid, p.get("name") or "", p.get("slug"), p.get("link"), list(p.get("tags") or []),
                           list(p.get("addresses") or []), json.dumps(p, default=str)))
            c.execute("DELETE FROM pools WHERE NOT (id = ANY(%s))", (ids,))
        self._run(tx)

    def load_pools(self) -> List[Dict[str, Any]]:
        rows = self._run(lambda c: c.execute("SELECT definition FROM pools ORDER BY id").fetchall())
        return [r[0] for r in rows]


def make_store() -> Any:
    """Pick the store from DB_BACKEND (mongodb | postgres). MongoDB is the default until the cutover (#90)."""
    backend = os.getenv("DB_BACKEND", "mongodb").strip().lower()
    if backend not in ("mongodb", "postgres"):
        raise ValueError(f"DB_BACKEND must be 'mongodb' or 'postgres', got {backend!r}")
    if os.getenv("ENABLE_HISTORICAL_DATA", "true").strip().lower() in ("n", "no", "f", "false", "off", "0"):
        logger.info("Historical data disabled; no storage backend")
        return MongoStore(None)   # disabled store (enabled == False), same as MongoDB-disabled today
    if backend == "postgres":
        logger.info("Storage backend: Postgres (%s:%s/%s as %s)", os.getenv("PG_HOST", "postgres"),
                    os.getenv("PG_PORT", "5432"), os.getenv("PG_DATABASE", "stratum"), os.getenv("PG_USER", "backend"))
        return PostgresStore.from_env()
    from .mongodb import db, is_enabled   # connects at import (MongoDB-only)
    logger.info("Storage backend: MongoDB")
    return MongoStore(db if is_enabled else None)
