import os
import pathlib
import sys
import time
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tests"))
from test_btc_template_filtering import load_store_module  # noqa: E402

store_module = load_store_module()
MongoStore, PostgresStore = store_module.MongoStore, store_module.PostgresStore


class Recorder:
    """Records every MongoDB collection call as (method, args)."""
    def __init__(self, results=None):
        self.calls, self.results = [], results or {}
    def __getattr__(self, name):
        def call(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            r = self.results.get(name)
            return r() if callable(r) else r
        return call


class FakeCursor(list):
    def sort(self, *a): self.sorted_by = a; return self


class MongoStoreTests(unittest.TestCase):
    """MongoStore must keep issuing exactly today's queries."""

    def setUp(self):
        self.db = type("DB", (), {})()
        self.db.blocks, self.db.pools, self.db.mining_notify = Recorder(), Recorder(), Recorder({"find": lambda: []})
        self.store = MongoStore(self.db)

    def test_disabled_without_db(self):
        self.assertFalse(MongoStore(None).enabled)
        self.assertTrue(self.store.enabled)

    def test_save_block_new_upserts_and_sync_inserts(self):
        doc = {"block_hash": "ab", "height": 1}
        self.store.save_block(doc, is_new_block=True)
        self.store.save_block(doc, is_new_block=False)
        self.assertEqual(self.db.blocks.calls[0], ("update_one", ({"block_hash": "ab"}, {"$set": doc}), {"upsert": True}))
        self.assertEqual(self.db.blocks.calls[1], ("insert_one", (doc,), {}))

    def test_replace_block(self):
        doc = {"block_hash": "ab", "height": 1}
        self.store.replace_block(doc)
        self.assertEqual(self.db.blocks.calls[0], ("replace_one", ({"block_hash": "ab"}, doc), {"upsert": True}))

    def test_blocks_for_reidentify_reads_stored_pool_inputs(self):
        self.db.blocks.results["find"] = lambda: FakeCursor([
            {"block_hash": "aa", "height": 2, "coinbase_script_sig": "03", "mining_pool": {"name": "A"},
             "analysis": {"pool_identification": {"addresses_considered": ["bc1q"]}, "flags": []}},
            {"block_hash": "bb", "height": 1, "coinbase_script_sig": "04", "mining_pool": {}, "analysis": None}])
        got = list(self.store.blocks_for_reidentify())
        self.assertEqual(got[0]["pool_identification"], {"addresses_considered": ["bc1q"]})
        self.assertTrue(got[0]["analysis_is_object"])
        self.assertIsNone(got[1]["pool_identification"])
        self.assertFalse(got[1]["analysis_is_object"])

    def test_update_block_pool_sets_only_pool_fields(self):
        self.store.update_block_pool("aa", {"name": "B"}, {"method": "tag"})
        self.store.update_block_pool("bb", {"name": "C"}, {"method": "none"}, analysis_is_object=False)
        self.assertEqual(self.db.blocks.calls[0], ("update_one", ({"block_hash": "aa"},
                         {"$set": {"mining_pool": {"name": "B"}, "analysis.pool_identification": {"method": "tag"}}}), {}))
        self.assertEqual(self.db.blocks.calls[1], ("update_one", ({"block_hash": "bb"},
                         {"$set": {"mining_pool": {"name": "C"}, "analysis": {"pool_identification": {"method": "none"}}}}), {}))

    def test_templates_at_height_is_btc_only(self):
        self.store.templates_at_height(123)
        self.assertEqual(self.db.mining_notify.calls[0][1], ({"height": 123, "chain_family": {"$exists": False}},))

    def test_heights(self):
        self.db.blocks.results = {"find_one": lambda: {"height": 7}, "find": lambda: [{"height": 3}, {"height": 5}]}
        self.assertEqual(self.store.highest_block_height(), 7)
        self.assertEqual(self.store.block_heights_between(1, 9), {3, 5})
        self.assertTrue(self.store.has_block_at_height(7))
        # #212: best-chain reads skip documents the reconciler flagged stale
        self.assertEqual(self.db.blocks.calls[0], ("find_one", ({"stale": {"$ne": True}},), {"sort": [("height", -1)]}))
        self.assertEqual(self.db.blocks.calls[1][1], ({"height": {"$gte": 1, "$lt": 9}, "stale": {"$ne": True}},
                                                      {"height": 1, "_id": 0}))
        self.assertEqual(self.db.blocks.calls[2][1], ({"height": 7, "stale": {"$ne": True}},))
        self.store.lowest_block_height()
        self.assertEqual(self.db.blocks.calls[3], ("find_one", ({"stale": {"$ne": True}},), {"sort": [("height", 1)]}))

    def test_best_chain_reconciliation_queries(self):
        self.db.blocks.results = {"find": lambda: [{"height": 5, "block_hash": "aa"}, {"height": 5, "block_hash": "bb"},
                                                   {"height": 6, "block_hash": "cc"}]}
        self.assertEqual(self.store.best_block_hashes_between(5, 6), {5: ["aa", "bb"], 6: ["cc"]})
        self.assertEqual(self.db.blocks.calls[0][1], ({"height": {"$gte": 5, "$lte": 6}, "stale": {"$ne": True}},
                                                      {"height": 1, "block_hash": 1, "_id": 0}))
        self.assertEqual(self.store.known_block_hashes(["aa", "cc"]), {"aa", "bb", "cc"})   # whatever find returns
        self.assertEqual(self.db.blocks.calls[1][1], ({"block_hash": {"$in": ["aa", "cc"]}}, {"block_hash": 1, "_id": 0}))
        self.assertEqual(self.store.known_block_hashes([]), set())
        self.store.mark_blocks_stale(["aa"])
        name, (flt, update), _ = self.db.blocks.calls[2]
        self.assertEqual((name, flt, update["$set"]["stale"]), ("update_many", {"block_hash": {"$in": ["aa"]}}, True))
        self.assertIsNotNone(update["$set"]["stale_at"].tzinfo)
        self.store.mark_block_best("aa")
        self.assertEqual(self.db.blocks.calls[3], ("update_many", ({"block_hash": "aa", "stale": True},
                                                                   {"$unset": {"stale": "", "stale_at": ""}}), {}))

    def test_pools(self):
        self.store.replace_pools([{"id": 1}])
        self.assertEqual([c[0] for c in self.db.pools.calls], ["delete_many", "insert_many"])


class PostgresStoreFromEnvTests(unittest.TestCase):
    ENV = ("PG_HOST", "PG_PORT", "PG_DATABASE", "PG_USER", "PG_PASSWORD", "PG_SSLMODE", "PG_SSLROOTCERT")

    def setUp(self):
        self.saved = {k: os.environ.pop(k, None) for k in self.ENV}

    def tearDown(self):
        for k, v in self.saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v

    def test_sslrootcert_is_passed_to_libpq(self):
        os.environ.update(PG_HOST="db", PG_SSLMODE="verify-full", PG_SSLROOTCERT="/etc/postgres-ca/ca.crt")
        kw = PostgresStore.from_env()._connect_kwargs
        self.assertEqual(kw["sslmode"], "verify-full")
        self.assertEqual(kw["sslrootcert"], "/etc/postgres-ca/ca.crt")

    def test_defaults_without_sslrootcert(self):
        kw = PostgresStore.from_env()._connect_kwargs
        self.assertNotIn("sslrootcert", kw)
        self.assertEqual((kw["host"], kw["sslmode"]), ("postgres", "prefer"))
        self.assertNotIn("password", kw)


@unittest.skipUnless(os.getenv("PG_TEST_HOST"), "set PG_TEST_HOST etc. to run against a migrated Postgres")
class PostgresStoreIntegrationTests(unittest.TestCase):
    """Against a real, migrated database, as a user in the stratum_backend role (least privilege)."""

    @classmethod
    def setUpClass(cls):
        import psycopg
        cls.psycopg = psycopg
        cls.store = PostgresStore(dict(host=os.environ["PG_TEST_HOST"], port=int(os.getenv("PG_TEST_PORT", "5432")),
                                       dbname=os.getenv("PG_TEST_DATABASE", "stratum"), user=os.environ["PG_TEST_USER"],
                                       password=os.environ["PG_TEST_PASSWORD"], sslmode="disable"))
        cls.admin = os.environ["PG_TEST_ADMIN_DSN"]
        cls.h = 900_000 + int(time.time()) % 50_000   # unique test heights per run

    def _block(self, h, hash_byte="aa", pool=None):
        return {"block_hash": hash_byte * 32, "height": h, "timestamp": 1_794_437_000, "coinbase_script_sig": "0393e20e",
                "mining_pool": pool or {"id": 111, "name": "Foundry USA"}, "analysis": {"pool_identification": {"method": "address"}}}

    def test_blocks(self):
        h = self.h
        self.store.save_block(self._block(h, "a1"), is_new_block=True)
        self.store.save_block(self._block(h, "a1"), is_new_block=False)   # same hash again: no duplicate
        self.store.save_block(self._block(h + 1, "a2"), is_new_block=False)
        self.assertTrue(self.store.has_block_at_height(h))
        self.assertEqual(self.store.block_heights_between(h, h + 2), {h, h + 1})
        self.assertGreaterEqual(self.store.highest_block_height(), h + 1)
        with self.psycopg.connect(self.admin) as c:
            n, seen, pool_id, mp = c.execute("SELECT count(*), max(seen_at), max(pool_id), max(mining_pool::text) FROM blocks WHERE block_hash = %s",
                                             (bytes.fromhex("a1" * 32),)).fetchone()
            self.assertEqual(n, 1)                 # upsert by hash
            self.assertIsNotNone(seen)             # first seen live is kept
            self.assertEqual(pool_id, 111)
            self.assertIn("Foundry USA", mp)
        hashes = [b["block_hash"] for b in self.store.block_hashes_by_height_desc() if b["height"] in (h, h + 1)]
        self.assertEqual(hashes, ["a2" * 32, "a1" * 32])

    def _stale(self, c, hash_byte, h, reorged_in=False):
        c.execute("""INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce, merkle_root,
                     chaintip_status, last_status, tip_hash, fork_height, was_active, reorged_in_at)
                     VALUES (%(b)s, %(h)s, '\\x00', 1, now(), 1, 1, '\\x00', 'valid-fork', %(st)s, %(b)s, %(h)s - 1, true,
                             CASE WHEN %(r)s THEN now() END)""",
                  dict(b=bytes.fromhex(hash_byte * 32), h=h, st="active" if reorged_in else "valid-fork", r=reorged_in))

    def test_height_reads_skip_blocks_recorded_as_stale(self):
        # #194: h: only a reorged-out block; h + 1: a stale block that became active again; h + 2: a reorged-out block
        # and its replacement. A top height above anything else checks the tip.
        h, top = self.h + 30, 8_000_000 + int(time.time()) % 50_000
        for height, hb in ((h, "d1"), (h + 1, "d2"), (h + 2, "d3"), (h + 2, "d4"), (top, "d5")):
            self.store.save_block(self._block(height, hb), is_new_block=False)
        try:
            with self.psycopg.connect(self.admin) as c:
                self._stale(c, "d1", h)
                self._stale(c, "d2", h + 1, reorged_in=True)
                self._stale(c, "d3", h + 2)
                self._stale(c, "d5", top)
            self.assertFalse(self.store.has_block_at_height(h))         # sync will store the active block here
            self.assertTrue(self.store.has_block_at_height(h + 1))
            self.assertTrue(self.store.has_block_at_height(h + 2))
            self.assertEqual(self.store.block_heights_between(h, h + 3), {h + 1, h + 2})
            self.assertLess(self.store.highest_block_height(), top)     # a reorged-out block isn't the tip
            # by-hash maintenance still sees every stored block
            self.assertEqual(self.store.known_block_hashes(["d1" * 32, "d5" * 32]), {"d1" * 32, "d5" * 32})
            self.assertIn("d1" * 32, {b["block_hash"] for b in self.store.blocks_for_reidentify()})
            self.assertIn("d3" * 32, {b["block_hash"] for b in self.store.block_hashes_by_height_desc()})
        finally:
            with self.psycopg.connect(self.admin) as c:
                c.execute("DELETE FROM stale_blocks WHERE height = %s", (top,))
                c.execute("DELETE FROM blocks WHERE height = %s", (top,))

    def test_best_block_hashes_and_mark_best(self):
        # #212: the reconciler's read (every best block per height) and "active again" (the stale row is reactivated)
        h = self.h + 40
        for height, hb in ((h, "e1"), (h, "e2"), (h + 1, "e3")):
            self.store.save_block(self._block(height, hb), is_new_block=False)
        with self.psycopg.connect(self.admin) as c:
            self._stale(c, "e1", h)
        self.assertEqual(self.store.best_block_hashes_between(h, h + 1), {h: ["e2" * 32], h + 1: ["e3" * 32]})
        self.store.mark_block_best("e1" * 32)
        self.assertEqual(sorted(self.store.best_block_hashes_between(h, h)[h]), ["e1" * 32, "e2" * 32])
        self.store.mark_block_best("e3" * 32)   # never stale: no-op
        self.assertEqual(self.store.best_block_hashes_between(h + 1, h + 1), {h + 1: ["e3" * 32]})

    def test_reidentify_reads_and_updates_only_pool_fields(self):
        h = self.h + 20
        hx = "c3" * 32
        block = self._block(h, "c3")
        block["analysis"] = {"pool_identification": {"method": "address", "addresses_considered": ["bc1qx"]},
                             "flags": [{"type": "kept"}]}
        self.store.save_block(block, is_new_block=True)
        mine = [b for b in self.store.blocks_for_reidentify() if b["block_hash"] == hx]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["coinbase_script_sig"], "0393e20e")
        self.assertEqual(mine[0]["pool_identification"]["addresses_considered"], ["bc1qx"])
        self.store.update_block_pool(hx, {"id": 222, "name": "Other"}, {"method": "tag", "addresses_considered": ["bc1qx"]})
        with self.psycopg.connect(self.admin) as c:
            pool_id, mp, analysis = c.execute("SELECT pool_id, mining_pool, analysis FROM blocks WHERE block_hash = %s",
                                              (bytes.fromhex(hx),)).fetchone()
        self.assertEqual(pool_id, 222)
        self.assertEqual(mp, {"id": 222, "name": "Other"})
        self.assertEqual(analysis["pool_identification"]["method"], "tag")
        self.assertEqual(analysis["flags"], [{"type": "kept"}])        # other analysis results untouched

    def test_pools_replace_keeps_full_definitions_and_deletes_missing(self):
        defs = [{"id": 900001, "name": "Test A", "addresses": ["bc1qa"], "tags": ["/A/"], "link": "https://a", "extra": {"x": 1}},
                {"id": 900002, "name": "Test B", "addresses": [], "tags": ["/B/"], "link": "https://b"}]
        self.store.replace_pools(defs)
        loaded = {p["id"]: p for p in self.store.load_pools()}
        self.assertEqual(loaded[900001], defs[0])          # full definition round-trips, including unmodeled fields
        self.store.replace_pools(defs[:1])                  # B disappears upstream -> deleted
        self.assertNotIn(900002, {p["id"] for p in self.store.load_pools()})

    def test_templates_at_height_matches_the_mongodb_document_shape(self):
        h = self.h + 10
        doc = {"pool_name": f"itest-{h}", "height": h, "job_id": "j1", "prev_hash": "11" * 32, "coinbase1": "01000000" + "00" * 8,
               "coinbase2": "ffffffff", "merkle_branches": ["aa" * 32, "bb" * 32], "version": "20000000", "nbits": "1702e5b4",
               "ntime": "69d72a43", "clean_jobs": True, "extranonce1": "abcd", "extranonce2_length": 8, "lat_ms": 12.5, "lat_m": "tcp"}
        with self.psycopg.connect(self.admin) as c:   # the backend role can't write templates; insert as admin
            sid = c.execute("INSERT INTO sources (name, site) VALUES (%s, 'ci') ON CONFLICT (name, site, replica) DO UPDATE SET name = EXCLUDED.name RETURNING id",
                            (doc["pool_name"],)).fetchone()[0]
            c.execute("""INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches,
                         version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length, latency_ms, latency_method)
                         VALUES (to_timestamp(1794437000.123456), %s, %s, 'j1', %s, %s, %s, %s, %s, %s, %s, true, %s, 8, 12.5, 'tcp')""",
                      (sid, h, bytes.fromhex(doc["prev_hash"]), bytes.fromhex(doc["coinbase1"]), bytes.fromhex(doc["coinbase2"]),
                       bytes.fromhex("".join(doc["merkle_branches"])), int(doc["version"], 16), int(doc["nbits"], 16), int(doc["ntime"], 16),
                       bytes.fromhex(doc["extranonce1"])))
        got = self.store.templates_at_height(h)
        self.assertEqual(len(got), 1)
        timestamp = got[0].pop("timestamp")
        self.assertEqual((got[0].pop("site"), got[0].pop("replica")), ("ci", "a"))   # the collector, for analyses
        self.assertEqual(got[0], doc)
        self.assertEqual(int(timestamp, 16) // 1000, 1_794_437_000_123_456)   # hex ns, µs precision

    def test_templates_at_height_returns_every_collectors_rows(self):
        """Analyses read every collector's rows, copies included (an anomaly only one collector received must still be
        analyzed), in receive order, each with its own receive time and its collector's site and replica."""
        h = self.h + 30
        name = f"itest-{h}"
        aa, bb, cc = bytes.fromhex("aa" * 32), bytes.fromhex("bb" * 32), bytes.fromhex("cc" * 32)
        with self.psycopg.connect(self.admin) as c:
            sid = {}
            for site, replica in (("ci", "a"), ("ci", "b"), ("ci2", "a")):
                sid[site, replica] = c.execute(
                    "INSERT INTO sources (name, site, replica) VALUES (%s, %s, %s) ON CONFLICT (name, site, replica)"
                    " DO UPDATE SET name = EXCLUDED.name RETURNING id", (name, site, replica)).fetchone()[0]
            # (source, seconds, job_id, branches, ntime, coinbase byte)
            rows = [(("ci", "a"), 0.020, "a1", aa, 100, "a1"),
                    (("ci", "b"), 0.010, "b7", aa, 100, "b1"),    # exact copy of a1 (hidden in templates_dedup)
                    (("ci2", "a"), 0.015, "c3", aa, 99, "c1"),    # same job, other ntime (hidden there)
                    (("ci", "a"), 30.0, "a2", aa, 130, "a2"),
                    (("ci", "b"), 5.0, "b8", bb, 105, "b2"),      # its own job (hidden there)
                    (("ci", "b"), 200.0, "b9", cc, 300, "b3")]    # gap fill
            for src, s, job_id, br, ntime, cb in rows:
                c.execute("""INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2,
                             merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
                             VALUES (to_timestamp(1794437000 + %s), %s, %s, %s, %s, %s, '\\xffffffff', %s, 536870912, 386000000,
                                     %s, true, %s, 8)""",
                          (s, sid[src], h, job_id, bytes.fromhex("11" * 32), bytes.fromhex(cb), br, ntime, bytes.fromhex(cb)))
        got = self.store.templates_at_height(h)
        self.assertEqual([(t["pool_name"], t["job_id"], t["site"], t["replica"], t["ntime"]) for t in got],
                         [(name, "b7", "ci", "b", "00000064"), (name, "c3", "ci2", "a", "00000063"),
                          (name, "a1", "ci", "a", "00000064"), (name, "b8", "ci", "b", "00000069"),
                          (name, "a2", "ci", "a", "00000082"), (name, "b9", "ci", "b", "0000012c")])
        self.assertEqual(int(got[0]["timestamp"], 16) // 1000, 1_794_437_000_010_000)   # each row's own time


if __name__ == "__main__":
    unittest.main()
