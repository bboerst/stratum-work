"""The stale-parents summary (stale_parents.py, stale_parent_pools): which stale blocks a refresh recomputes (a window
overlapping the range, or no row yet, tried once per process), the height chunks of the backfill, the refresher's
schedule and label, the CLI, main.py's wiring, and, against a real migrated database, the rows
stale_parent_pools_refresh() writes (de-duplication across connections, only the block's height + 1 inside its window,
an open window passed as 'infinity', upsert, delete, idempotence). The web's Postgres suite
(web/lib/__tests__/pgForks.test.ts) checks the table against the web's live read of templates field for field.
"""
import contextlib
import io
import json
import logging
import os
import pathlib
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tests"))
import stale_parents as sp  # noqa: E402

T0 = datetime(2026, 1, 5, 12, 0, tzinfo=timezone.utc)
H = timedelta(hours=1)


class FakeStore:
    """blocks: {block_hash: (height + 1, w_from, w_to)} with windows as datetimes; templates: (block_hash, pool, height,
    received_at). The table: {(block, pool): n}, recomputed like stale_parent_pools_refresh()."""

    def __init__(self, blocks, templates):
        self.blocks, self.templates, self.table, self.calls = dict(blocks), list(templates), {}, []

    def _row(self, b, a=None, z=None):
        h, f, t = self.blocks[b]
        return {"block_hash": b, "height": h, "w_from": f.isoformat(), "w_to": t.isoformat(),
                "has_rows": any(k[0] == b for k in self.table),
                "overlaps": a is not None and f <= z and t >= a}

    def stale_parents_to_refresh(self, a, z):
        rows = [self._row(b, a, z) for b in sorted(self.blocks, key=lambda b: (self.blocks[b][0], b))]
        return [r for r in rows if r["overlaps"] or not r["has_rows"]]

    def stale_parents_between_heights(self, lo, hi):
        return [self._row(b) for b in sorted(self.blocks, key=lambda b: (self.blocks[b][0], b))
                if lo <= self.blocks[b][0] - 1 <= hi]

    def stale_block_heights(self):
        hs = [h - 1 for h, _, _ in self.blocks.values()]
        return (min(hs), max(hs)) if hs else None

    def refresh_stale_parent(self, b, height, w_from, w_to):
        self.calls.append(b)
        a, z = datetime.fromisoformat(w_from), datetime.fromisoformat(w_to)
        rows = {}
        for tb, pool, h, t in self.templates:
            if tb == b and h == height and a <= t <= z:
                rows[pool] = rows.get(pool, 0) + 1
        for key in [k for k in self.table if k[0] == b and k[1] not in rows]:
            del self.table[key]
        for pool, n in rows.items():
            self.table[(b, pool)] = n
        return len(rows)


def two_blocks():
    """S (recent window, templates) and Q (an old window, templates), E (no templates at all)."""
    blocks = {b"S": (101, T0 - 2 * H, T0 + 2 * H), b"Q": (51, T0 - 30 * 24 * H, T0 - 29 * 24 * H),
              b"E": (71, T0 - 10 * 24 * H, T0 - 9 * 24 * H)}
    templates = [(b"S", "x", 101, T0), (b"S", "y", 101, T0 + H), (b"S", "x", 102, T0),      # 102: not its height
                 (b"S", "x", 101, T0 + 3 * H),                                              # after its window
                 (b"Q", "x", 51, T0 - 29 * 24 * H - H)]
    return FakeStore(blocks, templates)


class RefreshTests(unittest.TestCase):
    def test_overlapping_windows_and_blocks_without_rows(self):
        s = two_blocks()
        out = sp.refresh(s, T0 - H, T0)
        # every block has no row yet: all three; S counted inside its window at its height + 1 only
        self.assertEqual(out["parents"], [b"Q", b"E", b"S"])
        self.assertEqual(s.table, {(b"S", "x"): 1, (b"S", "y"): 1, (b"Q", "x"): 1})
        s.calls.clear()
        sp.refresh(s, T0 - H, T0)
        self.assertEqual(s.calls, [b"E", b"S"])         # Q has rows and an old window; E still has none
        before = dict(s.table)
        sp.refresh(s, T0 - H, T0)
        self.assertEqual(s.table, before)                # idempotent

    def test_a_block_without_templates_is_tried_once_per_process(self):
        s, attempted = two_blocks(), set()
        sp.refresh(s, T0 - H, T0, attempted)
        s.calls.clear()
        sp.refresh(s, T0 - H, T0, attempted)
        self.assertEqual(s.calls, [b"S"])                # only the overlapping one; E was tried
        s.blocks[b"N"] = (121, T0 - 50 * H, T0 - 40 * H)  # recorded since (e.g. imported): no row, not tried yet
        s.calls.clear()
        sp.refresh(s, T0 + 10 * H, T0 + 11 * H, attempted)
        self.assertEqual(s.calls, [b"N"])

    def test_a_pool_with_no_template_left_loses_its_row(self):
        s = two_blocks()
        sp.refresh(s, T0 - H, T0)
        s.templates = [t for t in s.templates if t[1] != "y"]
        sp.refresh(s, T0 - H, T0)
        self.assertNotIn((b"S", "y"), s.table)

    def test_height_chunks(self):
        self.assertEqual(sp.height_chunks(100, 104, 2), [(100, 101), (102, 103), (104, 104)])
        self.assertEqual(sp.height_chunks(100, 99, 2), [])
        with self.assertRaises(ValueError):
            sp.height_chunks(1, 2, 0)

    def test_backfill_recomputes_each_block_once_and_logs_each_chunk(self):
        s = two_blocks()
        log = io.StringIO()
        lg = logging.getLogger("test.stale_parents.backfill")
        lg.addHandler(logging.StreamHandler(log))
        lg.setLevel(logging.INFO)
        summary = sp.backfill(s, 50, 100, 25, log=lg)
        self.assertEqual(sorted(s.calls), [b"E", b"Q", b"S"])
        self.assertEqual((summary["chunks"], summary["parents"], summary["rows_written"]), (3, 3, 3))
        self.assertIn("backfill 3/3 [heights 100, 100]", log.getvalue())
        self.assertIn("backfill done", log.getvalue())


class RefresherTests(unittest.TestCase):
    def test_schedule_label_and_attempted(self):
        clock = [T0]
        s = two_blocks()
        log = io.StringIO()
        lg = logging.getLogger("test.stale_parents.refresher")
        lg.addHandler(logging.StreamHandler(log))
        lg.setLevel(logging.INFO)
        r = sp.StaleParentsRefresher(s, now=lambda: clock[0], log=lg)
        self.assertEqual(r.range(), (T0 - sp.STARTUP_WINDOW, T0))
        r.run_once()
        self.assertEqual(r.attempted, {b"S", b"Q", b"E"})
        clock[0] = T0 + timedelta(minutes=10)
        self.assertEqual(r.range(), (clock[0] - sp.WINDOW, clock[0]))
        s.calls.clear()
        r.run_once()
        self.assertEqual(s.calls, [b"S"])
        self.assertIn("Stale parents refreshed", log.getvalue())


class CliTests(unittest.TestCase):
    def test_backfill_prints_a_summary_without_pool_names(self):
        s = two_blocks()
        s.templates = [(b, "secret-pool", h, t) for b, _, h, t in s.templates]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(sp.main(["--backfill", "--chunk", "20"], store=s), 0)
        summary = json.loads(out.getvalue())
        self.assertEqual((summary["from_height"], summary["to_height"], summary["chunks"], summary["parents"]),
                         (50, 100, 3, 3))
        self.assertNotIn("secret-pool", out.getvalue() + err.getvalue())

    def test_no_stale_blocks_and_no_backfill(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(sp.main(["--backfill"], store=FakeStore({}, [])), 0)
        self.assertEqual(json.loads(out.getvalue())["chunks"], 0)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(sp.main([], store=FakeStore({}, [])), 2)


class MainWiringTests(unittest.TestCase):
    """main.py: the refresher starts after the startup sync with its own store and thread, can be turned off, and is
    asked to run when the stale-block tracker records a block."""

    def setUp(self):
        from unittest import mock
        from main_harness import import_main_module
        self.mock = mock
        self.main, _ = import_main_module()
        self.addCleanup(setattr, self.main, "stale_parents_refresher", None)

    def test_own_store_and_thread(self):
        mock = self.mock
        own = object()
        store = mock.Mock(enabled=True)
        threads = []
        with mock.patch.object(self.main, "store", store), mock.patch.object(type(store), "from_env", create=True,
                                                                               new=staticmethod(lambda: own)), \
                mock.patch.object(self.main.threading, "Thread", lambda **kw: threads.append(kw) or mock.Mock()):
            self.main.start_stale_parents_refresher()
        r = self.main.stale_parents_refresher
        self.assertIs(r.store, own)
        self.assertEqual([t["name"] for t in threads], ["stale_parents"])
        self.assertEqual(threads[0]["target"], r.run_forever)

    def test_off(self):
        mock = self.mock
        for enabled, storage in ((False, True), (True, False)):
            with mock.patch.multiple(self.main, STALE_PARENTS_ENABLED=enabled, store=mock.Mock(enabled=storage)):
                self.main.start_stale_parents_refresher()
            self.assertIsNone(self.main.stale_parents_refresher)

    def test_a_recorded_stale_block_requests_a_refresh(self):
        r = self.mock.Mock()
        with self.mock.patch.object(self.main, "stale_parents_refresher", r), \
                self.mock.patch.object(self.main, "block_processor", self.mock.Mock()):
            self.main._after_stale_poll({"blocks_recorded": 0})
            r.request.assert_not_called()
            self.main._after_stale_poll({"blocks_recorded": 1})
            r.request.assert_called_once_with()


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
        cls.tag, cls.site = f"sp{run}", f"sp-site-{run}"
        cls.T = datetime(2025, 3, 3, 12, 0, tzinfo=timezone.utc) + timedelta(minutes=run % 1000)
        cls.HB = 6_500_000 + (run % 1000) * 10                     # our best block's height (far from other suites)
        cls.B0 = bytes.fromhex(f"0000{run:06x}" + "c0" * 27)   # best at HB, arrives at T
        cls.B1 = bytes.fromhex(f"0000{run:06x}" + "c1" * 27)   # best at HB + 1, arrives at T + 10 min
        cls.S = bytes.fromhex(f"0000{run:06x}" + "5e" * 27)    # stale at HB: templates at HB + 1
        cls.E = bytes.fromhex(f"0000{run:06x}" + "5f" * 27)    # stale at HB, no templates

    def setUp(self):
        with self.psycopg.connect(self.admin) as c:
            self._cleanup(c)
            self.sid = {}
            for name, replica in ((f"{self.tag}-m", "b"), (f"{self.tag}-m", "a"), (f"{self.tag}-s", "a")):
                self.sid[f"{name}/{replica}"] = c.execute(
                    "INSERT INTO sources (name, site, replica) VALUES (%s, %s, %s) RETURNING id",
                    (name, self.site, replica)).fetchone()[0]
            for b, h, at in ((self.B0, self.HB, self.T), (self.B1, self.HB + 1, self.T + timedelta(minutes=10))):
                c.execute("INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig) "
                          "VALUES (%s, %s, %s, %s, '\\x00')", (b, h, at, at))
            for b in (self.S, self.E):
                c.execute("INSERT INTO stale_blocks (block_hash, height, prev_hash, version, block_time, bits, nonce,"
                          " merkle_root, chaintip_status, last_status, tip_hash, fork_height, first_seen)"
                          " VALUES (%s, %s, '\\x00', 1, %s, 1, 1, '\\x00', 'valid-fork', 'valid-fork', %s, %s, %s)",
                          (b, self.HB, self.T, b, self.HB - 1, self.T))
        self.addCleanup(self._cleanup_now)

    def insert(self, src, at, height, job, parent, ntime=1):
        with self.psycopg.connect(self.admin) as c:
            c.execute("INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2,"
                      " merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)"
                      " VALUES (%s, %s, %s, %s, stratum_prev_hash_to_block_hash(%s), '\\x01', '\\x02', '',"
                      " 536870912, 386089497, %s, true, '\\x03', 8)",
                      (at, self.sid[src], height, job, parent, ntime))

    def rows(self):
        with self.psycopg.connect(self.admin) as c:
            return {(bytes(r[0]), r[1]): r[2:] for r in c.execute(
                "SELECT stratum_prev_hash_to_block_hash(prev_hash), pool, n, first_received, last_received, conns,"
                "       heights, nbits FROM stale_parent_pools"
                " WHERE stratum_prev_hash_to_block_hash(prev_hash) = ANY(%s)", ([self.S, self.E],)).fetchall()}

    def _cleanup(self, c):
        c.execute("DELETE FROM stale_parent_pools WHERE stratum_prev_hash_to_block_hash(prev_hash) = ANY(%s)",
                  ([self.S, self.E],))
        c.execute("DELETE FROM templates WHERE source_id IN (SELECT id FROM sources WHERE site = %s)", (self.site,))
        c.execute("DELETE FROM sources WHERE site = %s", (self.site,))
        c.execute("DELETE FROM stale_blocks WHERE block_hash = ANY(%s)", ([self.S, self.E],))
        c.execute("DELETE FROM blocks WHERE block_hash = ANY(%s)", ([self.B0, self.B1],))

    def _cleanup_now(self):
        with self.psycopg.connect(self.admin) as c:
            self._cleanup(c)

    def mine(self, blocks):
        return [b for b in blocks if b["block_hash"] in (self.S, self.E)]

    def test_rows_inside_the_window_deduplicated_upserted_and_deleted(self):
        m_a, m_b, s = f"{self.tag}-m/a", f"{self.tag}-m/b", f"{self.tag}-s/a"
        T, h = self.T, self.HB + 1
        self.insert(m_a, T + timedelta(seconds=10), h, "m1", self.S, ntime=5)
        self.insert(m_b, T + timedelta(seconds=10.5), h, "n1", self.S, ntime=5)     # exact copy of m1: once
        self.insert(m_b, T + timedelta(seconds=40), h, "n2", self.S)                # only on b
        self.insert(s, T + timedelta(seconds=5), h, "s1", self.S)
        self.insert(s, T + timedelta(seconds=7), h + 1, "s2", self.S)               # not the block's height + 1
        self.insert(s, T + timedelta(hours=3), h, "s3", self.S)                     # after HB + 1's window (T + 2h10m)
        # the candidates: both blocks (no rows yet); S's window overlaps, as text values
        got = {b["block_hash"]: b for b in self.mine(self.store.stale_parents_to_refresh(T, T + timedelta(minutes=5)))}
        self.assertEqual(set(got), {self.S, self.E})
        self.assertEqual((got[self.S]["height"], got[self.S]["overlaps"], got[self.S]["has_rows"]), (h, True, False))
        self.assertIsInstance(got[self.S]["w_to"], str)
        attempted = set()
        sp.refresh(self.store, T, T + timedelta(minutes=5), attempted)
        self.assertTrue({self.S, self.E} <= attempted)
        want = {
            (self.S, f"{self.tag}-m"): (2, T + timedelta(seconds=10), T + timedelta(seconds=40), [1, 2], {str(h): 2},
                                        {"386089497": 2}),
            (self.S, f"{self.tag}-s"): (1, T + timedelta(seconds=5), T + timedelta(seconds=5), [1], {str(h): 1},
                                        {"386089497": 1}),
        }
        self.assertEqual(self.rows(), want)
        # S has rows now: a range far from its window leaves it out; E (none) stays a candidate until tried
        later = self.mine(self.store.stale_parents_to_refresh(T + timedelta(days=30), T + timedelta(days=31)))
        self.assertEqual([b["block_hash"] for b in later], [self.E])
        # idempotent
        sp.refresh(self.store, T, T + timedelta(minutes=5))
        self.assertEqual(self.rows(), want)
        # an open window ('infinity', as while no block at HB + 1 is stored) takes the late template too
        w_from = got[self.S]["w_from"]
        self.store.refresh_stale_parent(self.S, h, w_from, "infinity")
        self.assertEqual(self.rows()[(self.S, f"{self.tag}-s")][:3], (2, T + timedelta(seconds=5), T + timedelta(hours=3)))
        # the backfill (each block once) restores the window's rows; then a pool with no template left loses its row
        summary = sp.backfill(self.store, self.HB, self.HB, 1)
        self.assertGreaterEqual(summary["parents"], 2)
        self.assertEqual(self.rows(), want)
        with self.psycopg.connect(self.admin) as c:
            c.execute("DELETE FROM templates WHERE source_id = %s", (self.sid[s],))
        sp.refresh(self.store, T, T + timedelta(minutes=5))
        self.assertEqual(set(self.rows()), {(self.S, f"{self.tag}-m")})

    def test_a_block_without_templates_writes_no_rows(self):
        self.assertEqual(self.store.refresh_stale_parent(self.E, self.HB + 1, "-infinity", "infinity"), 0)
        self.assertEqual(self.rows(), {})


if __name__ == "__main__":
    unittest.main()
