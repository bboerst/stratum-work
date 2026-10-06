# scripts/tests/test_migrate_mongo_to_postgres.py
import datetime as dt
import hashlib
import json
import os
import random
import sys
import unittest
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import migrate_mongo_to_postgres as mig  # noqa: E402

DOC = {"_id": "abc", "timestamp": "18a5c3d2e1f00000", "pool_name": "AntPool", "height": 1, "job_id": "j", "prev_hash": "p",
       "coinbase1": "a", "coinbase2": "b", "merkle_branches": [], "version": "v", "nbits": "n", "ntime": "t",
       "clean_jobs": True, "extranonce1": "e", "extranonce2_length": 8, "weird": 1}


class DocToRowTest(unittest.TestCase):
    def test_basic_fields(self):
        row = mig.doc_to_row(DOC)
        self.assertEqual(row["ts_ns"], int("18a5c3d2e1f00000", 16))
        self.assertEqual(row["pool"], "AntPool")
        self.assertEqual(row["connection_id"], "AntPool")
        self.assertEqual(row["site"], "us-ash-legacy")
        self.assertEqual(row["extra"], {"weird": 1})
        self.assertEqual(len(row["mid"]), 16)

    def test_mid_is_deterministic(self):
        self.assertEqual(mig.doc_to_row(DOC)["mid"], mig.doc_to_row(dict(DOC))["mid"])

    def test_day_bounds_are_constant_width_hex(self):
        lo, hi = mig.day_bounds_hex("2026-01-01")
        self.assertEqual(len(lo), len(hi))
        self.assertLess(lo, hi)

    def test_string_clean_jobs(self):
        self.assertTrue(mig.doc_to_row({**DOC, "clean_jobs": "true"})["clean_jobs"])


class DocToRowParityTest(unittest.TestCase):
    """Mirrors stream/src/serialize.ts#messageToTemplateRow for the same document."""

    def test_mid_is_sha256_prefix_of_canonical_json_with_stringified_id(self):
        class FakeObjectId:
            def __str__(self):
                return "65f0c0ffee"
        doc = {**DOC, "_id": FakeObjectId()}
        body = json.dumps({**DOC, "_id": "65f0c0ffee"}, sort_keys=True, separators=(",", ":")).encode()
        row = mig.doc_to_row(doc)
        self.assertEqual(row["mid"], hashlib.sha256(body).digest()[:16])
        self.assertEqual(row["doc_id"], "65f0c0ffee")

    def test_mid_ignores_key_order(self):
        reordered = dict(reversed(list(DOC.items())))
        self.assertEqual(mig.doc_to_row(reordered)["mid"], mig.doc_to_row(DOC)["mid"])

    def test_ts_is_millisecond_truncated_like_js_date(self):
        ns = 1_790_000_000_123_456_789
        row = mig.doc_to_row({**DOC, "timestamp": format(ns, "x")})
        self.assertEqual(row["ts"], dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(milliseconds=ns // 1_000_000))
        self.assertEqual(row["ts"].microsecond % 1000, 0)
        self.assertEqual(row["ts_ns"], ns)

    def test_all_columns_present_in_insert_order(self):
        self.assertEqual(list(mig.doc_to_row(DOC).keys()), mig.TEMPLATE_COLS)

    def test_optional_fields_default_like_serialize(self):
        doc = {k: v for k, v in DOC.items() if k not in ("nbits", "ntime", "extranonce1", "weird")}
        row = mig.doc_to_row(doc)
        self.assertIsNone(row["nbits"])
        self.assertIsNone(row["ntime"])
        self.assertIsNone(row["extranonce1"])
        self.assertIsNone(row["extra"])
        self.assertIsNone(row["account"])
        self.assertIsNone(row["endpoint_ip"])
        self.assertIsNone(row["chain_family"])
        self.assertIsNone(row["lat_ms"])
        self.assertIsNone(row["lat_m"])
        self.assertEqual(row["mode"], "observe")

    def test_connection_fields_pass_through(self):
        doc = {**DOC, "site": "eu-1", "connection_id": "eu-1/AntPool/work", "mode": "work", "account": "acct",
               "endpoint_ip": "1.2.3.4", "chain_family": "btc", "lat_ms": 1.5, "lat_m": "tcp"}
        row = mig.doc_to_row(doc)
        self.assertEqual((row["site"], row["connection_id"], row["mode"], row["account"], row["endpoint_ip"]),
                         ("eu-1", "eu-1/AntPool/work", "work", "acct", "1.2.3.4"))
        self.assertEqual((row["chain_family"], row["lat_ms"], row["lat_m"]), ("btc", 1.5, "tcp"))
        self.assertEqual(row["extra"], {"weird": 1})

    def test_empty_connection_id_is_kept_like_nullish_coalescing(self):
        self.assertEqual(mig.doc_to_row({**DOC, "connection_id": ""})["connection_id"], "")

    def test_missing_pool_name_and_height_use_brief_fallbacks(self):
        row = mig.doc_to_row({k: v for k, v in DOC.items() if k not in ("pool_name", "height")})
        self.assertEqual((row["pool"], row["connection_id"], row["height"]), ("unknown", "unknown", 0))
        self.assertIsNone(mig.template_row_problem(row))

    def test_numeric_job_id_is_stringified(self):
        self.assertEqual(mig.doc_to_row({**DOC, "job_id": 42})["job_id"], "42")

    def test_other_clean_jobs_values_are_false(self):
        for v in (False, "false", 1, None, "True"):
            self.assertFalse(mig.doc_to_row({**DOC, "clean_jobs": v})["clean_jobs"], v)

    def test_non_json_extra_values_are_made_json_safe(self):
        when = dt.datetime(2024, 1, 1, tzinfo=dt.timezone.utc)
        row = mig.doc_to_row({**DOC, "seen": when})
        self.assertEqual(row["extra"]["seen"], str(when))


class ValidationTest(unittest.TestCase):
    def test_valid_row_has_no_problem(self):
        self.assertIsNone(mig.template_row_problem(mig.doc_to_row(DOC)))

    def test_problems_mirror_stream_validation(self):
        cases = {
            "height": {**DOC, "height": 2 ** 31},
            "extranonce2_length": {**DOC, "extranonce2_length": "x"},
            "merkle_branches": {**DOC, "merkle_branches": ["a", 1]},
            "lat_ms": {**DOC, "lat_ms": "slow"},
            "prev_hash": {k: v for k, v in DOC.items() if k != "prev_hash"},
            "job_id": {k: v for k, v in DOC.items() if k != "job_id"},
            "coinbase1": {**DOC, "coinbase1": "a\x00b"},
            "extra": {**DOC, "weird": "a\x00"},
        }
        for field, doc in cases.items():
            self.assertEqual(mig.template_row_problem(mig.doc_to_row(doc)), field, field)

    def test_invalid_document_error_names_field_and_id_but_not_content(self):
        doc = {**DOC, "_id": "doc-1", "coinbase1": "secret\x00stuff"}
        with self.assertRaises(mig.InvalidDocument) as cm:
            mig.checked_row(doc)
        msg = str(cm.exception)
        self.assertIn("doc-1", msg)
        self.assertIn("coinbase1", msg)
        self.assertNotIn("secret", msg)


class DayHelpersTest(unittest.TestCase):
    def test_day_bounds_values(self):
        lo, hi = mig.day_bounds_hex("2026-01-01")
        start = int(dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc).timestamp()) * 1_000_000_000
        self.assertEqual(int(lo, 16), start)
        self.assertEqual(int(hi, 16), start + 86_400 * 1_000_000_000)
        self.assertEqual(len(lo), 16)

    def test_normalize_hex_pads_and_lowercases(self):
        self.assertEqual(mig.normalize_hex("18A5C3D2E1F00000"), "18a5c3d2e1f00000")
        self.assertEqual(mig.normalize_hex("0x0f"), "000000000000000f")

    def test_day_of_hex(self):
        self.assertEqual(mig.day_of_hex(mig.day_bounds_hex("2025-03-04")[0]), "2025-03-04")
        self.assertEqual(mig.day_of_hex(format(int(mig.day_bounds_hex("2025-03-05")[0], 16) - 1, "x")), "2025-03-04")

    def test_days_between_inclusive(self):
        self.assertEqual(list(mig.days_between("2025-12-30", "2026-01-02")),
                         ["2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02"])

    def test_day_filter_clamps_to_before(self):
        lo, hi = mig.day_bounds_hex("2025-03-04")
        mid_day = format(int(lo, 16) + 3600 * 10 ** 9, "016x")
        self.assertEqual(mig.day_filter("2025-03-04", mid_day), {"timestamp": {"$gte": lo, "$lt": mid_day}})
        self.assertEqual(mig.day_filter("2025-03-04", "f" * 16), {"timestamp": {"$gte": lo, "$lt": hi}})
        self.assertIsNone(mig.day_filter("2025-03-04", lo))


class BlockAndPoolMappingTest(unittest.TestCase):
    def test_block_prisma_pool_maps_to_mining_pool(self):
        doc = mig.block_doc_to_row({"_id": object(), "height": 5, "block_hash": "h", "timestamp": 10, "pool": {"name": "X"}})
        self.assertEqual(doc, {"height": 5, "block_hash": "h", "timestamp": 10, "mining_pool": {"name": "X"}})

    def test_block_mining_pool_wins_over_pool(self):
        doc = mig.block_doc_to_row({"height": 5, "block_hash": "h", "timestamp": 10, "pool": {"name": "old"},
                                    "mining_pool": {"name": "new"}, "analysis": {"a": 1}, "nonce": 7})
        self.assertEqual(doc["mining_pool"], {"name": "new"})
        self.assertEqual(doc["analysis"], {"a": 1})
        self.assertEqual(doc["nonce"], 7)
        self.assertNotIn("pool", doc)

    def test_block_datetime_timestamp_becomes_epoch_seconds(self):
        when = dt.datetime(2024, 1, 1, tzinfo=dt.timezone.utc)
        self.assertEqual(mig.block_doc_to_row({"height": 1, "block_hash": "h", "timestamp": when})["timestamp"],
                         int(when.timestamp()))

    def test_pool_doc_drops_object_id(self):
        self.assertEqual(mig.pool_doc_to_json({"_id": object(), "name": "P", "tag": "t", "addresses": ["a"]}),
                         {"name": "P", "tag": "t", "addresses": ["a"]})


class ParserTest(unittest.TestCase):
    def test_urls_default_from_env(self):
        old = {k: os.environ.get(k) for k in ("MONGO_URL", "PG_URL")}
        os.environ["MONGO_URL"], os.environ["PG_URL"] = "mongodb://m", "postgresql://p"
        try:
            args = mig.build_parser().parse_args(["--before-hex-ns", "18a5c3d2e1f00000"])
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.assertEqual((args.mongo_url, args.pg_url), ("mongodb://m", "postgresql://p"))
        self.assertEqual(args.mongo_db, "stratum-logger")
        self.assertEqual(args.collections, "templates,blocks,pools")
        self.assertEqual(args.batch, 5000)
        self.assertFalse(args.verify_only)


# ---------------------------------------------------------------------------
# Postgres integration (TEST_DATABASE_URL); Mongo is replaced by an in-memory fake.
# ---------------------------------------------------------------------------

class FakeCursor:
    def __init__(self, docs):
        self._docs = list(docs)

    def batch_size(self, n):
        self.batch = n
        return self

    def sort(self, key, direction):
        self._docs.sort(key=lambda d: d.get(key), reverse=direction < 0)
        return self

    def limit(self, n):
        self._docs = self._docs[:n]
        return self

    def __iter__(self):
        return iter(self._docs)


class FakeCollection:
    def __init__(self, docs):
        self.docs = docs
        self.queries = []
        self.count_bias = 0

    def _match(self, flt):
        out = []
        for d in self.docs:
            ok = True
            for k, cond in (flt or {}).items():
                v = d.get(k)
                if "$gte" in cond and not (isinstance(v, str) and v >= cond["$gte"]):
                    ok = False
                if "$lt" in cond and not (isinstance(v, str) and v < cond["$lt"]):
                    ok = False
            if ok:
                out.append(dict(d))
        return out

    def find(self, flt=None, projection=None):
        self.queries.append(flt)
        return FakeCursor(self._match(flt))

    def count_documents(self, flt):
        return len(self._match(flt)) + self.count_bias


TEST_DB = os.environ.get("TEST_DATABASE_URL")


@unittest.skipUnless(TEST_DB, "TEST_DATABASE_URL not set")
class PostgresIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import psycopg
        cls.pg = psycopg.connect(TEST_DB, autocommit=True)
        mig.ensure_progress_table(cls.pg)

    @classmethod
    def tearDownClass(cls):
        with cls.pg.cursor() as cur:
            cur.execute(f"SELECT count(*) FROM {mig.PROGRESS_TABLE}")
            if cur.fetchone()[0] == 0:
                cur.execute(f"DROP TABLE {mig.PROGRESS_TABLE}")
        cls.pg.close()

    def setUp(self):
        self.tag = "migtest-" + uuid.uuid4().hex[:10]
        base = dt.date(2011, 1, 1) + dt.timedelta(days=random.randrange(0, 5 * 365))
        self.days = [(base + dt.timedelta(days=i)).isoformat() for i in range(3)]
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        lo = mig.day_bounds_hex(self.days[0])[0]
        hi = mig.day_bounds_hex(self.days[-1])[1]
        with self.pg.cursor() as cur:
            cur.execute("DELETE FROM templates WHERE pool = %s AND ts_ns >= %s AND ts_ns < %s",
                        (self.tag, int(lo, 16), int(hi, 16)))
            cur.execute(f"DELETE FROM {mig.PROGRESS_TABLE} WHERE day = ANY(%s::date[])", (self.days,))

    def _docs(self, day, n, offset_s=0):
        lo = int(mig.day_bounds_hex(day)[0], 16)
        return [{**DOC, "_id": uuid.uuid4().hex, "pool_name": self.tag,
                 "timestamp": format(lo + (offset_s + i * 60) * 10 ** 9 + 123_456, "x")} for i in range(n)]

    def _pg_rows(self):
        with self.pg.cursor() as cur:
            cur.execute("SELECT ts, ts_ns, mid, doc_id, extra FROM templates WHERE pool = %s ORDER BY ts_ns", (self.tag,))
            return cur.fetchall()

    def _progress(self):
        with self.pg.cursor() as cur:
            cur.execute(f"SELECT day::text, mongo_count, pg_count FROM {mig.PROGRESS_TABLE} "
                        "WHERE day = ANY(%s::date[]) ORDER BY day", (self.days,))
            return cur.fetchall()

    def _compressed(self, day):
        lo, hi = (dt.datetime.fromisoformat(d).replace(tzinfo=dt.timezone.utc) for d in (day, mig.next_day(day)))
        with self.pg.cursor() as cur:
            cur.execute("SELECT is_compressed FROM timescaledb_information.chunks WHERE hypertable_name = 'templates' "
                        "AND range_start >= %s AND range_end <= %s", (lo, hi))
            return [r[0] for r in cur.fetchall()]

    def test_loads_days_records_progress_and_compresses(self):
        docs = self._docs(self.days[0], 3) + self._docs(self.days[1], 2)
        coll = FakeCollection(docs)
        before = mig.day_bounds_hex(self.days[2])[0]
        results = mig.migrate_templates(coll, self.pg, self.days[0], before, batch=2)

        self.assertEqual(results, [(self.days[0], 3, 3), (self.days[1], 2, 2)])
        self.assertEqual(self._progress(), [(self.days[0], 3, 3), (self.days[1], 2, 2)])
        rows = self._pg_rows()
        self.assertEqual(len(rows), 5)
        expected = sorted((mig.doc_to_row(d) for d in docs), key=lambda r: r["ts_ns"])
        for got, want in zip(rows, expected):
            self.assertEqual((got[0], got[1], bytes(got[2]), got[3], got[4]),
                             (want["ts"], want["ts_ns"], want["mid"], want["doc_id"], want["extra"]))
        self.assertEqual(self._compressed(self.days[0]), [True])
        self.assertEqual(self._compressed(self.days[1]), [True])

    def test_resumes_after_recorded_days_and_is_idempotent(self):
        docs = self._docs(self.days[0], 2) + self._docs(self.days[1], 2)
        before = mig.day_bounds_hex(self.days[2])[0]
        mig.migrate_templates(FakeCollection(docs), self.pg, self.days[0], before, batch=10)

        coll = FakeCollection(docs)
        with self.pg.cursor() as cur:
            cur.execute(f"DELETE FROM {mig.PROGRESS_TABLE} WHERE day = %s", (self.days[1],))
        results = mig.migrate_templates(coll, self.pg, self.days[0], before, batch=10)

        self.assertEqual(results, [(self.days[1], 2, 2)])
        lo0, hi0 = mig.day_bounds_hex(self.days[0])
        self.assertFalse(any(q and q["timestamp"]["$gte"] == lo0 for q in coll.queries))
        self.assertEqual(len(self._pg_rows()), 4)

    def test_before_cutoff_excludes_later_docs_on_last_day(self):
        docs = self._docs(self.days[0], 5)
        cutoff = docs[3]["timestamp"]
        results = mig.migrate_templates(FakeCollection(docs), self.pg, self.days[0], cutoff, batch=10)
        self.assertEqual(results, [(self.days[0], 3, 3)])
        self.assertEqual(len(self._pg_rows()), 3)
        self.assertEqual(self._compressed(self.days[0]), [False])

    def test_count_mismatch_fails_loudly_without_recording_progress(self):
        coll = FakeCollection(self._docs(self.days[0], 2))
        coll.count_bias = 1
        with self.assertRaises(mig.CountMismatch) as cm:
            mig.migrate_templates(coll, self.pg, self.days[0], mig.day_bounds_hex(self.days[1])[0], batch=10)
        self.assertIn(self.days[0], str(cm.exception))
        self.assertEqual(self._progress(), [])

    def test_invalid_document_aborts_day(self):
        docs = self._docs(self.days[0], 2)
        docs[1]["coinbase2"] = "x\x00"
        with self.assertRaises(mig.InvalidDocument):
            mig.migrate_templates(FakeCollection(docs), self.pg, self.days[0], mig.day_bounds_hex(self.days[1])[0], batch=10)
        self.assertEqual(self._progress(), [])

    def test_verify_only_does_not_write(self):
        docs = self._docs(self.days[0], 2)
        before = mig.day_bounds_hex(self.days[1])[0]
        results = mig.migrate_templates(FakeCollection(docs), self.pg, self.days[0], before, batch=10, verify_only=True)
        self.assertEqual(results, [(self.days[0], 2, 0)])
        self.assertEqual(self._pg_rows(), [])
        self.assertEqual(self._progress(), [])

    def test_oldest_day(self):
        docs = self._docs(self.days[1], 1) + self._docs(self.days[0], 1, offset_s=7200)
        self.assertEqual(mig.oldest_day(FakeCollection(docs)), self.days[0])


@unittest.skipUnless(TEST_DB, "TEST_DATABASE_URL not set")
class PostgresBlocksPoolsTest(unittest.TestCase):
    def setUp(self):
        import psycopg
        self.pg = psycopg.connect(TEST_DB)
        self.addCleanup(self.pg.close)
        self.addCleanup(self.pg.rollback)

    def test_blocks_upsert_like_backend_and_pools_replace(self):
        h = 1_900_000_000 + random.randrange(0, 10_000_000)
        tag = uuid.uuid4().hex
        blocks = FakeCollection([
            {"_id": object(), "height": h, "block_hash": f"{tag}-a", "timestamp": 1, "pool": {"name": "Old"}},
            {"_id": object(), "height": h, "block_hash": f"{tag}-b", "timestamp": 2, "pool": {"name": "Reorg"},
             "analysis": {"flags": ["x"]}},
            {"_id": object(), "height": h + 1, "block_hash": f"{tag}-c", "timestamp": 3, "mining_pool": {"name": "C"},
             "coinbase_script_sig": "03ab", "difficulty": 1.5, "nonce": 4_000_000_000},
        ])
        pools = FakeCollection([{"_id": object(), "name": f"{tag}-P", "tag": "/P/", "addresses": ["bc1q"]},
                                {"_id": object(), "name": f"{tag}-Q"}])
        with self.pg.transaction(force_rollback=True):
            mig.migrate_blocks(blocks, self.pg, batch=2)
            mig.migrate_pools(pools, self.pg)
            with self.pg.cursor() as cur:
                cur.execute("SELECT height, block_hash, timestamp, mining_pool, analysis, nonce, difficulty FROM blocks "
                            "WHERE height IN (%s, %s) ORDER BY height", (h, h + 1))
                self.assertEqual(cur.fetchall(), [
                    (h, f"{tag}-b", 2, {"name": "Reorg"}, {"flags": ["x"]}, None, None),
                    (h + 1, f"{tag}-c", 3, {"name": "C"}, None, 4_000_000_000, 1.5),
                ])
                cur.execute("SELECT name, tag, addresses, doc FROM pools ORDER BY id")
                self.assertEqual(cur.fetchall(), [
                    (f"{tag}-P", "/P/", ["bc1q"], {"name": f"{tag}-P", "tag": "/P/", "addresses": ["bc1q"]}),
                    (f"{tag}-Q", None, [], {"name": f"{tag}-Q"}),
                ])


if __name__ == "__main__":
    unittest.main()
