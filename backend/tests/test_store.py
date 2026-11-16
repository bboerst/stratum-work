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
        self.assertEqual(self.db.blocks.calls[0], ("find_one", (), {"sort": [("height", -1)]}))
        self.assertEqual(self.db.blocks.calls[1][1], ({"height": {"$gte": 1, "$lt": 9}}, {"height": 1, "_id": 0}))

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
        self.assertEqual(got[0], doc)
        self.assertEqual(int(timestamp, 16) // 1000, 1_794_437_000_123_456)   # hex ns, µs precision

    def test_templates_at_height_shows_one_stream_per_pool(self):
        """Primary ci/a, secondaries ci/b and ci2/a: a secondary's row is dropped as an exact copy (its earlier receive
        time becomes the primary row's timestamp) or while a lower-ranked source was active (within 90 s before /
        10 s after); it is kept only as a gap fill, when the lower-ranked sources were silent. Re-sends stay."""
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
                    (("ci", "b"), 0.010, "b7", aa, 100, "b1"),    # exact copy of a1, earlier: dropped
                    (("ci2", "a"), 0.015, "c3", aa, 99, "c1"),    # same job, other ntime, a active: dropped
                    (("ci", "a"), 30.0, "a2", aa, 130, "a2"),     # the primary re-sends the job: kept
                    (("ci", "b"), 5.0, "b8", bb, 105, "b2"),      # its own job, a active: dropped
                    (("ci", "b"), 200.0, "b9", cc, 300, "b3")]    # a silent for 170 s: kept (gap fill)
            for src, s, job_id, br, ntime, cb in rows:
                c.execute("""INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2,
                             merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
                             VALUES (to_timestamp(1794437000 + %s), %s, %s, %s, %s, %s, '\\xffffffff', %s, 536870912, 386000000,
                                     %s, true, %s, 8)""",
                          (s, sid[src], h, job_id, bytes.fromhex("11" * 32), bytes.fromhex(cb), br, ntime, bytes.fromhex(cb)))
        got = self.store.templates_at_height(h)
        self.assertEqual([(t["pool_name"], t["job_id"], t["coinbase1"], t["ntime"]) for t in got],
                         [(name, "a1", "a1", "00000064"), (name, "a2", "a2", "00000082"), (name, "b9", "b3", "0000012c")])
        self.assertEqual(int(got[0]["timestamp"], 16) // 1000, 1_794_437_000_010_000)   # first seen: the copy's time

    def test_stale_blocks_upsert_merge_and_reorg(self):
        """#180: a header-only row gains its block data later; first status/first_seen are kept; reorg linked."""
        from datetime import datetime, timezone
        h = self.h + 40
        sh, ah = f"{h:08x}" + "d4" * 28, f"{h:08x}" + "d5" * 28
        t0 = datetime(2026, 11, 16, tzinfo=timezone.utc)
        row = {"block_hash": sh, "height": h, "prev_hash": "d3" * 32, "version": 536870912, "block_time": t0,
               "bits": 0x207fffff, "nonce": 7, "merkle_root": "11" * 32, "status": "headers-only", "tip_hash": sh,
               "fork_height": h - 1, "first_seen": t0, "was_active": False, "newly_stale": True, "full_block": False}
        self.assertEqual(self.store.stale_block_states([sh]), {})
        self.store.save_stale_branch([row])
        full = dict(row, status="valid-fork", first_seen=datetime(2027, 1, 1, tzinfo=timezone.utc), full_block=True,
                    block_fetched_at=t0, coinbase_script_sig="03aabb",
                    coinbase_outputs=[{"value_sat": 1, "script_pubkey": "51", "address": None}], tx_count=2, size=300,
                    weight=1200, mining_pool={"id": 9, "name": "Synthetic"})
        self.store.save_stale_branch([full])
        st = self.store.stale_block_states([sh])[sh]
        self.assertEqual((st["last_status"], st["full_block"], st["reorged_in_at"]), ("valid-fork", True, None))
        self.assertEqual(self.store.current_stale_blocks(h)[0], {"block_hash": sh, "height": h})
        reorged = dict(row, block_hash=ah, tip_hash=ah, status="valid-fork", was_active=True)
        rid = self.store.save_stale_branch([reorged], {"fork_height": h - 1, "depth": 1, "old_tip_hash": ah,
                                                      "old_tip_height": h, "new_tip_hash": sh, "new_tip_height": h,
                                                      "detected_at": t0})
        self.assertIsInstance(rid, int)
        self.store.mark_stale_block_reactivated(sh)
        self.assertNotIn(sh, {r["block_hash"] for r in self.store.current_stale_blocks(h)})
        blk = dict(self._block(h), block_hash=ah)
        self.store.save_block(blk, is_new_block=True)
        self.assertEqual(self.store.known_block_hashes([ah, sh]), {ah})
        with self.psycopg.connect(self.admin) as c:
            got = c.execute("SELECT chaintip_status, first_seen, tx_count, pool_id, mining_pool->>'name', coinbase_outputs"
                            " FROM stale_blocks WHERE block_hash = %s", (bytes.fromhex(sh),)).fetchone()
            self.assertEqual(got[:5], ("headers-only", t0, 2, 9, "Synthetic"))
            self.assertEqual(got[5][0]["value_sat"], 1)
            self.assertEqual(c.execute("SELECT reorg_id FROM stale_blocks WHERE block_hash = %s",
                                       (bytes.fromhex(ah),)).fetchone()[0], rid)


if __name__ == "__main__":
    unittest.main()
