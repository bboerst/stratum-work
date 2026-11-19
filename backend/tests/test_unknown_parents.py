"""The unknown-parents summary (unknown_parents.py, unknown_parent_pools): windows and chunking, the read bounds
(a parent read whole although it spans several ranges), the refresher's schedule, the CLI, and, against a real
migrated database, the rows unknown_parent_pools_refresh() writes (de-duplication across connections, upsert,
delete, idempotence, a parent longer than the per-block window). The web's Postgres suite
(web/lib/__tests__/pgUnknownParents.test.ts) checks the table against the web's live two-step read field for field.
"""
import contextlib
import io
import json
import os
import pathlib
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tests"))
import unknown_parents as up  # noqa: E402

T0 = datetime(2026, 1, 5, 12, 0, tzinfo=timezone.utc)
H = timedelta(hours=1)


class FakeStore:
    """templates: (prev_hash, pool, height, received_at); every prev_hash is unknown. The table: {(parent, pool):
    {n, first, last, heights}}, recomputed like unknown_parent_pools_refresh() (no copies here: one row each)."""

    def __init__(self, templates):
        self.templates, self.table, self.calls = list(templates), {}, []

    def unknown_parents_received_between(self, a, b):
        out = {}
        for p, _, h, t in self.templates:
            if a <= t <= b:
                o = out.setdefault(p, {"prev_hash": p, "heights": set(), "first": t, "last": t})
                o["heights"].add(h)
                o["first"], o["last"] = min(o["first"], t), max(o["last"], t)
        return [dict(o, heights=sorted(o["heights"])) for o in sorted(out.values(), key=lambda o: (o["first"], o["prev_hash"]))]

    def unknown_parent_extents(self, hashes):
        out = {}
        for (p, _), r in self.table.items():
            if p in hashes:
                o = out.setdefault(p, {"heights": set(), "first": r["first"], "last": r["last"]})
                o["heights"] |= set(r["heights"])
                o["first"], o["last"] = min(o["first"], r["first"]), max(o["last"], r["last"])
        return {p: dict(o, heights=sorted(o["heights"])) for p, o in out.items()}

    def refresh_unknown_parent(self, p, heights, a, b):
        self.calls.append((p, list(heights), a, b))
        rows = {}
        for tp, pool, h, t in self.templates:
            if tp == p and h in heights and a <= t <= b:
                r = rows.setdefault(pool, {"n": 0, "first": t, "last": t, "heights": {}})
                r["n"] += 1
                r["first"], r["last"] = min(r["first"], t), max(r["last"], t)
                r["heights"][h] = r["heights"].get(h, 0) + 1
        for key in [k for k in self.table if k[0] == p and k[1] not in rows]:
            del self.table[key]                          # a pool with no template left
        for pool, r in rows.items():
            self.table[(p, pool)] = r
        return len(rows)

    def first_template_received(self):
        return min((t for *_, t in self.templates), default=None)


class WindowTests(unittest.TestCase):
    def test_consecutive_chunks_share_boundaries_and_end_at_to(self):
        ws = up.windows(T0, T0 + timedelta(days=16), timedelta(days=7))
        self.assertEqual(ws, [(T0, T0 + timedelta(days=7)), (T0 + timedelta(days=7), T0 + timedelta(days=14)),
                              (T0 + timedelta(days=14), T0 + timedelta(days=16))])
        self.assertEqual(up.windows(T0, T0, timedelta(days=7)), [])
        with self.assertRaises(ValueError):
            up.windows(T0, T0 + H, timedelta(0))

    def test_bounds_merge_the_stored_extent_and_add_the_margin(self):
        seen = {"heights": [101], "first": T0, "last": T0 + H}
        self.assertEqual(up.bounds(seen, None, H), ([101], T0 - H, T0 + 2 * H))
        stored = {"heights": [100, 101], "first": T0 - 5 * H, "last": T0 - 4 * H}
        self.assertEqual(up.bounds(seen, stored, H), ([100, 101], T0 - 6 * H, T0 + 2 * H))

    def test_durations_and_times(self):
        self.assertEqual(up.parse_duration("7d"), timedelta(days=7))
        self.assertEqual(up.parse_duration("12h"), timedelta(hours=12))
        self.assertEqual(up.parse_duration("30m"), timedelta(minutes=30))
        for bad in ("0d", "7", "1w", ""):
            with self.assertRaises(Exception):
                up.parse_duration(bad)
        self.assertEqual(up.parse_time("2026-01-05"), datetime(2026, 1, 5, tzinfo=timezone.utc))
        self.assertEqual(up.parse_time("2026-01-05T12:00Z"), T0)


class RefreshTests(unittest.TestCase):
    def test_refresh_reads_each_parent_within_its_merged_bounds(self):
        s = FakeStore([(b"P", "x", 100, T0), (b"P", "y", 100, T0 + H), (b"Q", "x", 7, T0 + 2 * H)])
        out = up.refresh(s, T0, T0 + 3 * H, margin=H)
        self.assertEqual((out["parents"], out["rows"]), ([b"P", b"Q"], 3))
        self.assertEqual(s.calls, [(b"P", [100], T0 - H, T0 + 2 * H), (b"Q", [7], T0 + H, T0 + 3 * H)])
        self.assertEqual(s.table[(b"P", "x")]["n"], 1)

    def test_refresh_is_idempotent(self):
        s = FakeStore([(b"P", "x", 100, T0), (b"P", "x", 100, T0 + H)])
        up.refresh(s, T0, T0 + H)
        first = dict(s.table)
        up.refresh(s, T0, T0 + H)
        self.assertEqual(s.table, first)

    def test_a_pool_with_no_template_left_loses_its_row(self):
        s = FakeStore([(b"P", "x", 100, T0), (b"P", "y", 100, T0)])
        up.refresh(s, T0, T0 + H)
        s.templates = [t for t in s.templates if t[1] != "y"]
        up.refresh(s, T0, T0 + H)
        self.assertEqual(set(s.table), {(b"P", "x")})

    def test_a_parent_that_gains_templates_in_a_later_chunk_is_counted_whole(self):
        # 10 days apart (far beyond any margin), and at another height: only the stored extent finds the first ones
        early = [(b"P", "x", 100, T0 + k * H) for k in range(3)]
        late = [(b"P", "x", 101, T0 + timedelta(days=10)), (b"P", "y", 101, T0 + timedelta(days=10, hours=1))]
        s = FakeStore(early + late)
        log = io.StringIO()
        import logging
        lg = logging.getLogger("test.unknown_parents.backfill")
        lg.addHandler(logging.StreamHandler(log))
        lg.setLevel(logging.INFO)
        summary = up.backfill(s, T0, T0 + timedelta(days=14), timedelta(days=7), margin=H, log=lg)
        self.assertEqual(s.table[(b"P", "x")], {"n": 4, "first": T0, "last": T0 + timedelta(days=10),
                                                "heights": {100: 3, 101: 1}})
        self.assertEqual(s.table[(b"P", "y")]["n"], 1)
        self.assertEqual(s.calls[-1], (b"P", [100, 101], T0 - H, T0 + timedelta(days=10, hours=2)))
        self.assertEqual((summary["chunks"], summary["parents"], summary["rows_written"]), (2, 1, 3))
        self.assertIn("backfill 2/2", log.getvalue())
        self.assertIn("backfill done", log.getvalue())

    def test_successive_two_hour_windows_over_a_five_hour_parent(self):
        ts = [(b"P", "x", 100, T0 + timedelta(minutes=10 * k)) for k in range(31)]     # 5 hours
        s = FakeStore(ts)
        for k in range(1, 7):                                                            # a block every hour
            now = T0 + k * H
            up.refresh(s, now - 2 * H, now, margin=timedelta(minutes=5))
            want = sum(1 for *_, t in ts if t <= now)
            self.assertEqual(s.table[(b"P", "x")]["n"], want, now)
            self.assertEqual(s.table[(b"P", "x")]["first"], T0)


class RefresherTests(unittest.TestCase):
    def test_startup_then_per_block_windows_without_gaps(self):
        clock = [T0]
        s = FakeStore([])
        r = up.UnknownParentsRefresher(s, now=lambda: clock[0])
        self.assertEqual(r.range(), (T0 - up.STARTUP_WINDOW, T0))
        r.run_once()
        clock[0] = T0 + timedelta(minutes=10)
        self.assertEqual(r.range(), (clock[0] - up.WINDOW, clock[0]))
        r.run_once()
        clock[0] = T0 + timedelta(hours=5)                       # no block for hours: start where the last run ended
        self.assertEqual(r.range(), (T0 + timedelta(minutes=10), clock[0]))

    def test_a_failed_run_keeps_the_start(self):
        clock = [T0]
        s = FakeStore([])
        r = up.UnknownParentsRefresher(s, now=lambda: clock[0])
        r.run_once()
        s.unknown_parents_received_between = lambda a, b: (_ for _ in ()).throw(RuntimeError("db down"))
        clock[0] = T0 + 3 * H
        with self.assertRaises(RuntimeError):
            r.run_once()
        s.unknown_parents_received_between = FakeStore([]).unknown_parents_received_between
        clock[0] = T0 + 4 * H
        self.assertEqual(r.range(), (T0, T0 + 4 * H))

    def test_request_wakes_the_loop(self):
        r = up.UnknownParentsRefresher(FakeStore([]))
        r.request()
        self.assertTrue(r._wake.is_set())


class CliTests(unittest.TestCase):
    def test_backfill_prints_a_summary_without_pool_names(self):
        s = FakeStore([(b"P", "secret-pool", 100, T0), (b"Q", "secret-pool", 7, T0 + timedelta(days=8))])
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(up.main(["--backfill", "--to", "2026-01-20", "--chunk", "7d"], store=s), 0)
        summary = json.loads(out.getvalue())
        self.assertEqual((summary["from"], summary["chunks"], summary["parents"], summary["rows_written"]),
                         (T0.isoformat(), 3, 2, 2))
        self.assertNotIn("secret-pool", out.getvalue() + err.getvalue())

    def test_without_backfill_it_only_explains(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(up.main([], store=FakeStore([])), 2)


class MainWiringTests(unittest.TestCase):
    """main.py: the refresher starts after the startup sync with its own store and thread, and can be turned off."""

    def setUp(self):
        from unittest import mock
        from main_harness import import_main_module
        self.mock = mock
        self.main, _ = import_main_module()
        self.addCleanup(setattr, self.main, "unknown_parents_refresher", None)

    def test_own_store_and_thread(self):
        mock = self.mock
        own = object()
        store = mock.Mock(enabled=True)
        threads = []
        with mock.patch.object(self.main, "store", store), mock.patch.object(type(store), "from_env", create=True,
                                                                               new=staticmethod(lambda: own)), \
                mock.patch.object(self.main.threading, "Thread", lambda **kw: threads.append(kw) or mock.Mock()):
            self.main.start_unknown_parents_refresher()
        r = self.main.unknown_parents_refresher
        self.assertIs(r.store, own)                       # never the shared store (its lock guards block writes)
        self.assertEqual([t["name"] for t in threads], ["unknown_parents"])
        self.assertEqual(threads[0]["target"], r.run_forever)

    def test_off(self):
        mock = self.mock
        for enabled, storage in ((False, True), (True, False)):
            with mock.patch.multiple(self.main, UNKNOWN_PARENTS_ENABLED=enabled, store=mock.Mock(enabled=storage)):
                self.main.start_unknown_parents_refresher()
            self.assertIsNone(self.main.unknown_parents_refresher)

    def test_a_failure_to_start_is_logged_not_raised(self):
        mock = self.mock
        with mock.patch.object(self.main, "store", mock.Mock(enabled=True)):   # a Mock class has no from_env
            self.main.start_unknown_parents_refresher()
        self.assertIsNone(self.main.unknown_parents_refresher)


@unittest.skipUnless(os.getenv("PG_TEST_HOST"), "set PG_TEST_HOST etc. to run against a migrated Postgres")
class PostgresTests(unittest.TestCase):
    """Against a real, migrated database: seeded as the owner, refreshed as a user in the stratum_backend role."""

    @classmethod
    def setUpClass(cls):
        import psycopg
        from main_harness import load_store_module
        cls.psycopg = psycopg
        cls.store = load_store_module().PostgresStore(dict(
            host=os.environ["PG_TEST_HOST"], port=int(os.getenv("PG_TEST_PORT", "5432")),
            dbname=os.getenv("PG_TEST_DATABASE", "stratum"), user=os.environ["PG_TEST_USER"],
            password=os.environ["PG_TEST_PASSWORD"], sslmode="disable"))
        cls.admin = os.environ["PG_TEST_ADMIN_DSN"]
        run = int(time.time()) % 100000
        cls.tag, cls.site = f"up{run}", f"up-site-{run}"
        cls.T = datetime(2025, 2, 3, 12, 0, tzinfo=timezone.utc) + timedelta(minutes=run % 1000)
        cls.HB = 7_000_000 + (run % 1000) * 10                      # our block's height (far from other suites)
        # display-order hashes, stored in stratum word order like templates.prev_hash
        cls.X = bytes.fromhex(f"00{run:06x}" + "5a" * 24 + "ffffffff")   # unknown parent, two pools
        cls.Y = bytes.fromhex(f"00{run:06x}" + "6b" * 24 + "ffffffff")   # unknown parent, five hours
        cls.B = bytes.fromhex(f"0000{run:06x}" + "b1" * 27)     # a block we know

    def setUp(self):
        with self.psycopg.connect(self.admin) as c:
            self._cleanup(c)
            self.sid = {}
            # multi's b registered first (a lower id): ranks follow (site, replica), not ids
            for name, replica in ((f"{self.tag}-m", "b"), (f"{self.tag}-m", "a"), (f"{self.tag}-s", "a")):
                self.sid[f"{name}/{replica}"] = c.execute(
                    "INSERT INTO sources (name, site, replica) VALUES (%s, %s, %s) RETURNING id",
                    (name, self.site, replica)).fetchone()[0]
            c.execute("INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig) "
                      "VALUES (%s, %s, %s, %s, '\\x00')", (self.B, self.HB, self.T, self.T))
        self.addCleanup(self._cleanup_now)

    def insert(self, src, at, height, job, parent, cb1="01", ntime=1, nbits=0x1703a30c):
        with self.psycopg.connect(self.admin) as c:
            c.execute("INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2,"
                      " merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)"
                      " VALUES (%s, %s, %s, %s, stratum_prev_hash_to_block_hash(%s), decode(%s, 'hex'), '\\x02', '',"
                      " 536870912, %s, %s, true, '\\x03', 8)",
                      (at, self.sid[src], height, job, parent, cb1, nbits, ntime))

    def rows(self):
        with self.psycopg.connect(self.admin) as c:
            return {(bytes(r[0]), r[1]): r[2:] for r in c.execute(
                "SELECT stratum_prev_hash_to_block_hash(prev_hash), pool, n, first_received, last_received, auxpow,"
                "       conns, heights, nbits FROM unknown_parent_pools"
                " WHERE stratum_prev_hash_to_block_hash(prev_hash) = ANY(%s)", ([self.X, self.Y, self.B],)).fetchall()}

    def _cleanup(self, c):
        c.execute("DELETE FROM unknown_parent_pools WHERE stratum_prev_hash_to_block_hash(prev_hash) = ANY(%s)",
                  ([self.X, self.Y, self.B],))
        c.execute("DELETE FROM templates WHERE source_id IN (SELECT id FROM sources WHERE site = %s)", (self.site,))
        c.execute("DELETE FROM sources WHERE site = %s", (self.site,))
        c.execute("DELETE FROM blocks WHERE block_hash = %s", (self.B,))

    def _cleanup_now(self):
        with self.psycopg.connect(self.admin) as c:
            self._cleanup(c)

    def test_rows_dedup_across_connections_and_ignore_known_parents(self):
        m_a, m_b, s = f"{self.tag}-m/a", f"{self.tag}-m/b", f"{self.tag}-s/a"
        T, h = self.T, self.HB + 1
        aux = "01" + "fabe6d6d" + "ab" * 32
        self.insert(m_a, T + timedelta(seconds=10), h, "m1", self.X, ntime=5)
        self.insert(m_b, T + timedelta(seconds=10.5), h, "n1", self.X, ntime=5)   # exact copy of m1: once
        self.insert(m_b, T + timedelta(seconds=40), h, "n2", self.X, cb1=aux)    # only on b, AuxPoW
        self.insert(s, T + timedelta(seconds=5), h, "s1", self.X)
        self.insert(s, T + timedelta(seconds=65), h + 1, "s2", self.X, nbits=0x1d00ffff)
        self.insert(s, T + timedelta(seconds=7), h, "k1", self.B)                 # a known parent: not summarised
        out = up.refresh(self.store, T, T + timedelta(minutes=5))
        got = self.rows()
        sx = self._stratum(self.X)
        self.assertIn(sx, out["parents"])
        self.assertNotIn(self._stratum(self.B), out["parents"])
        self.assertEqual(got, {
            (self.X, f"{self.tag}-m"): (2, T + timedelta(seconds=10), T + timedelta(seconds=40), 1, [1, 2],
                                        {str(h): 2}, {str(0x1703a30c): 2}),
            (self.X, f"{self.tag}-s"): (2, T + timedelta(seconds=5), T + timedelta(seconds=65), 0, [1],
                                        {str(h): 1, str(h + 1): 1}, {str(0x1703a30c): 1, str(0x1d00ffff): 1}),
        })
        # idempotent; then a pool whose templates are gone loses its row
        before = self.rows()
        up.refresh(self.store, T, T + timedelta(minutes=5))
        self.assertEqual(self.rows(), before)
        with self.psycopg.connect(self.admin) as c:
            c.execute("DELETE FROM templates WHERE source_id = %s", (self.sid[s],))
        up.refresh(self.store, T, T + timedelta(minutes=5))
        self.assertEqual(set(self.rows()), {(self.X, f"{self.tag}-m")})

    def test_a_parent_longer_than_the_window_stays_whole(self):
        src, T = f"{self.tag}-s/a", self.T
        times = [T + timedelta(minutes=10 * k) for k in range(31)]                 # five hours on one parent
        for k in range(1, 7):                                                     # a block every hour
            now = T + k * H
            for j, t in enumerate(times):                                         # the templates received by now
                if now - H < t <= now or (k == 1 and t <= now):
                    self.insert(src, t, self.HB + 1, f"y{j}", self.Y, ntime=j)
            up.refresh(self.store, now - up.WINDOW, now)
            n, first, last = self.rows()[(self.Y, f"{self.tag}-s")][:3]
            self.assertEqual((n, first, last), (sum(1 for t in times if t <= now), T, max(t for t in times if t <= now)))
        # a backfill over the same history in 1-hour chunks ends the same
        with self.psycopg.connect(self.admin) as c:
            c.execute("DELETE FROM unknown_parent_pools WHERE stratum_prev_hash_to_block_hash(prev_hash) = %s", (self.Y,))
        up.backfill(self.store, T - H, T + 6 * H, timedelta(hours=1), margin=timedelta(minutes=1))
        self.assertEqual(self.rows()[(self.Y, f"{self.tag}-s")][:3], (31, T, times[-1]))

    def _stratum(self, display: bytes) -> bytes:
        with self.psycopg.connect(self.admin) as c:
            return bytes(c.execute("SELECT stratum_prev_hash_to_block_hash(%s)", (display,)).fetchone()[0])


if __name__ == "__main__":
    unittest.main()
