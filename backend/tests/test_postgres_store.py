import os
import sys
import unittest
from contextlib import contextmanager

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from integrations import postgres  # noqa: E402


def legacy_row(**overrides):
    row = {"ts_ns": int("18a5c3d2e1f00000", 16), "mid": b"\x01" * 16, "doc_id": "id1", "pool": "AntPool",
           "connection_id": "AntPool", "site": "us-ash-legacy", "mode": "observe", "account": None,
           "endpoint_ip": None, "height": 1, "prev_hash": "p", "job_id": "j", "version": "v", "nbits": "n",
           "ntime": "t", "clean_jobs": True, "coinbase1": "a", "coinbase2": "b", "extranonce1": "e",
           "extranonce2_length": 8, "merkle_branches": ["m"], "chain_family": None, "lat_ms": None,
           "lat_m": None, "extra": None}
    row.update(overrides)
    return row


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.conn.executed.append((sql, params, self.conn.in_tx))

    def fetchall(self):
        return self.conn.results.pop(0) if self.conn.results else []

    def fetchone(self):
        rows = self.fetchall()
        return rows[0] if rows else None


class FakeConn:
    closed = False

    def __init__(self, results=None):
        self.executed = []
        self.results = list(results or [])
        self.in_tx = False

    def cursor(self):
        return FakeCursor(self)

    @contextmanager
    def transaction(self):
        self.in_tx = True
        try:
            yield
        finally:
            self.in_tx = False


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self._saved = (postgres._conn, postgres.ENABLED)
        postgres.ENABLED = True

    def tearDown(self):
        postgres._conn, postgres.ENABLED = self._saved

    def use(self, conn):
        postgres._conn = conn
        return conn


class RowToDocTest(unittest.TestCase):
    def test_legacy_row_round_trip(self):
        doc = postgres.row_to_template_doc(legacy_row())
        self.assertEqual(doc, {
            "_id": "id1", "timestamp": "18a5c3d2e1f00000", "pool_name": "AntPool", "height": 1, "job_id": "j",
            "prev_hash": "p", "coinbase1": "a", "coinbase2": "b", "merkle_branches": ["m"], "version": "v",
            "nbits": "n", "ntime": "t", "clean_jobs": True, "extranonce1": "e", "extranonce2_length": 8,
        })
        self.assertEqual(list(doc)[:3], ["_id", "timestamp", "pool_name"])

    def test_nullable_fields_omitted_except_extranonce1(self):
        doc = postgres.row_to_template_doc(legacy_row(doc_id=None, nbits=None, ntime=None, extranonce1=None))
        self.assertNotIn("_id", doc)
        self.assertNotIn("nbits", doc)
        self.assertNotIn("ntime", doc)
        self.assertIn("extranonce1", doc)
        self.assertIsNone(doc["extranonce1"])
        self.assertNotIn("mid", doc)

    def test_non_legacy_connection_emits_site_fields_and_optionals(self):
        doc = postgres.row_to_template_doc(legacy_row(
            site="eu-1", connection_id="AntPool-2", mode="work", account="acct", endpoint_ip="1.2.3.4",
            lat_ms=12.5, lat_m="rtt", chain_family="bch"))
        self.assertEqual(doc["site"], "eu-1")
        self.assertEqual(doc["connection_id"], "AntPool-2")
        self.assertEqual(doc["mode"], "work")
        self.assertEqual(doc["account"], "acct")
        self.assertEqual(doc["endpoint_ip"], "1.2.3.4")
        self.assertEqual(doc["lat_ms"], 12.5)
        self.assertEqual(doc["lat_m"], "rtt")
        self.assertEqual(doc["chain_family"], "bch")

    def test_any_legacy_default_mismatch_emits_all_three(self):
        doc = postgres.row_to_template_doc(legacy_row(mode="work"))
        self.assertEqual((doc["site"], doc["connection_id"], doc["mode"]), ("us-ash-legacy", "AntPool", "work"))

    def test_extra_merged_back(self):
        doc = postgres.row_to_template_doc(legacy_row(extra={"foo": 1, "bar": {"x": [1]}}))
        self.assertEqual(doc["foo"], 1)
        self.assertEqual(doc["bar"], {"x": [1]})

    def test_extra_json_string_merged_back(self):
        doc = postgres.row_to_template_doc(legacy_row(extra='{"foo": 2}'))
        self.assertEqual(doc["foo"], 2)

    def test_ts_ns_as_string(self):
        doc = postgres.row_to_template_doc(legacy_row(ts_ns=str(int("18a5c3d2e1f00000", 16))))
        self.assertEqual(doc["timestamp"], "18a5c3d2e1f00000")


class BlockStatementTest(unittest.TestCase):
    def test_block_upsert_sql_covers_all_columns(self):
        sql, params = postgres.block_upsert_statement({"height": 5, "block_hash": "h", "timestamp": 1,
                                                       "coinbase_script_sig": "c", "mining_pool": {"name": "x"},
                                                       "analysis": {}})
        self.assertIn("ON CONFLICT (block_hash) DO UPDATE", sql)
        self.assertEqual(params["height"], 5)
        for col in ("height", "block_hash", "timestamp", "coinbase_script_sig", "mining_pool", "analysis"):
            self.assertIn(f"%({col})s", sql)
        self.assertNotIn("block_hash = EXCLUDED.block_hash", sql)
        self.assertIn("mining_pool = EXCLUDED.mining_pool", sql)
        self.assertEqual(params["mining_pool"].obj, {"name": "x"})
        self.assertEqual(params["analysis"].obj, {})

    def test_unknown_keys_ignored(self):
        sql, params = postgres.block_upsert_statement({"height": 5, "block_hash": "h", "timestamp": 1, "_id": "x"})
        self.assertNotIn("_id", params)
        self.assertNotIn("_id", sql)


class StoreCallsTest(StoreTestCase):
    def test_upsert_block_replaces_other_hash_at_height_in_one_transaction(self):
        conn = self.use(FakeConn())
        postgres.upsert_block({"height": 7, "block_hash": "h", "timestamp": 1})
        self.assertEqual(len(conn.executed), 2)
        self.assertIn("DELETE FROM blocks", conn.executed[0][0])
        self.assertEqual(conn.executed[0][1], {"height": 7, "block_hash": "h"})
        self.assertIn("INSERT INTO blocks", conn.executed[1][0])
        self.assertTrue(all(in_tx for _, _, in_tx in conn.executed))

    def test_upsert_block_noop_when_disabled(self):
        conn = self.use(FakeConn())
        postgres.ENABLED = False
        postgres.upsert_block({"height": 7, "block_hash": "h", "timestamp": 1})
        self.assertEqual(conn.executed, [])

    def test_heights_between(self):
        conn = self.use(FakeConn([[{"height": 3}, {"height": 4}]]))
        self.assertEqual(postgres.heights_between(3, 5), [3, 4])
        self.assertEqual(conn.executed[0][1], (3, 5))

    def test_highest_lowest_get_block(self):
        self.use(FakeConn([[{"height": 9}], [{"height": 1}], [], [{"height": 4, "block_hash": "x"}]]))
        self.assertEqual(postgres.highest_block(), {"height": 9})
        self.assertEqual(postgres.lowest_block(), {"height": 1})
        self.assertIsNone(postgres.get_block(2))
        self.assertEqual(postgres.get_block(4)["block_hash"], "x")

    def test_list_block_hashes(self):
        rows = [{"block_hash": "b", "height": 2}, {"block_hash": "a", "height": 1}]
        conn = self.use(FakeConn([rows]))
        self.assertEqual(postgres.list_block_hashes(), rows)
        self.assertIn("ORDER BY height DESC", conn.executed[0][0])

    def test_replace_pools_single_transaction(self):
        conn = self.use(FakeConn())
        postgres.replace_pools([{"name": "P", "tags": ["t"], "addresses": ["x"], "id": 1},
                                {"name": "Q", "tag": "q"}])
        self.assertIn("DELETE FROM pools", conn.executed[0][0])
        self.assertEqual(len(conn.executed), 3)
        self.assertTrue(all(in_tx for _, _, in_tx in conn.executed))
        name, tag, addresses, doc = conn.executed[1][1]
        self.assertEqual((name, tag, addresses), ("P", None, ["x"]))
        self.assertEqual(doc.obj, {"name": "P", "tags": ["t"], "addresses": ["x"], "id": 1})
        self.assertEqual(conn.executed[2][1][:3], ("Q", "q", []))

    def test_list_pools_returns_docs(self):
        self.use(FakeConn([[{"doc": {"name": "P"}}, {"doc": {"name": "Q"}}]]))
        self.assertEqual(postgres.list_pools(), [{"name": "P"}, {"name": "Q"}])

    def test_btc_templates_for_height_filters_and_converts(self):
        conn = self.use(FakeConn([[legacy_row(height=123)]]))
        docs = postgres.btc_templates_for_height(123)
        sql, params, _ = conn.executed[0]
        self.assertIn("chain_family IS NULL", sql)
        self.assertIn("ORDER BY ts", sql)
        self.assertEqual(params, (123,))
        self.assertEqual(docs[0]["pool_name"], "AntPool")
        self.assertEqual(docs[0]["height"], 123)


class EnabledFlagTest(unittest.TestCase):
    def test_parse_enabled(self):
        for v in ("true", "True", "1", "yes", "on"):
            self.assertTrue(postgres.parse_enabled(v), v)
        for v in ("false", "0", "no", "off"):
            self.assertFalse(postgres.parse_enabled(v), v)
        self.assertTrue(postgres.parse_enabled("garbage"))


if __name__ == "__main__":
    unittest.main()
