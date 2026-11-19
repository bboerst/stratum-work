"""Storage for the backend: blocks, pools, and the templates analytics read (#112), in Postgres + TimescaleDB
(PostgresStore; design: docs/design/postgres-timescale.md). Shapes main.py and the analytics plug-ins use:
  * templates_at_height() returns dicts with hex strings (pool_name, prev_hash, coinbase1, coinbase2, extranonce1,
    extranonce2_length, merkle_branches [list of hex], version, nbits, ntime, ...), plus the collector's site /
    replica. Every row of every collector, copies included: an anomaly only one collector received must still be
    analyzed
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


def _header_params(doc: Dict[str, Any]) -> Dict[str, Any]:
    """blocks' header columns from a block document's header fields (header_fill.block_header_fields); missing = NULL."""
    bits = doc.get("bits")
    return dict(
        tx_count=doc.get("transactions"), size=doc.get("size"), weight=doc.get("weight"), version=doc.get("version"),
        merkle_root=_to_bytes(doc["merkle_root"]) if doc.get("merkle_root") else None,
        bits=int(str(bits), 16) if bits is not None else None, nonce=doc.get("nonce"), difficulty=doc.get("difficulty"),
    )


def _coinbase_params(doc: Dict[str, Any]) -> Dict[str, Any]:
    """blocks' #235 columns from a block document's coinbase facts (coinbase.coinbase_facts). The txid is stored in
    internal byte order (the document has it as RPC displays it); the branches already are."""
    txid = doc.get("coinbase_txid")
    return dict(
        merkle_branches=bytes.fromhex(doc["merkle_branches"]) if doc.get("merkle_branches") is not None else None,
        coinbase_txid=bytes.fromhex(txid)[::-1] if txid else None,
        coinbase_tx=bytes.fromhex(doc["coinbase_tx"]) if doc.get("coinbase_tx") else None,
    )


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
        INSERT INTO blocks (block_hash, height, block_time, seen_at, seen_via, coinbase_script_sig, pool_id, mining_pool,
                            analysis, tx_count, size, weight, version, merkle_root, bits, nonce, difficulty,
                            merkle_branches, coinbase_txid, coinbase_tx)
        VALUES (%(block_hash)s, %(height)s, %(block_time)s, %(seen_at)s, %(seen_via)s, %(coinbase_script_sig)s,
                %(pool_id)s, %(mining_pool)s, %(analysis)s, %(tx_count)s, %(size)s, %(weight)s, %(version)s,
                %(merkle_root)s, %(bits)s, %(nonce)s, %(difficulty)s, %(merkle_branches)s, %(coinbase_txid)s,
                %(coinbase_tx)s)
        ON CONFLICT (block_hash) DO UPDATE SET
            height = EXCLUDED.height, block_time = EXCLUDED.block_time,
            -- header facts never change for a hash: a save without one (e.g. a document from before they were
            -- recorded) keeps what is stored
            tx_count = COALESCE(EXCLUDED.tx_count, blocks.tx_count), size = COALESCE(EXCLUDED.size, blocks.size),
            weight = COALESCE(EXCLUDED.weight, blocks.weight), version = COALESCE(EXCLUDED.version, blocks.version),
            merkle_root = COALESCE(EXCLUDED.merkle_root, blocks.merkle_root), bits = COALESCE(EXCLUDED.bits, blocks.bits),
            nonce = COALESCE(EXCLUDED.nonce, blocks.nonce), difficulty = COALESCE(EXCLUDED.difficulty, blocks.difficulty),
            merkle_branches = COALESCE(EXCLUDED.merkle_branches, blocks.merkle_branches),
            coinbase_txid = COALESCE(EXCLUDED.coinbase_txid, blocks.coinbase_txid),
            coinbase_tx = COALESCE(EXCLUDED.coinbase_tx, blocks.coinbase_tx),
            -- the first time we saw it live is kept, with how we saw it (SET reads the row's old values)
            seen_at = COALESCE(blocks.seen_at, EXCLUDED.seen_at),
            seen_via = CASE WHEN blocks.seen_at IS NULL THEN EXCLUDED.seen_via ELSE blocks.seen_via END,
            coinbase_script_sig = EXCLUDED.coinbase_script_sig, pool_id = EXCLUDED.pool_id,
            mining_pool = EXCLUDED.mining_pool, analysis = EXCLUDED.analysis"""

    def __init__(self, connect_kwargs: Dict[str, Any], connect=None, enabled: bool = True):
        # enabled=False: historical data off (ENABLE_HISTORICAL_DATA=false); callers check it and never connect.
        self.enabled = enabled
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
        # CA for sslmode=verify-ca/verify-full (a private CA); without it libpq looks for ~/.postgresql/root.crt.
        if os.getenv("PG_SSLROOTCERT"):
            kw["sslrootcert"] = os.environ["PG_SSLROOTCERT"]
        return cls(kw)

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
    def _block_params(self, doc: Dict[str, Any], seen_now: bool, seen_at: Optional[datetime] = None,
                      seen_via: Optional[str] = None) -> Dict[str, Any]:
        # seen_now: seen live. seen_at: when it arrived (the ZMQ receive time); without one (a block the
        # reconciliation found), the time it is saved, i.e. when we detected it. Not seen live: both NULL.
        return dict(
            block_hash=_to_bytes(doc["block_hash"]), height=int(doc["height"]),
            block_time=datetime.fromtimestamp(int(doc["timestamp"]), tz=timezone.utc),
            seen_at=(seen_at or datetime.now(timezone.utc)) if seen_now else None,
            seen_via=seen_via if seen_now else None,
            coinbase_script_sig=_to_bytes(doc.get("coinbase_script_sig")), pool_id=_pool_id(doc.get("mining_pool")),
            mining_pool=json.dumps(doc.get("mining_pool") or {}, default=str),
            analysis=json.dumps(doc.get("analysis") or {}, default=str),
            **_header_params(doc), **_coinbase_params(doc),
        )

    def save_block(self, doc: Dict[str, Any], is_new_block: bool, seen_at: Optional[datetime] = None,
                   seen_via: Optional[str] = None) -> None:
        # Always an upsert keyed by hash, so it can't create duplicates.
        params = self._block_params(doc, seen_now=is_new_block, seen_at=seen_at, seen_via=seen_via)
        self._run(lambda c: c.execute(self._BLOCK_UPSERT, params))

    def replace_block(self, doc: Dict[str, Any]) -> None:
        params = self._block_params(doc, seen_now=False)
        self._run(lambda c: c.execute(self._BLOCK_UPSERT, params))

    # Reorgs (#194): blocks keeps blocks a reorg disconnected (keyed by hash). Reads by height (the tip, gaps, "is
    # height h done") go through the view blocks_best (db/migrations/20261116300001_blocks_best.sql), which leaves
    # out blocks recorded in stale_blocks as currently stale (reorged_in_at IS NULL; active again = shown). So sync
    # stores the active block at a height whose only stored block is stale. Per-block maintenance (full reindex, pool
    # re-identification, known_block_hashes) reads every stored block: those work by hash, and a stale block's
    # analysis and pool stay correct. With no stale_blocks rows blocks_best is exactly blocks.
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
        # ORDER BY ... LIMIT 1, not max(): through the view's anti-join max() would scan the table (no min/max index
        # shortcut); this walks blocks_height from the top and stops at the first best-chain block.
        row = self._run(lambda c: c.execute("SELECT height FROM blocks_best ORDER BY height DESC LIMIT 1").fetchone())
        return row[0] if row else None

    def lowest_block_height(self) -> Optional[int]:
        row = self._run(lambda c: c.execute("SELECT height FROM blocks_best ORDER BY height ASC LIMIT 1").fetchone())
        return row[0] if row else None

    def block_heights_between(self, low: int, high_exclusive: int) -> Set[int]:
        rows = self._run(lambda c: c.execute("SELECT height FROM blocks_best WHERE height >= %s AND height < %s",
                                             (low, high_exclusive)).fetchall())
        return {r[0] for r in rows}

    def has_block_at_height(self, height: int) -> bool:
        return self._run(lambda c: c.execute("SELECT EXISTS (SELECT 1 FROM blocks_best WHERE height = %s)", (height,)).fetchone()[0])

    # header fill (header_fill.py): blocks stored before the header columns were written
    def blocks_missing_header(self, limit: int) -> List[str]:
        """Hashes (hex, as stored) of blocks with no tx_count yet, newest first. All blocks, stale ones too."""
        rows = self._run(lambda c: c.execute(
            "SELECT encode(block_hash, 'hex') FROM blocks WHERE tx_count IS NULL ORDER BY height DESC LIMIT %s",
            (limit,)).fetchall())
        return [r[0] for r in rows]

    _HEADER_FILL = """
        UPDATE blocks SET
            tx_count = COALESCE(tx_count, %(tx_count)s), size = COALESCE(size, %(size)s),
            weight = COALESCE(weight, %(weight)s), version = COALESCE(version, %(version)s),
            merkle_root = COALESCE(merkle_root, %(merkle_root)s), bits = COALESCE(bits, %(bits)s),
            nonce = COALESCE(nonce, %(nonce)s), difficulty = COALESCE(difficulty, %(difficulty)s)
        WHERE block_hash = %(block_hash)s"""

    def fill_block_headers(self, docs: List[Dict[str, Any]]) -> int:
        """Fill only the header columns that are still NULL, from {block_hash, <header fields>} documents. Returns the
        rows updated."""
        params = [dict(block_hash=_to_bytes(d["block_hash"]), **_header_params(d)) for d in docs]
        if not params:
            return 0
        def run(c):
            with c.cursor() as cur:
                cur.executemany(self._HEADER_FILL, params)
                return cur.rowcount
        return self._run(run)

    # coinbase fill (coinbase_fill.py, #235): blocks stored before their merkle branches were recorded
    def blocks_missing_branches(self, limit: int) -> List[str]:
        """Hashes (hex, as stored) of blocks without merkle_branches, newest first."""
        rows = self._run(lambda c: c.execute(
            "SELECT encode(block_hash, 'hex') FROM blocks WHERE merkle_branches IS NULL ORDER BY height DESC LIMIT %s",
            (limit,)).fetchall())
        return [r[0] for r in rows]

    _COINBASE_FILL = """
        UPDATE blocks SET
            merkle_branches = COALESCE(merkle_branches, %(merkle_branches)s),
            coinbase_txid = COALESCE(coinbase_txid, %(coinbase_txid)s), coinbase_tx = COALESCE(coinbase_tx, %(coinbase_tx)s)
        WHERE block_hash = %(block_hash)s"""

    def fill_block_coinbase(self, docs: List[Dict[str, Any]]) -> int:
        """Fill only the #235 columns that are still NULL, from {block_hash, <coinbase facts>} documents."""
        params = [dict(block_hash=_to_bytes(d["block_hash"]), **_coinbase_params(d)) for d in docs]
        if not params:
            return 0
        def run(c):
            with c.cursor() as cur:
                cur.executemany(self._COINBASE_FILL, params)
        self._run(run)
        return len(params)

    def best_block_hashes_between(self, low: int, high: int) -> Dict[int, List[str]]:
        """{height: [hash, ...]} of the blocks_best rows in [low, high]."""
        rows = self._run(lambda c: c.execute(
            "SELECT height, encode(block_hash, 'hex') FROM blocks_best WHERE height >= %s AND height <= %s",
            (low, high)).fetchall())
        out: Dict[int, List[str]] = {}
        for height, block_hash in rows:
            out.setdefault(height, []).append(block_hash)
        return out

    def mark_block_best(self, block_hash: str) -> None:
        """A replaced block that is on the node's active chain again (blocks_best shows it once more)."""
        self.mark_stale_block_reactivated(block_hash)

    # templates at a height: only rows received inside the height's window (height_window(), from stored blocks; see
    # docs/design/one-templates-table.md), which keeps out stuck-feed re-sends of old jobs and other chains' templates
    # at that height. The window is fetched first and passed as values, unprepared, so the plan is custom and
    # TimescaleDB drops the chunks outside it at planning (a prepared, generic plan would only exclude them at run time).
    # Redundant collection (several collectors per pool, sources.replica, possibly at several sites): analytics read
    # the RAW rows of every collector, not the templates_dedup view. The view shows one stream per pool for display;
    # an anomaly (a divergent prev_hash, an invalid coinbase) that only one collector received must still be
    # analyzed. Each row carries its collector's site and replica, so an analysis that counts templates can tell a
    # copy received by two collectors from a pool's own re-send (see analytics/invalid_coinbase_no_merkle.py).
    # timestamp = the row's own receive time; pool_name is sources.name.
    _TEMPLATES_AT_HEIGHT = """
        SELECT s.name, t.height, t.job_id, encode(t.prev_hash, 'hex'), encode(t.coinbase1, 'hex'), encode(t.coinbase2, 'hex'),
               encode(t.merkle_branches, 'hex'), lpad(to_hex(t.version), 8, '0'), lpad(to_hex(t.nbits), 8, '0'),
               lpad(to_hex(t.ntime), 8, '0'), t.clean_jobs, encode(t.extranonce1, 'hex'), t.extranonce2_length,
               t.latency_ms, t.latency_method::text, (extract(epoch FROM t.received_at) * 1000000)::bigint, s.site, s.replica
          FROM templates t JOIN sources s ON s.id = t.source_id
         WHERE t.height = %s AND t.received_at >= %s AND t.received_at <= %s
         ORDER BY t.received_at, t.source_id, t.job_id"""

    def templates_at_height(self, height: int) -> List[Dict[str, Any]]:
        def run(c):
            t_from, t_to = c.execute("SELECT t_from::text, t_to::text FROM height_window(%s, %s)", (height, height),
                                     prepare=False).fetchone()
            return c.execute(self._TEMPLATES_AT_HEIGHT, (height, t_from, t_to), prepare=False).fetchall()
        rows = self._run(run)
        out = []
        for (pool_name, h, job_id, prev_hash, cb1, cb2, branches, version, nbits, ntime, clean, en1, en2len,
             lat_ms, lat_m, received_us, site, replica) in rows:
            doc = {
                "pool_name": pool_name, "height": h, "job_id": job_id, "prev_hash": prev_hash,
                "coinbase1": cb1, "coinbase2": cb2,
                "merkle_branches": [branches[i:i + 64] for i in range(0, len(branches), 64)],
                "version": version, "nbits": nbits, "ntime": ntime, "clean_jobs": clean,
                "extranonce1": en1, "extranonce2_length": en2len,
                "timestamp": format(received_us * 1000, "x"),   # receive time as hex nanoseconds, as the live stream has it
                "site": site, "replica": replica,
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

    # stale blocks (#180; db/migrations/20261116100001_stale_blocks.sql). Hashes are hex in RPC byte order, stored
    # as bytea like blocks.block_hash.
    def stale_block_states(self, hashes: List[str]) -> Dict[str, Dict[str, Any]]:
        if not hashes:
            return {}
        rows = self._run(lambda c: c.execute(
            "SELECT encode(block_hash, 'hex'), last_status, full_block, reorged_in_at FROM stale_blocks"
            " WHERE block_hash = ANY(%s)", ([_to_bytes(h) for h in hashes],)).fetchall())
        return {h: {"last_status": s, "full_block": f, "reorged_in_at": r} for h, s, f, r in rows}

    def known_block_hashes(self, hashes: List[str]) -> Set[str]:
        """Which of these hashes are in blocks (the backend stored them as a tip of our active chain)."""
        if not hashes:
            return set()
        rows = self._run(lambda c: c.execute("SELECT encode(block_hash, 'hex') FROM blocks WHERE block_hash = ANY(%s)",
                                             ([_to_bytes(h) for h in hashes],)).fetchall())
        return {r[0] for r in rows}

    def current_stale_blocks(self, min_height: int) -> List[Dict[str, Any]]:
        rows = self._run(lambda c: c.execute(
            "SELECT encode(block_hash, 'hex'), height FROM stale_blocks WHERE height >= %s AND reorged_in_at IS NULL"
            " ORDER BY height", (min_height,)).fetchall())
        return [{"block_hash": h, "height": height} for h, height in rows]

    def mark_stale_block_reactivated(self, block_hash: str) -> None:
        self._run(lambda c: c.execute(
            "UPDATE stale_blocks SET reorged_in_at = now(), last_status = 'active' WHERE block_hash = %s"
            " AND reorged_in_at IS NULL", (_to_bytes(block_hash),)))

    _STALE_UPSERT = """
        INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root,
            chaintip_status, last_status, tip_hash, fork_height, first_seen, was_active, reorg_id, full_block,
            block_fetched_at, coinbase_script_sig, coinbase_outputs, tx_count, size, weight, pool_id, mining_pool)
        VALUES (%(block_hash)s, %(height)s, %(prev_hash)s, %(version)s, %(block_time)s, %(bits)s, %(nonce)s,
            %(merkle_root)s, %(status)s, %(status)s, %(tip_hash)s, %(fork_height)s, %(first_seen)s, %(was_active)s,
            %(reorg_id)s, %(full_block)s, %(block_fetched_at)s, %(coinbase_script_sig)s, %(coinbase_outputs)s,
            %(tx_count)s, %(size)s, %(weight)s, %(pool_id)s, %(mining_pool)s)
        ON CONFLICT (block_hash) DO UPDATE SET
            last_status = EXCLUDED.last_status,
            was_active = stale_blocks.was_active OR EXCLUDED.was_active,
            reorg_id = COALESCE(EXCLUDED.reorg_id, stale_blocks.reorg_id),
            reorged_in_at = NULL,   -- recorded as stale again
            full_block = stale_blocks.full_block OR EXCLUDED.full_block,
            block_fetched_at = COALESCE(stale_blocks.block_fetched_at, EXCLUDED.block_fetched_at),
            coinbase_script_sig = COALESCE(stale_blocks.coinbase_script_sig, EXCLUDED.coinbase_script_sig),
            coinbase_outputs = COALESCE(stale_blocks.coinbase_outputs, EXCLUDED.coinbase_outputs),
            tx_count = COALESCE(stale_blocks.tx_count, EXCLUDED.tx_count),
            size = COALESCE(stale_blocks.size, EXCLUDED.size),
            weight = COALESCE(stale_blocks.weight, EXCLUDED.weight),
            pool_id = COALESCE(stale_blocks.pool_id, EXCLUDED.pool_id),
            mining_pool = COALESCE(stale_blocks.mining_pool, EXCLUDED.mining_pool)"""

    def save_stale_branch(self, rows: List[Dict[str, Any]], reorg: Optional[Dict[str, Any]] = None) -> Optional[int]:
        """One branch in one transaction: the reorg (if any) first, then its blocks, fork point first."""
        def tx(c):
            reorg_id = None
            if reorg:
                reorg_id = c.execute(
                    "INSERT INTO chain_reorgs (detected_at, fork_height, depth, old_tip_hash, old_tip_height,"
                    " new_tip_hash, new_tip_height) VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
                    (reorg["detected_at"], reorg["fork_height"], reorg["depth"], _to_bytes(reorg["old_tip_hash"]),
                     reorg["old_tip_height"], _to_bytes(reorg["new_tip_hash"]), reorg["new_tip_height"])).fetchone()[0]
            for r in rows:
                full = r.get("full_block", False)
                c.execute(self._STALE_UPSERT, dict(
                    block_hash=_to_bytes(r["block_hash"]), height=r["height"], prev_hash=_to_bytes(r["prev_hash"]),
                    version=r["version"], block_time=r["block_time"], bits=r["bits"], nonce=r["nonce"],
                    merkle_root=_to_bytes(r["merkle_root"]), status=r["status"], tip_hash=_to_bytes(r["tip_hash"]),
                    fork_height=r["fork_height"], first_seen=r["first_seen"], was_active=r["was_active"],
                    reorg_id=reorg_id if r["was_active"] and r.get("newly_stale", True) else None, full_block=full,
                    block_fetched_at=r.get("block_fetched_at"),
                    coinbase_script_sig=_to_bytes(r["coinbase_script_sig"]) if full else None,
                    coinbase_outputs=json.dumps(r["coinbase_outputs"]) if full else None,
                    tx_count=r.get("tx_count"), size=r.get("size"), weight=r.get("weight"),
                    pool_id=_pool_id(r.get("mining_pool")) if full else None,
                    mining_pool=json.dumps(r.get("mining_pool") or {}, default=str) if full else None))
            return reorg_id
        return self._run(tx)


def make_store() -> PostgresStore:
    """The Postgres store from PG_* settings; a disabled one (enabled == False) with ENABLE_HISTORICAL_DATA=false."""
    if os.getenv("ENABLE_HISTORICAL_DATA", "true").strip().lower() in ("n", "no", "f", "false", "off", "0"):
        logger.info("Historical data disabled; no storage")
        return PostgresStore({}, enabled=False)
    logger.info("Storage: Postgres (%s:%s/%s as %s)", os.getenv("PG_HOST", "postgres"),
                os.getenv("PG_PORT", "5432"), os.getenv("PG_DATABASE", "stratum"), os.getenv("PG_USER", "backend"))
    return PostgresStore.from_env()
