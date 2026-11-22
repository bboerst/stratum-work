import os
import pathlib
import sys
import time
import unittest
import unittest.mock
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tests"))
from main_harness import load_store_module  # noqa: E402

store_module = load_store_module()
PostgresStore = store_module.PostgresStore


class MakeStoreTests(unittest.TestCase):
    def test_postgres_unless_historical_data_is_off(self):
        with unittest.mock.patch.dict(os.environ, {"ENABLE_HISTORICAL_DATA": "true"}):
            store = store_module.make_store()
        self.assertIsInstance(store, PostgresStore)
        self.assertTrue(store.enabled)
        with unittest.mock.patch.dict(os.environ, {"ENABLE_HISTORICAL_DATA": "false"}):
            self.assertFalse(store_module.make_store().enabled)


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

    def test_coinbase_facts_are_written_and_the_fill_only_touches_nulls(self):
        h = self.h + 30
        br = "ab" * 32 + "cd" * 32
        doc = dict(self._block(h, "d1"), merkle_branches=br, coinbase_txid="ef" * 31 + "01", coinbase_tx="0100")
        self.store.save_block(doc, is_new_block=True)
        self.store.save_block(self._block(h, "d1"), is_new_block=False)     # a save without them keeps them
        self.store.save_block(self._block(h + 1, "d2"), is_new_block=False)
        self.assertIn("d2" * 32, self.store.blocks_missing_branches(100_000))
        self.assertNotIn("d1" * 32, self.store.blocks_missing_branches(100_000))
        self.store.fill_block_coinbase([{"block_hash": "d2" * 32, "merkle_branches": "", "coinbase_txid": "aa" * 32},
                                        {"block_hash": "d1" * 32, "merkle_branches": "00" * 32}])   # d1 unchanged
        with self.psycopg.connect(self.admin) as c:
            rows = {r[0]: r[1:] for r in c.execute(
                "SELECT height, encode(merkle_branches, 'hex'), encode(coinbase_txid, 'hex'), encode(coinbase_tx, 'hex') "
                "FROM blocks WHERE height IN (%s, %s)", (h, h + 1)).fetchall()}
        # the txid is stored in internal byte order (reversed from the display hex)
        self.assertEqual(rows[h], (br, "01" + "ef" * 31, "0100"))
        self.assertEqual(rows[h + 1], ("", "aa" * 32, None))          # an empty block: empty branches, no coinbase bytes

    def test_header_columns_are_written_and_the_fill_only_touches_nulls(self):
        h = self.h + 20
        full = dict(self._block(h, "c1"), transactions=3123, size=1_550_000, weight=3_993_000, version=0x2000E000,
                    merkle_root="cd" * 32, bits="17034219", nonce=123456789, difficulty=1.5e14)
        self.store.save_block(full, is_new_block=True)
        self.store.save_block(self._block(h, "c1"), is_new_block=False)     # a save without them keeps them
        self.store.save_block(self._block(h + 1, "c2"), is_new_block=False)  # stored without header columns
        self.assertIn("c2" * 32, self.store.blocks_missing_header(100_000))
        self.assertNotIn("c1" * 32, self.store.blocks_missing_header(100_000))
        n = self.store.fill_block_headers([{"block_hash": "c2" * 32, "transactions": 5, "version": 1,
                                            "merkle_root": "ef" * 32, "bits": "1d00ffff", "nonce": 9, "difficulty": 1.0},
                                           {"block_hash": "c1" * 32, "transactions": 999}])  # c1: already set, unchanged
        self.assertEqual(n, 2)
        with self.psycopg.connect(self.admin) as c:
            rows = {r[0]: r[1:] for r in c.execute(
                "SELECT height, tx_count, size, weight, version, encode(merkle_root, 'hex'), bits, nonce, difficulty "
                "FROM blocks WHERE height IN (%s, %s)", (h, h + 1)).fetchall()}
        self.assertEqual(rows[h], (3123, 1_550_000, 3_993_000, 0x2000E000, "cd" * 32, 0x17034219, 123456789, 1.5e14))
        self.assertEqual(rows[h + 1], (5, None, None, 1, "ef" * 32, 0x1d00ffff, 9, 1.0))

    def test_seen_at_is_the_given_arrival_time_and_seen_via_is_kept_with_it(self):
        h = self.h + 7
        arrived = datetime(2026, 11, 18, 0, 0, 1, 250_000, tzinfo=timezone.utc)
        self.store.save_block(self._block(h, "b1"), is_new_block=True, seen_at=arrived, seen_via="zmq")
        # later saves (the reconciliation, a re-sync) never move the first live sighting or its label
        self.store.save_block(self._block(h, "b1"), is_new_block=True, seen_via="reconcile")
        self.store.save_block(self._block(h, "b1"), is_new_block=False)
        self.store.save_block(self._block(h + 1, "b2"), is_new_block=True, seen_via="reconcile")   # found, not announced
        self.store.save_block(self._block(h + 2, "b3"), is_new_block=False)                         # synced: not seen live
        with self.psycopg.connect(self.admin) as c:
            rows = dict((r[0], r[1:]) for r in c.execute(
                "SELECT height, seen_at, seen_via FROM blocks WHERE height BETWEEN %s AND %s", (h, h + 2)).fetchall())
        self.assertEqual(rows[h], (arrived, "zmq"))
        self.assertIsNotNone(rows[h + 1][0])
        self.assertEqual(rows[h + 1][1], "reconcile")
        self.assertEqual(rows[h + 2], (None, None))

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
            # d1 Unknown, so the re-identify read (Unknown blocks only) must still return it although it is stale
            pool = {"id": "unknown", "name": "Unknown"} if hb == "d1" else None
            self.store.save_block(self._block(height, hb, pool=pool), is_new_block=False)
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
        block = self._block(h, "c3", pool={"id": "unknown", "name": "Unknown"})
        block["analysis"] = {"pool_identification": {"method": "address", "addresses_considered": ["bc1qx"]},
                             "flags": [{"type": "kept"}]}
        self.store.save_block(block, is_new_block=True)
        self.store.save_block(self._block(h, "c4"), is_new_block=True)    # identified: never read for re-identification
        read = {b["block_hash"] for b in self.store.blocks_for_reidentify()}
        self.assertNotIn("c4" * 32, read)
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

    def test_coinbase_reanalysis_replaces_only_the_coinbase_keys_of_every_block_at_the_height(self):
        h = self.h + 80
        fork = {"key": "prev_hash_fork", "icon": "fork", "details": {}}
        old_flag = {"key": "invalid_coinbase_no_merkle", "icon": "error", "details": {"offenders": [{"pool_name": "A"}]}}
        for hb, analysis in (("f1", {"pool_identification": {"m": 1}, "flags": [fork, old_flag]}), ("f2", {})):
            b = self._block(h, hb)
            b["analysis"] = analysis
            self.store.save_block(b, is_new_block=False)
        new_flag = {"key": "invalid_coinbase_no_merkle", "icon": "error", "details": {"offenders": [{"pool_name": "B"}]}}
        report = {"repaired": [], "unparsed": [{"pool_name": "B", "extranonce2_length": 4, "templates": 1, "sample_job_id": "j"}]}
        self.assertEqual(len(self.store.update_coinbase_analysis(h, new_flag, report, dry_run=True)), 2)
        with self.psycopg.connect(self.admin) as c:   # the dry run wrote nothing
            self.assertEqual(c.execute("SELECT analysis FROM blocks WHERE block_hash = %s", (bytes.fromhex("f1" * 32),)).fetchone()[0]["flags"][1], old_flag)
        changed = self.store.update_coinbase_analysis(h, new_flag, report)
        self.assertEqual(sorted(ch["block_hash"] for ch in changed), ["f1" * 32, "f2" * 32])
        self.assertEqual(next(ch for ch in changed if ch["block_hash"] == "f1" * 32)["before_flag"], old_flag)
        with self.psycopg.connect(self.admin) as c:
            rows = dict(c.execute("SELECT encode(block_hash, 'hex'), analysis FROM blocks WHERE height = %s", (h,)).fetchall())
        self.assertEqual(rows["f1" * 32], {"pool_identification": {"m": 1}, "flags": [fork, new_flag], "coinbase_parse": report})
        self.assertEqual(rows["f2" * 32], {"flags": [new_flag], "coinbase_parse": report})
        self.assertEqual(self.store.update_coinbase_analysis(h, new_flag, report), [])   # unchanged: nothing written
        self.store.update_coinbase_analysis(h, None, None)
        with self.psycopg.connect(self.admin) as c:
            rows = dict(c.execute("SELECT encode(block_hash, 'hex'), analysis FROM blocks WHERE height = %s", (h,)).fetchall())
        self.assertEqual(rows, {"f1" * 32: {"pool_identification": {"m": 1}, "flags": [fork]}, "f2" * 32: {}})

    def test_pools_replace_keeps_full_definitions_and_deletes_missing(self):
        defs = [{"id": 900001, "name": "Test A", "addresses": ["bc1qa"], "tags": ["/A/"], "link": "https://a", "extra": {"x": 1}},
                {"id": 900002, "name": "Test B", "addresses": [], "tags": ["/B/"], "link": "https://b"}]
        self.store.replace_pools(defs)
        loaded = {p["id"]: p for p in self.store.load_pools()}
        self.assertEqual(loaded[900001], defs[0])          # full definition round-trips, including unmodeled fields
        self.store.replace_pools(defs[:1])                  # B disappears upstream -> deleted
        self.assertNotIn(900002, {p["id"] for p in self.store.load_pools()})

    def test_templates_at_height_document_shape(self):
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

    def test_templates_at_height_reads_only_its_receive_window(self):
        """A template for height h is received between the blocks at h - 1 and h arriving (height_window(), 2 h margin):
        a stuck feed re-sending h's job a day later, or another chain's template at height h, isn't h's."""
        h = self.h + 60
        name = f"itest-{h}"
        t0 = 1_794_500_000   # the block at h - 1 arrives here, the block at h 10 min later
        with self.psycopg.connect(self.admin) as c:
            for height, at in ((h - 1, t0), (h, t0 + 600)):
                c.execute("INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig) "
                          "VALUES (%s, %s, to_timestamp(%s), to_timestamp(%s), '\\x00')",
                          (bytes.fromhex(f"{height:064x}"), height, at, at))
            sid = c.execute("INSERT INTO sources (name, site) VALUES (%s, 'ci') ON CONFLICT (name, site, replica) "
                            "DO UPDATE SET name = EXCLUDED.name RETURNING id", (name,)).fetchone()[0]
            for job, at in (("in", t0 + 5), ("late-but-inside", t0 + 600 + 3600), ("stale", t0 + 86_400)):
                c.execute("""INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2,
                             merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
                             VALUES (to_timestamp(%s), %s, %s, %s, '\\x00', '\\x01', '\\x02', '\\x', 1, 1, 1, true, '\\x03', 4)""",
                          (at, sid, h, job))
        self.assertEqual([d["job_id"] for d in self.store.templates_at_height(h)], ["in", "late-but-inside"])

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
