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
            sid = c.execute("INSERT INTO sources (name, site) VALUES (%s, 'ci') ON CONFLICT (name, site) DO UPDATE SET name = EXCLUDED.name RETURNING id",
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


if __name__ == "__main__":
    unittest.main()
