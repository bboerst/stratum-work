"""Transaction-set facts (template_sets.py; template_set_heights / _feeds / _pairs): output addresses as Bitcoin Core
names them, the pool a template pays (the block rule), counting per height (nodes, connections counted once, pairs),
chunks and runs, the filler's schedule, the CLI, and against a real migrated database: what a fill writes (window,
parent and empty-template filters, two connections of a feed, a feed paying two pools, an unidentified payer),
idempotence, the backfill, and which heights are due. The web derives template providers from these rows
(web/lib/templateProviders.ts; its Postgres suite web/lib/__tests__/pgTemplateProviders.test.ts).
"""
import contextlib
import hashlib
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
import template_sets as ts  # noqa: E402

LOG = logging.getLogger("test.template_sets")
T0 = datetime(2025, 3, 1, 12, 0, tzinfo=timezone.utc)


def p2wpkh(k: int) -> bytes:
    return bytes.fromhex("0014") + bytes([k]) * 20


def coinbase(height: int, outputs, tag: bytes = b"", en1: str = "c0ffee01", en2len: int = 8):
    """A template's coinbase parts (cb1, en1, en2len, cb2) for a coinbase with these (value, script) outputs and a
    scriptSig of the BIP34 height push, `tag` and the extranonce."""
    hb = height.to_bytes(4, "little").rstrip(b"\0") or b"\0"
    pre = bytes([len(hb)]) + hb + tag
    script_len = len(pre) + len(bytes.fromhex(en1)) + en2len
    cb1 = (bytes.fromhex("01000000" "01" + "00" * 32 + "ffffffff") + bytes([script_len]) + pre).hex()
    outs = b"".join(v.to_bytes(8, "little") + bytes([len(s)]) + s for v, s in outputs)
    cb2 = (bytes.fromhex("ffffffff") + bytes([len(outputs)]) + outs + bytes(4)).hex()
    return cb1, en1, en2len, cb2


class AddressTests(unittest.TestCase):
    def test_standard_outputs_get_core_addresses(self):
        cases = {
            # BIP173 / BIP350 test vectors
            "0014751e76e8199196d454941c45d1b3a323f1433bd6": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262":
                "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
            "512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798":
                "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
            # the genesis coinbase's key as P2PKH; a P2SH
            "76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
            "a914e9c3dd0c07aac76179ebc76a6c78d4d67c6c160a87": "3P14159f73E4gFr7JterCCQh9QjiTjiZrG",
        }
        for script, address in cases.items():
            self.assertEqual(ts.script_address(bytes.fromhex(script)), address, script)

    def test_outputs_without_an_address(self):
        for script in ("6a24aa21a9ed" + "00" * 32,                       # OP_RETURN (witness commitment)
                       "41" + "04" + "11" * 64 + "ac",                   # bare pubkey
                       "0015" + "00" * 21,                               # v0 with a 21-byte program
                       ""):
            self.assertIsNone(ts.script_address(bytes.fromhex(script)), script)


POOLS = [{"id": 7, "name": "Pool A", "addresses": [ts.script_address(p2wpkh(1))], "tags": []},
         {"id": 8, "name": "Pool B", "addresses": [], "tags": ["/PoolB/"]}]


class PayerTests(unittest.TestCase):
    def test_the_highest_paid_known_address_then_a_tag(self):
        ident = ts.PoolIdentifier(POOLS)
        self.assertEqual(ident(*coinbase(900000, [(1000, p2wpkh(9)), (5000, p2wpkh(1))])), 7)
        self.assertEqual(ident(*coinbase(900000, [(1000, p2wpkh(9))], tag=b"/PoolB/")), 8)
        # the address wins over a tag, as for blocks
        self.assertEqual(ident(*coinbase(900000, [(1000, p2wpkh(1))], tag=b"/PoolB/")), 7)
        self.assertIsNone(ident(*coinbase(900000, [(1000, p2wpkh(9))])))

    def test_addresses_are_ordered_by_value_like_a_blocks(self):
        sig, addresses = ts.coinbase_payer(*coinbase(900000, [(10, p2wpkh(2)), (30, p2wpkh(3)), (25, p2wpkh(2))]))
        self.assertEqual(addresses, [ts.script_address(p2wpkh(2)), ts.script_address(p2wpkh(2)),
                                     ts.script_address(p2wpkh(3))])
        self.assertTrue(sig.startswith("03a0bb0d"))   # the height push

    def test_an_unparsed_coinbase_is_unidentified_and_a_wrong_extranonce2_length_is_repaired(self):
        ident = ts.PoolIdentifier(POOLS)
        cb1, en1, _, cb2 = coinbase(900000, [(1, p2wpkh(1))], en2len=4)
        self.assertEqual(ident(cb1, en1, 8, cb2), 7)            # only 4 reassembles: repaired
        self.assertIsNone(ident(cb1, en1, 4, cb2 + "00"))       # trailing byte: no length parses
        self.assertIsNone(ts.coinbase_payer("zz", "", 0, ""))


def row(h, feed, s, payer, at):
    return (h, feed, hashlib.sha256(s.encode()).digest(), payer, "", 0, "", at)


class CountTests(unittest.TestCase):
    """identify() here maps the coinbase1 field straight to a pool id ('' = unidentified)."""
    ident = staticmethod(lambda cb1, en1, n, cb2: int(cb1) if cb1 else None)

    def test_nodes_pairs_and_connections_counted_once(self):
        t = [T0 + timedelta(seconds=i) for i in range(10)]
        rows = [row(100, "F1", "x", "7", t[0]), row(100, "F1", "x", "7", t[1]),   # x on F1's two connections
                row(100, "F1", "y", "7", t[2]),
                row(100, "F2", "x", "7", t[3]), row(100, "F2", "y", "7", t[4]), row(100, "F2", "z", "7", t[5]),
                row(100, "F3", "x", "", t[6]),                                     # unidentified payer
                row(101, "F1", "w", "7", t[7]), row(101, "F1", "v", "8", t[8])]    # F1 pays two pools at 101
        templates, feeds, pairs = ts.count_heights(rows, self.ident)
        self.assertEqual(templates, {100: 7, 101: 2})
        self.assertEqual(feeds, [(100, "F1", 7, 2, 3, t[0], t[2]), (100, "F2", 7, 3, 3, t[3], t[5]),
                                 (100, "F3", None, 1, 1, t[6], t[6]),
                                 (101, "F1", 7, 1, 1, t[7], t[7]), (101, "F1", 8, 1, 1, t[8], t[8])])
        self.assertEqual(pairs, [(100, "F1", 7, "F2", 7, 2), (100, "F1", 7, "F3", None, 1),
                                 (100, "F2", 7, "F3", None, 1)])

    def test_a_set_at_another_height_is_another_unit(self):
        _, feeds, pairs = ts.count_heights([row(100, "F1", "x", "7", T0), row(101, "F1", "x", "7", T0),
                                            row(101, "F2", "x", "7", T0)], self.ident)
        self.assertEqual([f[:4] for f in feeds], [(100, "F1", 7, 1), (101, "F1", 7, 1), (101, "F2", 7, 1)])
        self.assertEqual(pairs, [(101, "F1", 7, "F2", 7, 1)])

    def test_unidentified_sorts_first_in_a_pair(self):
        _, _, pairs = ts.count_heights([row(5, "F", "x", "3", T0), row(5, "F", "x", "", T0)], self.ident)
        self.assertEqual(pairs, [(5, "F", None, "F", 3, 1)])


class ChunkTests(unittest.TestCase):
    def test_chunks_and_runs(self):
        self.assertEqual(ts.chunks(10, 20, 5), [(10, 14), (15, 19), (20, 20)])
        self.assertEqual(ts.chunks(10, 9, 5), [])
        with self.assertRaises(ValueError):
            ts.chunks(1, 2, 0)
        self.assertEqual(ts.runs([5, 3, 4, 9, 10, 11, 12], 3), [(3, 5), (9, 11), (12, 12)])
        self.assertEqual(ts.runs([]), [])


class FakeStore:
    """rows: the template rows template_set_rows() returns; replace_template_sets() keeps the latest per height."""

    def __init__(self, rows, due=(), bounds=(100, 102)):
        self.rows, self.due, self.bounds = rows, list(due), bounds
        self.heights, self.feeds, self.pairs, self.reads = {}, {}, {}, []

    def template_set_rows(self, a, b):
        self.reads.append((a, b))
        return [r for r in self.rows if a <= r[0] <= b]

    def replace_template_sets(self, a, b, heights, feeds, pairs):
        for h in range(a, b + 1):
            self.heights.pop(h, None), self.feeds.pop(h, None), self.pairs.pop(h, None)
        for h, n in heights:
            self.heights[h] = n
        for f in feeds:
            self.feeds.setdefault(f[0], []).append(f)
        for p in pairs:
            self.pairs.setdefault(p[0], []).append(p)
        self.due = [h for h in self.due if not a <= h <= b]

    def template_set_heights_due(self, lookback):
        return list(self.due)

    def template_set_height_bounds(self):
        return self.bounds

    def load_pools(self):
        return POOLS


def cbrow(h, feed, s, payer_k, at):
    return (h, feed, hashlib.sha256(s.encode()).digest(), *coinbase(h, [(1, p2wpkh(payer_k))]), at)


class FillTests(unittest.TestCase):
    ROWS = [cbrow(100, "F1", "x", 1, T0), cbrow(100, "F2", "x", 1, T0), cbrow(102, "F1", "y", 9, T0)]

    def test_fill_writes_every_height_of_the_range_and_is_idempotent(self):
        store = FakeStore(self.ROWS)
        s = ts.fill(store, 100, 102, ts.PoolIdentifier(POOLS))
        self.assertEqual((s["heights"], s["templates"], s["feeds"], s["pairs"]), (3, 3, 3, 1))
        snapshot = (dict(store.heights), dict(store.feeds), dict(store.pairs))
        ts.fill(store, 100, 102, ts.PoolIdentifier(POOLS))
        self.assertEqual((store.heights, store.feeds, store.pairs), snapshot)
        self.assertEqual(store.heights, {100: 2, 101: 0, 102: 1})
        self.assertEqual(store.pairs[100], [(100, "F1", 7, "F2", 7, 1)])
        self.assertEqual(store.feeds[102], [(102, "F1", None, 1, 1, T0, T0)])

    def test_backfill_walks_chunks_and_logs(self):
        store = FakeStore(self.ROWS)
        with self.assertLogs(LOG, "INFO") as logs:
            s = ts.backfill(store, 100, 102, ts.PoolIdentifier(POOLS), chunk=2, log=LOG)
        self.assertEqual(store.reads, [(100, 101), (102, 102)])
        self.assertEqual((s["chunks"], s["templates"], s["feed_rows"], s["pair_rows"]), (2, 3, 3, 1))
        self.assertEqual(len(logs.output), 3)

    def test_filler_fills_only_due_heights_in_runs(self):
        store = FakeStore(self.ROWS, due=[100, 102])
        f = ts.TemplateSetsFiller(store, chunk=144, log=LOG)
        self.assertEqual(f.run_once(), {"heights": 2, "templates": 3})
        self.assertEqual(store.reads, [(100, 100), (102, 102)])
        self.assertEqual(f.run_once(), {"heights": 0, "templates": 0})   # nothing due any more

    def test_cli(self):
        store = FakeStore(self.ROWS)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertLogs("backend.template_sets", "INFO"):
            self.assertEqual(ts.main(["--backfill", "--chunk", "2"], store=store), 0)
        self.assertEqual(json.loads(out.getvalue())["chunks"], 2)
        self.assertEqual(sorted(store.heights), [100, 101, 102])
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(ts.main(["--backfill", "--to-height", "103"], store=FakeStore(self.ROWS)), 2)
            self.assertEqual(ts.main([], store=FakeStore(self.ROWS)), 2)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(ts.main(["--backfill"], store=FakeStore([], bounds=(None, None))), 0)
        self.assertEqual(json.loads(out.getvalue())["chunks"], 0)


@unittest.skipUnless(os.getenv("PG_TEST_HOST"), "set PG_TEST_HOST etc. to run against a migrated Postgres")
class PostgresTests(unittest.TestCase):
    """Against a real, migrated database: seeded as the owner, filled as a user in the stratum_backend role."""

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
        cls.tag, cls.site = f"ts{run}", f"ts-site-{run}"
        cls.H = 9_500_000 + (run % 1000) * 10        # blocks at H - 1, H, H + 1 (above other suites: the tip)
        cls.T = datetime.now(timezone.utc) - timedelta(days=2)
        cls.POOL = 990_000 + run % 1000
        cls.blk = {h: bytes.fromhex(f"0000{run:06x}{h % 256:02x}" + "c3" * 26) for h in (cls.H - 1, cls.H, cls.H + 1)}

    def setUp(self):
        with self.psycopg.connect(self.admin) as c:
            self._cleanup(c)
            self.sid = {}
            for name, replica in (("F1", "a"), ("F1", "b"), ("F2", "a"), ("F3", "a")):
                self.sid[f"{name}/{replica}"] = c.execute(
                    "INSERT INTO sources (name, site, replica) VALUES (%s, %s, %s) RETURNING id",
                    (f"{self.tag}-{name}", self.site, replica)).fetchone()[0]
            for i, (h, b) in enumerate(sorted(self.blk.items())):
                at = self.T + timedelta(minutes=10 * i)
                c.execute("INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig) "
                          "VALUES (%s, %s, %s, %s, '\\x00')", (b, h, at, at))
            pool = {"id": self.POOL, "name": f"{self.tag} pool", "addresses": [ts.script_address(p2wpkh(1))],
                    "tags": []}
            c.execute("INSERT INTO pools (id, name, addresses, definition) VALUES (%s, %s, %s, %s)",
                      (self.POOL, pool["name"], pool["addresses"], json.dumps(pool)))
        self.addCleanup(self._cleanup_now)

    def insert(self, src, minutes, height, sets, payer_k=1, parent=None):
        cb1, en1, en2, cb2 = coinbase(height, [(1, p2wpkh(payer_k))])
        branches = b"".join(hashlib.sha256(s.encode()).digest() for s in sets)
        with self.psycopg.connect(self.admin) as c:
            c.execute("INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2,"
                      " merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)"
                      " VALUES (%s, %s, %s, 'j', stratum_prev_hash_to_block_hash(%s), decode(%s, 'hex'),"
                      " decode(%s, 'hex'), %s, 536870912, 1, 1, true, decode(%s, 'hex'), %s)",
                      (self.T + timedelta(minutes=minutes), self.sid[src], height,
                       parent or self.blk[height - 1], cb1, cb2, branches, en1, en2))

    def _cleanup(self, c):
        hs = list(range(self.H - 1, self.H + 2))
        for table in ("template_set_pairs", "template_set_feeds", "template_set_heights"):
            c.execute(f"DELETE FROM {table} WHERE height = ANY(%s)", (hs,))
        c.execute("DELETE FROM templates WHERE source_id IN (SELECT id FROM sources WHERE site = %s)", (self.site,))
        c.execute("DELETE FROM sources WHERE site = %s", (self.site,))
        c.execute("DELETE FROM blocks WHERE block_hash = ANY(%s)", (list(self.blk.values()),))
        c.execute("DELETE FROM pools WHERE id = %s", (self.POOL,))

    def _cleanup_now(self):
        with self.psycopg.connect(self.admin) as c:
            self._cleanup(c)

    def table(self, name, cols):
        with self.psycopg.connect(self.admin) as c:
            return c.execute(f"SELECT {cols} FROM {name} WHERE height BETWEEN %s AND %s ORDER BY 1, 2",
                             (self.H - 1, self.H + 1)).fetchall()

    def seed(self):
        f1, f2, f3 = (f"{self.tag}-{n}" for n in ("F1", "F2", "F3"))
        H = self.H
        # height H (between block H - 1 at T + 0 and block H at T + 10 min)
        self.insert("F1/a", 2, H, ["s1", "t1"])
        self.insert("F1/b", 2, H, ["s1", "t1"])          # the same set on F1's second connection: counts once
        self.insert("F1/a", 4, H, ["s2", "t2"])
        self.insert("F2/a", 3, H, ["s1", "t1"])
        self.insert("F2/a", 5, H, ["s2", "t2"])
        self.insert("F2/a", 6, H, ["s3"])
        self.insert("F3/a", 3, H, ["s1", "t1"], payer_k=9)   # pays no known pool
        self.insert("F3/a", 7, H, [])                        # empty: never counted
        self.insert("F2/a", 10 + 125, H, ["late"])           # after H's window closed (block H + 2 h): not counted
        self.insert("F2/a", 8, H, ["other"], parent=bytes.fromhex("00" * 31 + "01"))   # not on block H - 1
        # height H + 1: F1 pays the pool and an unknown address
        self.insert("F1/a", 12, H + 1, ["u1"])
        self.insert("F1/a", 13, H + 1, ["u2"], payer_k=9)
        return f1, f2, f3

    def test_fill_counts_and_is_idempotent(self):
        f1, f2, f3 = self.seed()
        H, P = self.H, self.POOL
        ident = ts.PoolIdentifier(self.store.load_pools())
        s = ts.fill(self.store, H, H + 1, ident)
        self.assertEqual((s["heights"], s["templates"]), (2, 9))
        expect_heights = [(H, 7), (H + 1, 2)]
        expect_feeds = [(H, f1, P, 2, 3), (H, f2, P, 3, 3), (H, f3, None, 1, 1),
                        (H + 1, f1, P, 1, 1), (H + 1, f1, None, 1, 1)]
        expect_pairs = [(H, f1, P, f2, P, 2), (H, f1, P, f3, None, 1), (H, f2, P, f3, None, 1)]
        key = lambda r: (r[0], r[1], -1 if r[2] is None else r[2])
        self.assertEqual(self.table("template_set_heights", "height, templates"), expect_heights)
        self.assertEqual(sorted(self.table("template_set_feeds", "height, feed, pool_id, sets, templates"), key=key),
                         sorted(expect_feeds, key=key))
        self.assertEqual(sorted(self.table("template_set_pairs", "height, feed_a, pool_a, feed_b, pool_b, shared"),
                                key=key), sorted(expect_pairs, key=key))
        first = self.table("template_set_feeds", "height, feed, first_received, last_received")
        self.assertIn((H, f1, self.T + timedelta(minutes=2), self.T + timedelta(minutes=4)), first)
        # again (and through the backfill, in chunks of one height): the same rows
        ts.backfill(self.store, H, H + 1, ident, chunk=1, log=LOG)
        self.assertEqual(self.table("template_set_heights", "height, templates"), expect_heights)
        self.assertEqual(sorted(self.table("template_set_pairs", "height, feed_a, pool_a, feed_b, pool_b, shared"),
                                key=key), sorted(expect_pairs, key=key))
        self.assertEqual(len(self.table("template_set_feeds", "height, feed, pool_id, sets")), 5)

    def test_heights_due_and_bounds(self):
        self.seed()
        H = self.H
        due = self.store.template_set_heights_due(5)
        # our blocks are the tip (H + 1) and two days old: every window up to the tip has closed (H - 1 too, when a
        # lower block is stored)
        self.assertEqual([h for h in due if h >= H], [H, H + 1])
        lo, hi = self.store.template_set_height_bounds()
        self.assertEqual(hi, H + 1)
        ts.fill(self.store, H, H, ts.PoolIdentifier(self.store.load_pools()))
        self.assertEqual([h for h in self.store.template_set_heights_due(5) if h >= H], [H + 1])


if __name__ == "__main__":
    unittest.main()
