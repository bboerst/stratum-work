import os
import threading
import time
import unittest
from datetime import datetime, timezone

try:
    from collector.pgsink import BTC, PostgresConfig, PostgresSink, route, to_row
except ImportError:  # pragma: no cover - when run from inside collector/
    from pgsink import BTC, PostgresConfig, PostgresSink, route, to_row  # type: ignore

NS = 1_794_437_000_123_456_789  # epoch ns


def doc(**over):
    d = {
        "timestamp": format(NS, "x"), "pool_name": "P", "height": 975_500, "job_id": "abc1",
        "prev_hash": "11" * 32, "coinbase1": "01000000" + "00" * 8, "coinbase2": "ffffffff",
        "merkle_branches": ["aa" * 32, "bb" * 32], "version": "20000000", "nbits": "1702e5b4", "ntime": "69d72a43",
        "clean_jobs": True, "extranonce1": "abcd", "extranonce2_length": 8, "lat_ms": 12.5, "lat_m": "tcp",
    }
    d.update(over)
    return d


class RouteTests(unittest.TestCase):
    def test_bitcoin_with_and_without_a_known_tip(self):
        self.assertIs(route(975_500, None, 975_499), BTC)       # tip + 1: the normal case
        self.assertIs(route(975_493, None, 975_499), BTC)       # tip - 6: still plausible
        self.assertIs(route(975_501, None, 975_499), BTC)       # tip + 2
        self.assertIs(route(975_500, None, None), BTC)          # no node: today's behavior

    def test_other_tables(self):
        self.assertEqual(route(0, None, 975_499).reason, "height_parse_failed")
        self.assertEqual(route(0, None, None).table, "templates_other")
        r = route(930_000, "bch", 975_499)
        self.assertEqual((r.table, r.chain, r.reason), ("templates_other", "bch", "bch"))
        self.assertEqual(route(975_500, "unknown", 975_499).reason, "unknown_chain")
        self.assertEqual(route(6_976_415, None, 975_499).reason, "height_implausible")
        self.assertEqual(route(975_492, None, 975_499).reason, "height_implausible")   # tip - 7
        self.assertEqual(route(975_502, None, 975_499).reason, "height_implausible")   # tip + 3


class ToRowTests(unittest.TestCase):
    def test_lossless_conversion(self):
        d = doc()
        row = to_row(d, source_id=7)
        self.assertEqual(row[0], datetime.fromtimestamp(NS // 1000 / 1e6, tz=timezone.utc))
        self.assertEqual(row[0].microsecond, 123_456)                          # µs kept, ns remainder dropped
        self.assertEqual(row[1], 7)
        self.assertEqual(row[4].hex(), d["prev_hash"])
        self.assertEqual(row[5].hex(), d["coinbase1"])
        self.assertEqual(row[6].hex(), d["coinbase2"])
        self.assertEqual(row[7].hex(), "".join(d["merkle_branches"]))
        self.assertEqual([format(v, "08x") for v in row[8:11]], [d["version"], d["nbits"], d["ntime"]])
        self.assertEqual(row[12].hex(), d["extranonce1"])
        self.assertEqual(row[14:], (12.5, "tcp"))

    def test_empty_branches_and_unknown_latency_method(self):
        row = to_row(doc(merkle_branches=[], lat_m="bogus", lat_ms=None), 1)
        self.assertEqual(row[7], b"")
        self.assertEqual(row[14:], (None, None))

    def test_malformed_input_raises(self):
        for bad in (doc(coinbase1="zz"), doc(prev_hash="abc"), doc(version="1ffffffff"), doc(timestamp="nothex")):
            with self.assertRaises(ValueError):
                to_row(bad, 1)


class FakeCursor:
    def __init__(self, conn): self.conn = conn
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def execute(self, sql, params=None): self.conn.executed.append((sql, params))
    def fetchone(self): return (42,)
    def executemany(self, sql, rows):
        if self.conn.fail_writes: raise RuntimeError("db down")
        table = "templates_other" if "templates_other" in sql else "templates"
        self.conn.rows.setdefault(table, []).extend(rows)


class FakeConn:
    def __init__(self, fail_writes=False):
        self.executed, self.rows, self.fail_writes, self.closed, self.commits = [], {}, fail_writes, False, 0
    def cursor(self): return FakeCursor(self)
    def commit(self): self.commits += 1
    def close(self): self.closed = True


def wait_for(cond, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond(): return True
        time.sleep(0.02)
    return False


CFG = PostgresConfig(host="h", port=5432, database="d", user="u", password="secret-pw", site="test", replica="b")


class SinkTests(unittest.TestCase):
    def test_writes_routed_rows_and_registers_source(self):
        conn = FakeConn()
        sink = PostgresSink(CFG, "P", stratum_url="stratum+tcp://x:3333", tip_provider=lambda: 975_499,
                            connect=lambda **kw: conn).start()
        sink.submit(doc())
        sink.submit(doc(height=6_976_415))
        sink.submit(doc(height=0))
        self.assertTrue(wait_for(lambda: sink.stats["written"] + sink.stats["written_other"] == 3))
        sink.close()
        self.assertEqual(len(conn.rows["templates"]), 1)
        self.assertEqual([r[-1] for r in conn.rows["templates_other"]], ["height_implausible", "height_parse_failed"])
        self.assertIn(("P", "test", "b", "stratum+tcp://x:3333"), [p for _, p in conn.executed])
        self.assertIn("ON CONFLICT (name, site, replica)", conn.executed[0][0])

    def test_database_down_never_blocks_or_raises_and_recovers(self):
        attempts = {"n": 0}
        def connect(**kw):
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise RuntimeError("connection refused")
            return FakeConn()
        sink = PostgresSink(CFG, "P", connect=connect).start()
        t0 = time.monotonic()
        for i in range(1000):
            sink.submit(doc(job_id=str(i)))
        self.assertLess(time.monotonic() - t0, 0.5)              # submit never waits on the database
        self.assertTrue(wait_for(lambda: sink.stats["written"] == 1000, timeout=10))
        self.assertGreaterEqual(sink.stats["db_errors"], 2)
        sink.close()

    def test_bounded_queue_drops_oldest_and_counts(self):
        gate = threading.Event()
        def connect(**kw):
            gate.wait(5)
            raise RuntimeError("down")
        sink = PostgresSink(CFG, "P", connect=connect, max_queue=10).start()
        for i in range(25):
            sink.submit(doc(job_id=str(i)))
        self.assertLessEqual(sink.queued(), 10)
        self.assertGreaterEqual(sink.stats["dropped_queue_full"], 15 - 1)
        gate.set()
        sink.close(timeout=1)

    def test_malformed_documents_are_dropped_not_fatal(self):
        conn = FakeConn()
        sink = PostgresSink(CFG, "P", connect=lambda **kw: conn).start()
        sink.submit(doc(coinbase1="not-hex"))
        sink.submit(doc())
        self.assertTrue(wait_for(lambda: sink.stats["written"] == 1))
        self.assertEqual(sink.stats["dropped_invalid"], 1)
        sink.close()

    def test_password_is_passed_as_a_keyword_not_a_url(self):
        kw = CFG.connect_kwargs()
        self.assertEqual(kw["password"], "secret-pw")
        self.assertFalse(any("secret-pw" in str(v) for k, v in kw.items() if k != "password"))


@unittest.skipUnless(os.getenv("PG_TEST_HOST"), "set PG_TEST_HOST etc. to run against a migrated Postgres")
class PostgresIntegrationTests(unittest.TestCase):
    """Against a real, migrated database, connected as a user in the stratum_collector role (least privilege)."""

    def test_end_to_end(self):
        import psycopg
        cfg = PostgresConfig(host=os.environ["PG_TEST_HOST"], port=int(os.getenv("PG_TEST_PORT", "5432")),
                             database=os.getenv("PG_TEST_DATABASE", "stratum"), user=os.environ["PG_TEST_USER"],
                             password=os.environ["PG_TEST_PASSWORD"], sslmode="disable", site="ci")
        name = f"itest-{int(time.time() * 1000)}"
        sink = PostgresSink(cfg, name, stratum_url="stratum+tcp://example:3333", tip_provider=lambda: 975_499).start()
        sink.submit(doc(pool_name=name))
        sink.submit(doc(pool_name=name, job_id="other", height=6_976_415))
        self.assertTrue(wait_for(lambda: sink.stats["written"] + sink.stats["written_other"] == 2, timeout=15), sink.stats)
        sink.close()
        admin = os.getenv("PG_TEST_ADMIN_DSN")
        if not admin:
            return  # the collector role can't SELECT templates; verification needs an admin connection
        with psycopg.connect(admin) as c:
            sid, replica = c.execute("SELECT id, replica FROM sources WHERE name = %s AND site = 'ci'", (name,)).fetchone()
            self.assertEqual(replica, "a")   # PostgresConfig default
            row = c.execute("""SELECT encode(prev_hash,'hex'), encode(coinbase1,'hex'), encode(merkle_branches,'hex'),
                                      lpad(to_hex(version),8,'0'), height FROM templates WHERE source_id = %s""", (sid,)).fetchone()
            d = doc()
            self.assertEqual(row, (d["prev_hash"], d["coinbase1"], "".join(d["merkle_branches"]), d["version"], 975_500))
            other = c.execute("SELECT height, chain::text, reason FROM templates_other WHERE source_id = %s", (sid,)).fetchone()
            self.assertEqual(other, (6_976_415, "unknown", "height_implausible"))


if __name__ == "__main__":
    unittest.main()
