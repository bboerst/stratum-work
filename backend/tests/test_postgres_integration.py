import os
import sys
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from integrations import postgres as pg  # noqa: E402

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
BASE_HEIGHT = 900001


@unittest.skipUnless(TEST_DATABASE_URL, "TEST_DATABASE_URL not set")
class PostgresIntegration(unittest.TestCase):
    """Each test runs inside a transaction that is always rolled back, so the shared DB is left untouched."""

    def setUp(self):
        import psycopg
        from psycopg.rows import dict_row

        self._saved = (pg._conn, pg.ENABLED)
        self.conn = psycopg.connect(TEST_DATABASE_URL, autocommit=True, row_factory=dict_row)
        pg._conn = self.conn
        pg.ENABLED = True
        self._tx = self.conn.transaction(force_rollback=True)
        self._tx.__enter__()

    def tearDown(self):
        self._tx.__exit__(None, None, None)
        self.conn.close()
        pg._conn, pg.ENABLED = self._saved

    def test_block_upsert_and_reorg_replace(self):
        pg.upsert_block({"height": BASE_HEIGHT, "block_hash": "a" * 64, "timestamp": 1,
                         "mining_pool": {"name": "X"}, "analysis": {}})
        pg.upsert_block({"height": BASE_HEIGHT, "block_hash": "b" * 64, "timestamp": 2,
                         "mining_pool": {"name": "Y"}, "analysis": {}})
        block = pg.get_block(BASE_HEIGHT)
        self.assertEqual(block["block_hash"], "b" * 64)
        self.assertEqual(block["mining_pool"], {"name": "Y"})
        self.assertEqual(block["timestamp"], 2)

    def test_block_upsert_same_hash_updates_in_place(self):
        doc = {"height": BASE_HEIGHT + 1, "block_hash": "c" * 64, "timestamp": 3, "coinbase_script_sig": "00",
               "mining_pool": {"name": "X"}, "analysis": {}}
        pg.upsert_block(doc)
        pg.upsert_block({**doc, "mining_pool": {"name": "Z"}, "analysis": {"flags": [{"k": 1}]}})
        block = pg.get_block(BASE_HEIGHT + 1)
        self.assertEqual(block["mining_pool"], {"name": "Z"})
        self.assertEqual(block["analysis"], {"flags": [{"k": 1}]})
        self.assertEqual(block["coinbase_script_sig"], "00")

    def test_heights_between_and_hash_listing(self):
        for i, h in enumerate((BASE_HEIGHT + 10, BASE_HEIGHT + 12)):
            pg.upsert_block({"height": h, "block_hash": f"{i}" * 64, "timestamp": h})
        self.assertEqual(sorted(pg.heights_between(BASE_HEIGHT + 10, BASE_HEIGHT + 12)), [BASE_HEIGHT + 10])
        listed = [r for r in pg.list_block_hashes() if BASE_HEIGHT + 10 <= r["height"] <= BASE_HEIGHT + 12]
        self.assertEqual(listed, [{"block_hash": "1" * 64, "height": BASE_HEIGHT + 12},
                                  {"block_hash": "0" * 64, "height": BASE_HEIGHT + 10}])
        self.assertGreaterEqual(pg.highest_block()["height"], BASE_HEIGHT + 12)
        self.assertLessEqual(pg.lowest_block()["height"], BASE_HEIGHT + 10)

    def test_pools_replace(self):
        pg.replace_pools([{"name": "P", "tag": "t", "addresses": ["x"], "link": "l"}])
        self.assertEqual(pg.list_pools(), [{"name": "P", "tag": "t", "addresses": ["x"], "link": "l"}])
        pg.replace_pools([{"name": "Q", "id": 2}])
        self.assertEqual(pg.list_pools(), [{"name": "Q", "id": 2}])

    def test_btc_templates_for_height_round_trip(self):
        from psycopg.types.json import Jsonb

        height = BASE_HEIGHT + 20
        ts_ns = 1_790_000_000_123_456_789
        base = {"ts": datetime.fromtimestamp(ts_ns // 1_000_000_000, tz=timezone.utc), "ts_ns": ts_ns,
                "doc_id": None, "pool": "AntPool", "connection_id": "AntPool", "site": "us-ash-legacy",
                "mode": "observe", "height": height, "prev_hash": "p", "job_id": "1", "version": "20000000",
                "nbits": "1703", "ntime": "66", "clean_jobs": True, "coinbase1": "aa", "coinbase2": "bb",
                "extranonce1": "e1", "extranonce2_length": 8, "merkle_branches": ["m1", "m2"],
                "chain_family": None, "extra": None}
        rows = [{**base, "mid": b"\x01" * 16, "extra": Jsonb({"foo": "bar"})},
                {**base, "mid": b"\x02" * 16, "chain_family": "bch"}]
        with self.conn.cursor() as cur:
            for r in rows:
                cols = list(r)
                cur.execute(f"INSERT INTO templates ({', '.join(cols)}) VALUES ({', '.join('%(' + c + ')s' for c in cols)})", r)
        docs = pg.btc_templates_for_height(height)
        self.assertEqual(docs, [{
            "timestamp": format(ts_ns, "x"), "pool_name": "AntPool", "height": height, "job_id": "1",
            "prev_hash": "p", "coinbase1": "aa", "coinbase2": "bb", "merkle_branches": ["m1", "m2"],
            "version": "20000000", "nbits": "1703", "ntime": "66", "clean_jobs": True, "extranonce1": "e1",
            "extranonce2_length": 8, "foo": "bar",
        }])


if __name__ == "__main__":
    unittest.main()
