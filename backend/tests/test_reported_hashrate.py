"""Reported hashrate (reported_hashrate.py, reported_hashrate table): delta reconstruction with gaps, hour keys,
the sanity checks (nothing written on failure), the CLI's configuration, and, against a real migrated database,
an idempotent upsert where a later fetch overwrites the hours it covers again. Synthetic pools only.
"""
import os
import pathlib
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tests"))
import reported_hashrate as rh  # noqa: E402

START = 1_700_001_693            # 28 min 13 s past an hour, like the real file
HOUR0 = START - START % 3600


def pool(i, values, start=START, **kw):
    """A synthetic entry whose history encodes `values` (None = no value) as the site does."""
    history, prev = [], None
    for v in values:
        if v is None:
            history.append("x")
            continue
        history.append(v if prev is None else v - prev)
        prev = v
    last = next((v for v in reversed(values) if v is not None), None)
    e = dict(id=i, pool_id=None, url=f"https://pool-{i}.example", hashrate=(last or 0) * 1.03,
             hashrate_average_1h=last, hashrate_average_7d=last, history_start=start, history_interval=3600,
             history_addlast=True, history=history)
    e.update(kw)
    return e


def doc(n=25, network=1e21, **kw):
    return dict(hashrate=network, time=START + 200 * 3600,
                data=[pool(i, [1e15 * i, None, 1.5e15 * i, 1.2e15 * i], **kw) for i in range(1, n + 1)])


class ReconstructTests(unittest.TestCase):
    def test_first_value_absolute_the_rest_differences(self):
        self.assertEqual(rh.reconstruct([100, 5, -20, 0]), [100, 105, 85, 85])

    def test_gaps_have_no_value_and_the_running_value_carries_across(self):
        self.assertEqual(rh.reconstruct(["x", "x", 50, "x", 10, "z"]), [None, None, 50, None, 60, None])
        self.assertEqual(rh.reconstruct([]), [])
        self.assertEqual(rh.reconstruct([None, True, 7]), [None, None, 7])

    def test_points_are_keyed_by_hour_and_gaps_write_nothing(self):
        e = pool(7, [3e15, None, 4e15])
        self.assertEqual(rh.pool_points(e), [(HOUR0, 3e15), (HOUR0 + 7200, 4e15)])

    def test_an_interval_other_than_an_hour_is_skipped(self):
        self.assertEqual(rh.pool_points(pool(7, [3e15], history_interval=600)), [])
        self.assertEqual(rh.pool_points(pool(7, [3e15], history_start=None)), [])

    def test_rows_carry_the_network_estimate_and_the_site_id(self):
        d = doc(n=2, network=8e20)
        t = datetime(2026, 1, 1, tzinfo=timezone.utc)
        out = rh.rows(d, "src", t)
        self.assertEqual(len(out), 6)                        # 3 valued hours x 2 pools
        self.assertEqual({r["pool_key"] for r in out}, {"1", "2"})
        self.assertTrue(all(r["network_hashrate"] == 8e20 and r["fetched_at"] == t and r["source"] == "src"
                            for r in out))
        self.assertEqual(out[0]["at"], datetime.fromtimestamp(HOUR0, tz=timezone.utc))
        self.assertEqual(out[0]["pool_url"], "https://pool-1.example")


class CheckTests(unittest.TestCase):
    def test_a_sane_file_passes(self):
        problems, counts = rh.check(doc())
        self.assertEqual(problems, [])
        self.assertEqual((counts["pools"], counts["comparable"], counts["matching"]), (25, 25, 25))

    def test_too_few_pools(self):
        self.assertIn("fewer than 20", rh.check(doc(n=19))[0][0])

    def test_network_not_positive(self):
        self.assertTrue(any("network" in p for p in rh.check(doc(network=0))[0]))
        self.assertTrue(any("network" in p for p in rh.check(dict(doc(), hashrate="x"))[0]))

    def test_last_point_off_the_1h_average_for_too_many_pools(self):
        d = doc(n=20)
        for e in d["data"][:3]:                              # 17 of 20 = 85% match
            e["hashrate_average_1h"] *= 1.05
        self.assertTrue(any("17 of 20" in p for p in rh.check(d)[0]))
        d["data"][0]["hashrate_average_1h"] /= 1.05          # 18 of 20 = 90%: enough
        self.assertEqual(rh.check(d)[0], [])

    def test_pools_without_a_figure_are_not_counted(self):
        d = doc(n=20)
        d["data"].append(pool(99, [None, None], hashrate=-2, hashrate_average_1h=None))
        d["data"].append(pool(98, [0, 0], hashrate_average_1h=0))
        self.assertEqual(rh.check(d)[1]["comparable"], 20)


class MainTests(unittest.TestCase):
    class Store:
        def __init__(self):
            self.written = []

        def upsert_reported_hashrate(self, rows):
            self.written.extend(rows)
            return len(rows)

    def test_not_configured_is_a_no_op(self):
        def no_fetch(*a):
            raise AssertionError("must not fetch")
        with self.assertLogs("backend.reported_hashrate", "INFO") as logs:
            self.assertEqual(rh.main(env={}, store=self.Store(), fetcher=no_fetch), 0)
        self.assertIn("not configured", logs.output[0])

    def test_writes_with_headers_and_default_source(self):
        store, calls = self.Store(), []
        env = {"REPORTED_HASHRATE_URL": "https://stats.example/data.js", "REPORTED_HASHRATE_USER_AGENT": "UA",
               "REPORTED_HASHRATE_REFERER": "https://stats.example/"}
        rc = rh.main(env=env, store=store, fetcher=lambda *a: calls.append(a) or doc(), clock=lambda: 1234.5)
        self.assertEqual(rc, 0)
        self.assertEqual(calls, [("https://stats.example/data.js", "UA", "https://stats.example/", 1234.5)])
        self.assertEqual(len(store.written), 75)
        self.assertEqual({r["source"] for r in store.written}, {"miningpoolstats"})

    def test_failed_checks_write_nothing_and_exit_non_zero(self):
        store = self.Store()
        env = {"REPORTED_HASHRATE_URL": "https://stats.example/data.js", "REPORTED_HASHRATE_SOURCE": "s"}
        with self.assertLogs("backend.reported_hashrate", "ERROR"):
            self.assertEqual(rh.main(env=env, store=store, fetcher=lambda *a: doc(n=5)), 1)
            self.assertEqual(rh.main(env=env, store=store, fetcher=lambda *a: ["not", "an", "object"]), 1)
        self.assertEqual(store.written, [])

    def test_a_failed_fetch_exits_non_zero(self):
        def boom(*a):
            raise OSError("HTTP Error 403: Forbidden")
        with self.assertLogs("backend.reported_hashrate", "ERROR") as logs:
            self.assertEqual(rh.main(env={"REPORTED_HASHRATE_URL": "https://stats.example/d"}, store=self.Store(),
                                     fetcher=boom), 1)
        self.assertIn("403", logs.output[0])

    def test_fetch_appends_the_time_and_sends_the_headers(self):
        seen = {}

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{"hashrate": 1}'

        def urlopen(req, timeout):
            seen.update(url=req.full_url, ua=req.get_header("User-agent"), ref=req.get_header("Referer"), t=timeout)
            return Resp()
        orig, rh.urllib.request.urlopen = rh.urllib.request.urlopen, urlopen
        try:
            self.assertEqual(rh.fetch("https://s.example/d.js", "UA", "https://s.example/", 99.9), {"hashrate": 1})
            self.assertEqual(seen, dict(url="https://s.example/d.js?t=99", ua="UA", ref="https://s.example/", t=60))
            rh.fetch("https://s.example/d.js?a=1", None, None, 5)
            self.assertEqual((seen["url"], seen["ua"]), ("https://s.example/d.js?a=1&t=5", None))
        finally:
            rh.urllib.request.urlopen = orig


@unittest.skipUnless(os.getenv("PG_TEST_HOST"), "set PG_TEST_HOST etc. to run against a migrated Postgres")
class PostgresTests(unittest.TestCase):
    """Against a real, migrated database, as a user in the stratum_backend role."""

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
        cls.source = f"test-{os.getpid()}"

    def setUp(self):
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        with self.psycopg.connect(self.admin) as c:
            c.execute("DELETE FROM reported_hashrate WHERE source = %s", (self.source,))

    def table(self):
        with self.psycopg.connect(self.admin) as c:
            return {(k, int(at.timestamp())): (v, n, f) for k, at, v, n, f in c.execute(
                "SELECT pool_key, at, hashrate, network_hashrate, fetched_at FROM reported_hashrate"
                " WHERE source = %s", (self.source,)).fetchall()}

    def test_upsert_is_idempotent_and_a_later_fetch_overwrites_overlapping_hours(self):
        t1 = datetime(2026, 1, 1, 6, 17, tzinfo=timezone.utc)
        first = dict(hashrate=1e21, data=[pool(1, [1e15, 2e15, None, 3e15]), pool(2, [5e15, 6e15, 7e15, 8e15])])
        self.assertEqual(self.store.upsert_reported_hashrate(rh.rows(first, self.source, t1)), 7)
        once = self.table()
        self.assertEqual(len(once), 7)                        # pool 1's gap hour has no row
        self.store.upsert_reported_hashrate(rh.rows(first, self.source, t1))
        self.assertEqual(self.table(), once)
        # a day later the history starts an hour (and a few minutes) later, with new values for the hours it covers
        t2 = t1 + timedelta(days=1)
        later = dict(hashrate=1.1e21, data=[pool(1, [2.2e15, 2.5e15, None, 3.5e15], start=START + 3600 + 300)])
        self.store.upsert_reported_hashrate(rh.rows(later, self.source, t2))
        got = self.table()
        self.assertEqual(len(got), 7 + 2)                     # hours +2h and +4h are new; no near-duplicates
        self.assertEqual(got[("1", HOUR0 + 3600)], (2.2e15, 1.1e21, t2))       # in both: the later value wins
        self.assertEqual(got[("1", HOUR0 + 2 * 3600)], (2.5e15, 1.1e21, t2))   # was a gap, now a value
        self.assertEqual(got[("1", HOUR0 + 3 * 3600)], (3e15, 1e21, t1))       # a gap in the later fetch: kept
        self.assertEqual(got[("1", HOUR0 + 4 * 3600)], (3.5e15, 1.1e21, t2))
        self.assertEqual(got[("1", HOUR0)], (1e15, 1e21, t1))                  # before the later file: untouched
        self.assertEqual(got[("2", HOUR0 + 3 * 3600)], (8e15, 1e21, t1))


if __name__ == "__main__":
    unittest.main()
