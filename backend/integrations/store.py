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
from typing import Any, Dict, Iterable, Iterator, List, Optional, Set, Tuple

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
            " analysis -> 'pool_identification' FROM blocks"
            # Only blocks still Unknown can change (identified blocks keep their pool), and reading every block's JSON
            # in one fetch was enough to OOM the backend at startup.
            " WHERE coalesce(mining_pool ->> 'id', 'unknown') = 'unknown' ORDER BY height DESC").fetchall())
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

    # DATUM creator re-analysis (coinbase_reanalysis --datum-creators, #320). The selection mirrors
    # identify_pool_from_data's _is_ocean_pool (name, slug or id "ocean", any case): the only blocks the creator rule
    # applies to. A few thousand rows.
    def datum_pool_blocks(self) -> List[Dict[str, Any]]:
        rows = self._run(lambda c: c.execute(
            "SELECT encode(block_hash, 'hex'), height, encode(coinbase_script_sig, 'hex'), mining_pool,"
            " analysis -> 'pool_identification' -> 'mining_pool' FROM blocks"
            " WHERE 'ocean' IN (lower(mining_pool ->> 'name'), lower(mining_pool ->> 'slug'), lower(mining_pool ->> 'id'))"
            " ORDER BY height").fetchall())
        return [{"block_hash": h, "height": height, "coinbase_script_sig": script, "mining_pool": mp,
                 "analysis_mining_pool": amp} for h, height, script, mp, amp in rows]

    _DATUM_CREATOR_UPDATE = """
        UPDATE blocks SET
            mining_pool = (mining_pool - 'datum_template_creator' - 'datum_gateway_default') || %(fields)s::jsonb,
            analysis = CASE WHEN jsonb_typeof(analysis -> 'pool_identification' -> 'mining_pool') = 'object'
                THEN jsonb_set(analysis, '{pool_identification,mining_pool}',
                               ((analysis -> 'pool_identification' -> 'mining_pool')
                                - 'datum_template_creator' - 'datum_gateway_default') || %(fields)s::jsonb)
                ELSE analysis END
        WHERE block_hash = %(block_hash)s"""

    def update_datum_creator(self, block_hash: str, fields: Dict[str, str]) -> None:
        """Replace only the DATUM creator keys (datum_template_creator, datum_gateway_default) of a block's mining_pool
        and of its stored pool_identification copy with `fields`. The pool, pool_id and every other key are kept."""
        params = dict(block_hash=_to_bytes(block_hash), fields=json.dumps(fields))
        self._run(lambda c: c.execute(self._DATUM_CREATOR_UPDATE, params))

    def update_coinbase_analysis(self, height: int, flag: Optional[Dict[str, Any]], report: Optional[Dict[str, Any]],
                                 dry_run: bool = False) -> List[Dict[str, Any]]:
        """Re-analysis (coinbase_reanalysis.py): set the coinbase results of every block stored at `height` (best and
        stale; they share the height's templates). The invalid_coinbase_no_merkle flag is replaced by `flag` (removed
        when None) and `coinbase_parse` by `report`; every other key and flag is kept. Returns, per block whose
        analysis changed, {block_hash, before_flag, after_flag}; with dry_run nothing is written."""
        def run(c):
            lock = "" if dry_run else " FOR UPDATE"   # a dry run only reads (a read-only role can run it)
            rows = c.execute("SELECT encode(block_hash, 'hex'), analysis FROM blocks WHERE height = %s" + lock,
                             (height,)).fetchall()
            changed = []
            for block_hash, analysis in rows:
                old = analysis if isinstance(analysis, dict) else {}
                new = {k: v for k, v in old.items() if k not in ("flags", "coinbase_parse")}
                old_flags = old.get("flags") if isinstance(old.get("flags"), list) else []
                before = next((f for f in old_flags if isinstance(f, dict) and f.get("key") == "invalid_coinbase_no_merkle"), None)
                flags = [f for f in old_flags if not (isinstance(f, dict) and f.get("key") == "invalid_coinbase_no_merkle")]
                if flag:
                    flags.append(flag)
                if flags:
                    new["flags"] = flags
                if report:
                    new["coinbase_parse"] = report
                if new == analysis:
                    continue
                changed.append({"block_hash": block_hash, "before_flag": before, "after_flag": flag})
                if not dry_run:
                    c.execute("UPDATE blocks SET analysis = %s::jsonb WHERE block_hash = decode(%s, 'hex')",
                              (json.dumps(new, default=str), block_hash))
            return changed
        return self._run(run)

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
    def blocks_missing_branches(self, limit: int) -> List[Tuple[str, int]]:
        """(hash (hex, as stored), height) of blocks without merkle_branches, newest first."""
        rows = self._run(lambda c: c.execute(
            "SELECT encode(block_hash, 'hex'), height FROM blocks WHERE merkle_branches IS NULL ORDER BY height DESC LIMIT %s",
            (limit,)).fetchall())
        return [(r[0], r[1]) for r in rows]

    def blocks_missing_coinbase_tx(self, limit: int) -> List[Tuple[str, str, int]]:
        """(block hash, coinbase txid, height), hashes hex as RPC displays them, of blocks with a coinbase txid but no
        coinbase bytes, newest first."""
        rows = self._run(lambda c: c.execute(
            "SELECT encode(block_hash, 'hex'), encode(coinbase_txid, 'hex'), height FROM blocks"
            " WHERE coinbase_txid IS NOT NULL AND coinbase_tx IS NULL ORDER BY height DESC LIMIT %s",
            (limit,)).fetchall())
        return [(r[0], bytes.fromhex(r[1])[::-1].hex(), r[2]) for r in rows]

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

    # unknown parents (unknown_parents.py; db/migrations/20261119000003_unknown_parent_pools.sql). prev_hash is
    # bytes as stored in templates (stratum word order). Bounds are passed as values, unprepared, so TimescaleDB
    # excludes chunks at planning.
    def unknown_parents_received_between(self, t_from: datetime, t_to: datetime) -> List[Dict[str, Any]]:
        """The parents of templates received in [t_from, t_to] that are no block we know (bitcoin_parents), each with
        the heights and first / last receive time of its templates in that range. Reads only received_at, height
        and prev_hash of the range."""
        rows = self._run(lambda c: c.execute(
            "SELECT t.prev_hash, array_agg(DISTINCT t.height ORDER BY t.height), min(t.received_at), max(t.received_at)"
            "  FROM templates t"
            " WHERE t.received_at >= %s AND t.received_at <= %s"
            "   AND NOT EXISTS (SELECT 1 FROM bitcoin_parents p WHERE p.prev_hash = t.prev_hash)"
            " GROUP BY t.prev_hash ORDER BY min(t.received_at), t.prev_hash", (t_from, t_to), prepare=False).fetchall())
        return [{"prev_hash": bytes(p), "heights": list(h), "first": f, "last": la} for p, h, f, la in rows]

    def unknown_parent_extents(self, prev_hashes: List[bytes]) -> Dict[bytes, Dict[str, Any]]:
        """What unknown_parent_pools already holds for these parents: heights and first / last receive time over
        all pools."""
        if not prev_hashes:
            return {}
        rows = self._run(lambda c: c.execute(
            "SELECT u.prev_hash, array_agg(DISTINCT h.key::int ORDER BY h.key::int), min(u.first_received),"
            "       max(u.last_received)"
            "  FROM unknown_parent_pools u, jsonb_each(u.heights) h"
            " WHERE u.prev_hash = ANY(%s) GROUP BY u.prev_hash", (list(prev_hashes),)).fetchall())
        return {bytes(p): {"heights": list(h), "first": f, "last": la} for p, h, f, la in rows}

    def refresh_unknown_parent(self, prev_hash: bytes, heights: List[int], t_from: datetime, t_to: datetime) -> int:
        """Recompute one parent's unknown_parent_pools rows from its templates at these heights in [t_from, t_to]
        (unknown_parent_pools_refresh()). Returns the (parent, pool) rows written."""
        return self._run(lambda c: c.execute(
            "SELECT unknown_parent_pools_refresh(%s, %s::int[], %s, %s)", (prev_hash, list(heights), t_from, t_to),
            prepare=False).fetchone()[0])

    # stale parents (stale_parents.py; db/migrations/20261120000001_stale_parent_pools.sql). block_hash is display
    # order, as stale_blocks.block_hash. Each block comes with its height + 1 and that height's window as text (exact
    # to the µs, and 'infinity' while no block at the height is stored), passed back as values.
    _STALE_PARENT_BLOCKS = (
        "SELECT s.block_hash, s.height + 1, w.w_from::text, w.w_to::text,"
        "       EXISTS (SELECT 1 FROM stale_parent_pools p WHERE p.prev_hash = stratum_prev_hash_to_block_hash(s.block_hash)),"
        "       w.w_from <= %(t_to)s::timestamptz AND w.w_to >= %(t_from)s::timestamptz"
        "  FROM stale_blocks s CROSS JOIN LATERAL template_height_windows(s.height + 1, s.height + 1) w"
        " WHERE s.height BETWEEN %(h_from)s AND %(h_to)s")

    def _stale_parent_blocks(self, where: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        p = {"t_from": None, "t_to": None, "h_from": -1, "h_to": 2 ** 31 - 1, **params}
        rows = self._run(lambda c: c.execute(
            f"SELECT * FROM ({self._STALE_PARENT_BLOCKS}) x(block_hash, height, w_from, w_to, has_rows, in_range)"
            f" WHERE {where} ORDER BY height, block_hash", p).fetchall())
        return [{"block_hash": bytes(b), "height": h, "w_from": f, "w_to": t, "has_rows": r, "overlaps": bool(o)}
                for b, h, f, t, r, o in rows]

    def stale_parents_to_refresh(self, t_from: datetime, t_to: datetime) -> List[Dict[str, Any]]:
        """The stale blocks whose height + 1 window overlaps [t_from, t_to] (new templates on them, or a window that
        just changed), and those with no stale_parent_pools row (recorded since, e.g. imported or marked replaced)."""
        return self._stale_parent_blocks("in_range OR NOT has_rows", {"t_from": t_from, "t_to": t_to})

    def stale_parents_between_heights(self, h_from: int, h_to: int) -> List[Dict[str, Any]]:
        """Every stale block at heights [h_from, h_to] (the backfill)."""
        return self._stale_parent_blocks("true", {"h_from": h_from, "h_to": h_to})

    def stale_block_heights(self) -> Optional[Tuple[int, int]]:
        row = self._run(lambda c: c.execute("SELECT min(height), max(height) FROM stale_blocks").fetchone())
        return None if row[0] is None else (row[0], row[1])

    def refresh_stale_parent(self, block_hash: bytes, height: int, w_from: str, w_to: str) -> int:
        """Recompute one stale block's stale_parent_pools rows from its templates at height received in
        [w_from, w_to] (stale_parent_pools_refresh()). Returns the (block, pool) rows written."""
        return self._run(lambda c: c.execute(
            "SELECT stale_parent_pools_refresh(%s, %s, %s::timestamptz, %s::timestamptz)",
            (block_hash, height, w_from, w_to), prepare=False).fetchone()[0])

    def first_template_received(self) -> Optional[datetime]:
        return self._run(lambda c: c.execute("SELECT min(received_at) FROM templates").fetchone()[0])

    # transaction-set facts (template_sets.py; db/migrations/20261120000002_template_sets.sql). The receive-time
    # bounds come from height_window() in a first round trip and are passed as values, unprepared, so TimescaleDB
    # excludes chunks at planning. The windows and the parents (the blocks at h - 1, stratum word order) are
    # materialized once per read (on production, 144 recent heights: 2.1 s server-side, against 3.1 s with a
    # per-template EXISTS on bitcoin_parents).
    _TEMPLATE_SET_ROWS = """
        WITH w AS MATERIALIZED (SELECT * FROM template_height_windows(%(h_from)s, %(h_to)s)),
        par AS MATERIALIZED (
            SELECT height + 1 AS height, stratum_prev_hash_to_block_hash(block_hash) AS prev_hash FROM blocks
             WHERE height BETWEEN %(h_from)s - 1 AND %(h_to)s - 1
            UNION
            SELECT height + 1, stratum_prev_hash_to_block_hash(block_hash) FROM stale_blocks
             WHERE height BETWEEN %(h_from)s - 1 AND %(h_to)s - 1)
        SELECT t.height, s.name, sha256(t.merkle_branches), t.coinbase1, t.extranonce1, t.extranonce2_length,
               t.coinbase2, t.received_at
          FROM templates t
          JOIN sources s ON s.id = t.source_id
          JOIN w ON w.height = t.height
          JOIN par ON par.height = t.height AND par.prev_hash = t.prev_hash
         WHERE t.height BETWEEN %(h_from)s AND %(h_to)s AND t.received_at >= %(t_from)s AND t.received_at <= %(t_to)s
           AND t.received_at >= w.w_from AND t.received_at <= w.w_to AND length(t.merkle_branches) > 0"""

    TEMPLATE_SET_ITERSIZE = 5000      # rows per fetch of the server-side cursor

    def template_set_rows(self, h_from: int, h_to: int, consume):
        """consume(rows) over the non-empty templates counted at heights [h_from, h_to], streamed (a server-side cursor,
        TEMPLATE_SET_ITERSIZE rows at a time, so neither libpq nor Python holds a chunk's ~200k rows at once): each row
        (height, feed, sha256 of the merkle branches, coinbase1 hex, extranonce1 hex, extranonce2_length, coinbase2
        hex, received_at). Returns what consume returns."""
        def run(c):
            t_from, t_to = c.execute("SELECT t_from::text, t_to::text FROM height_window(%s, %s)", (h_from, h_to),
                                     prepare=False).fetchone()
            if t_from is None:
                return consume(iter(()))
            with c.cursor(name="template_set_rows") as cur:
                cur.itersize = self.TEMPLATE_SET_ITERSIZE
                cur.execute(self._TEMPLATE_SET_ROWS, dict(h_from=h_from, h_to=h_to, t_from=t_from, t_to=t_to))
                return consume((h, feed, bytes(sh), bytes(cb1).hex(), bytes(en1).hex(), en2len, bytes(cb2).hex(), ra)
                               for h, feed, sh, cb1, en1, en2len, cb2, ra in cur)
        return self._run(run)

    def template_set_lowest_counted(self) -> Optional[int]:
        """The lowest height in template_set_heights (the in-process history walk's position)."""
        return self._run(lambda c: c.execute("SELECT min(height) FROM template_set_heights").fetchone()[0])

    def replace_template_sets(self, h_from: int, h_to: int, heights: List[tuple], feeds: List[tuple],
                              pairs: List[tuple]) -> None:
        """Replace every row of heights [h_from, h_to] in one transaction: heights (height, templates), feeds
        (height, feed, pool_id, sets, templates, first_received, last_received), pairs (height, feed_a, pool_a,
        feed_b, pool_b, shared)."""
        def tx(c):
            # one writer at a time (the backend's filler and a backfill may overlap): delete + insert can't collide
            c.execute("SELECT pg_advisory_xact_lock(%s)", (self.TEMPLATE_SETS_LOCK,))
            for table in ("template_set_pairs", "template_set_feeds", "template_set_heights"):
                c.execute(f"DELETE FROM {table} WHERE height BETWEEN %s AND %s", (h_from, h_to))
            with c.cursor() as cur:
                for sql, rows in (
                        ("COPY template_set_heights (height, templates) FROM STDIN", heights),
                        ("COPY template_set_feeds (height, feed, pool_id, sets, templates, first_received,"
                         " last_received) FROM STDIN", feeds),
                        ("COPY template_set_pairs (height, feed_a, pool_a, feed_b, pool_b, shared) FROM STDIN", pairs)):
                    if rows:
                        with cur.copy(sql) as cp:
                            for r in rows:
                                cp.write_row(r)
        self._run(tx)

    TEMPLATE_SETS_LOCK = 72_011_120   # pg_advisory_xact_lock key of replace_template_sets

    def template_set_heights_due(self, lookback: int) -> List[int]:
        """Heights of the last `lookback` up to our highest block whose window has closed, whose block at h - 1 is
        stored, and that aren't filled."""
        rows = self._run(lambda c: c.execute(
            "WITH tip AS (SELECT max(height) AS h, min(height) AS lo FROM blocks)"
            " SELECT w.height FROM tip, LATERAL template_height_windows(greatest(tip.h - %s, tip.lo + 1), tip.h) w"
            "  WHERE w.w_to < now()"
            "    AND EXISTS (SELECT 1 FROM blocks b WHERE b.height = w.height - 1)"
            "    AND NOT EXISTS (SELECT 1 FROM template_set_heights s WHERE s.height = w.height)"
            "  ORDER BY w.height", (lookback,)).fetchall())
        return [r[0] for r in rows]

    def template_set_parent_heights(self, h_from: int, h_to: int) -> Set[int]:
        """The heights in [h_from, h_to] whose block at h - 1 is stored (a best or a stale block)."""
        rows = self._run(lambda c: c.execute(
            "SELECT DISTINCT height + 1 FROM blocks WHERE height BETWEEN %s AND %s", (h_from - 1, h_to - 1)).fetchall())
        return {r[0] for r in rows}

    def template_set_height_bounds(self) -> tuple:
        """(lowest height with a stored parent, highest height whose window has closed), from blocks."""
        return tuple(self._run(lambda c: c.execute(
            "SELECT (SELECT min(height) + 1 FROM blocks),"
            "       (SELECT max(height) FROM blocks WHERE coalesce(seen_at, block_time) + interval '2 hours' < now())"
        ).fetchone()))

    # reported hashrate (reported_hashrate.py; db/migrations/20261119000005_reported_hashrate.sql): a claim by each
    # pool, kept apart from anything measured.
    REPORTED_HASHRATE_UPSERT = (
        "INSERT INTO reported_hashrate (source, pool_key, at, pool_url, hashrate, network_hashrate, fetched_at)"
        " VALUES (%(source)s, %(pool_key)s, %(at)s, %(pool_url)s, %(hashrate)s, %(network_hashrate)s, %(fetched_at)s)"
        " ON CONFLICT (source, pool_key, at) DO UPDATE SET pool_url = EXCLUDED.pool_url, hashrate = EXCLUDED.hashrate,"
        " network_hashrate = EXCLUDED.network_hashrate, fetched_at = EXCLUDED.fetched_at")

    def upsert_reported_hashrate(self, rows: List[Dict[str, Any]]) -> int:
        """Insert or overwrite these points in one transaction (all or nothing). Returns the rows written."""
        def tx(c):
            with c.cursor() as cur:
                cur.executemany(self.REPORTED_HASHRATE_UPSERT, rows)
            return len(rows)
        return self._run(tx) if rows else 0

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

    def stale_blocks_missing_coinbase(self) -> List[Dict[str, Any]]:
        """Blocks in both blocks and stale_blocks still without merkle branches, coinbase txid or coinbase bytes
        (stale_import --coinbase-fill, #339): {block_hash, height, merkle_root (blocks', else stale_blocks'),
        coinbase_txid (as RPC displays it, or None)}, newest first. Hashes hex as RPC displays them."""
        rows = self._run(lambda c: c.execute(
            "SELECT encode(b.block_hash, 'hex'), b.height, encode(COALESCE(b.merkle_root, s.merkle_root), 'hex'),"
            "       encode(b.coinbase_txid, 'hex')"
            "  FROM blocks b JOIN stale_blocks s ON s.block_hash = b.block_hash"
            " WHERE b.merkle_branches IS NULL OR b.coinbase_txid IS NULL OR b.coinbase_tx IS NULL"
            " ORDER BY b.height DESC").fetchall())
        return [{"block_hash": h, "height": height, "merkle_root": root or None,
                 "coinbase_txid": bytes.fromhex(txid)[::-1].hex() if txid else None} for h, height, root, txid in rows]

    def stale_block_hashes(self, hashes: List[str]) -> Set[str]:
        """Which of these hashes are stale blocks (in stale_blocks and not active again); the coinbase fill (#339)."""
        if not hashes:
            return set()
        rows = self._run(lambda c: c.execute(
            "SELECT encode(block_hash, 'hex') FROM stale_blocks WHERE block_hash = ANY(%s) AND reorged_in_at IS NULL",
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

    # stale blocks our node never saw, imported from the public dataset (#243, backend/stale_import.py)
    def block_height_range(self):
        return tuple(self._run(lambda c: c.execute("SELECT min(height), max(height) FROM blocks").fetchone()))

    def unknown_parent_candidates(self, h_from: int, h_to: int) -> List[Dict[str, Any]]:
        """Per (height, prev_hash) in [h_from, h_to]: templates received inside the height's window whose prev_hash
        is no block we know (in neither blocks nor stale_blocks, as bitcoin_parents), with the number of distinct
        pools (sources.name) and the earliest receive time. The window's overall range is read first and passed as
        values, unprepared (as in templates_at_height), so TimescaleDB excludes chunks at planning; as text, since it
        can be +-infinity."""
        def tx(c):
            t_from, t_to = c.execute("SELECT t_from::text, t_to::text FROM height_window(%s, %s)", (h_from, h_to),
                                     prepare=False).fetchone()
            if t_from is None:
                return []
            return c.execute("""
                WITH g AS (
                    SELECT t.height, t.prev_hash, count(DISTINCT s.name) AS pools, min(t.received_at) AS first_at
                      FROM templates t
                      JOIN sources s ON s.id = t.source_id
                      JOIN template_height_windows(%(a)s, %(b)s) w ON w.height = t.height
                     WHERE t.height BETWEEN %(a)s AND %(b)s
                       AND t.received_at >= %(tf)s::timestamptz AND t.received_at <= %(tt)s::timestamptz
                       AND t.received_at BETWEEN w.w_from AND w.w_to
                     GROUP BY t.height, t.prev_hash
                )
                -- bitcoin_parents' predicate, written as primary-key probes of its two tables (no view-wide hash)
                SELECT g.height, encode(g.block_hash, 'hex'), g.pools, g.first_at
                  FROM (SELECT g.*, stratum_prev_hash_to_block_hash(g.prev_hash) AS block_hash FROM g) g
                 WHERE g.block_hash IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.block_hash = g.block_hash)
                   AND NOT EXISTS (SELECT 1 FROM stale_blocks s WHERE s.block_hash = g.block_hash)
                 ORDER BY g.height, g.first_at""", dict(a=h_from, b=h_to, tf=t_from, tt=t_to),
                prepare=False).fetchall()
        return [{"height": h, "block_hash": bh, "pools": n, "first_seen": first} for h, bh, n, first in self._run(tx)]

    def best_blocks_at(self, heights: List[int]) -> Dict[int, List[Dict[str, Any]]]:
        """{height: [{block_hash, bits}]} of blocks_best at these heights (bits None when not stored)."""
        if not heights:
            return {}
        rows = self._run(lambda c: c.execute(
            "SELECT height, encode(block_hash, 'hex'), bits FROM blocks_best WHERE height = ANY(%s)",
            (list(heights),)).fetchall())
        out: Dict[int, List[Dict[str, Any]]] = {}
        for h, bh, bits in rows:
            out.setdefault(h, []).append({"block_hash": bh, "bits": bits})
        return out

    def insert_imported_stale_block(self, r: Dict[str, Any]) -> bool:
        """One imported stale block (header_source 'bitcoin-data/stale-blocks'). An existing row is left as it is
        (never updated); returns whether it was inserted."""
        full = r.get("full_block", False)
        return self._run(lambda c: c.execute("""
            INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root,
                chaintip_status, last_status, tip_hash, fork_height, first_seen, was_active, header_source, full_block,
                block_fetched_at, coinbase_script_sig, coinbase_outputs, tx_count, size, weight, pool_id, mining_pool)
            VALUES (%(block_hash)s, %(height)s, %(prev_hash)s, %(version)s, %(block_time)s, %(bits)s, %(nonce)s,
                %(merkle_root)s, 'not-in-node', 'not-in-node', %(tip_hash)s, %(fork_height)s, %(first_seen)s, false,
                'bitcoin-data/stale-blocks', %(full_block)s, %(block_fetched_at)s, %(coinbase_script_sig)s,
                %(coinbase_outputs)s, %(tx_count)s, %(size)s, %(weight)s, %(pool_id)s, %(mining_pool)s)
            ON CONFLICT (block_hash) DO NOTHING""", dict(
                block_hash=_to_bytes(r["block_hash"]), height=r["height"], prev_hash=_to_bytes(r["prev_hash"]),
                version=r["version"], block_time=r["block_time"], bits=r["bits"], nonce=r["nonce"],
                merkle_root=_to_bytes(r["merkle_root"]), tip_hash=_to_bytes(r["tip_hash"]),
                fork_height=r["fork_height"], first_seen=r["first_seen"], full_block=full,
                block_fetched_at=r.get("block_fetched_at"),
                coinbase_script_sig=_to_bytes(r["coinbase_script_sig"]) if full else None,
                coinbase_outputs=json.dumps(r["coinbase_outputs"]) if full else None,
                tx_count=r.get("tx_count"), size=r.get("size"), weight=r.get("weight"),
                pool_id=_pool_id(r.get("mining_pool")) if full else None,
                mining_pool=json.dumps(r.get("mining_pool") or {}, default=str) if full else None)).rowcount == 1)


def make_store() -> PostgresStore:
    """The Postgres store from PG_* settings; a disabled one (enabled == False) with ENABLE_HISTORICAL_DATA=false."""
    if os.getenv("ENABLE_HISTORICAL_DATA", "true").strip().lower() in ("n", "no", "f", "false", "off", "0"):
        logger.info("Historical data disabled; no storage")
        return PostgresStore({}, enabled=False)
    logger.info("Storage: Postgres (%s:%s/%s as %s)", os.getenv("PG_HOST", "postgres"),
                os.getenv("PG_PORT", "5432"), os.getenv("PG_DATABASE", "stratum"), os.getenv("PG_USER", "backend"))
    return PostgresStore.from_env()
