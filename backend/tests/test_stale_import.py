"""#243: stale blocks from the public stale-blocks dataset, validated before they're stored.

Fixtures (tests/fixtures/stale-blocks/) are real rows of github.com/bitcoin-data/stale-blocks (CC0 1.0,
doi:10.5281/zenodo.22667157): four rows of stale-blocks.csv (three with headers, one without) and two blocks/ files
(813210: one coinbase paying P2PKH outputs; 188175: nine transactions, for the merkle check).
"""
import os
import pathlib
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tests"))
import stale_import as si  # noqa: E402

FIX = pathlib.Path(__file__).resolve().parent / "fixtures" / "stale-blocks"
DATASET = si.read_dataset(str(FIX / "stale-blocks.csv"))
H813 = "000000000000000000021c9f203786c0adcd7ae9a68a25d5e430d2a3dba613d5"
PREV813 = "0000000000000000000387aabb95cecfc38d2a61b4e2590ae4cc77d267b70a05"   # its header's prev block
H188 = "000000000000025a11322ba47946066544f25573085c55b8244f3454db8abc27"
H974 = "000000000000000000005c1f917e558adf7d182c64a5f397241bbae68829be6c"
NOHEADER = "0000000000000000001bc87b3d85516a0b00bf873a43dbef986125c269c210d8"
T0 = datetime(2023, 10, 21, 12, 0, tzinfo=timezone.utc)
OTHER = "00" * 4 + "11" * 28      # our best block at the stale block's height (a competitor)


def bin_path(h, bh):
    return FIX / "blocks" / f"{h}-{bh}.bin"


def candidate(bh, height, pools=2):
    return {"height": height, "block_hash": bh, "pools": pools, "first_seen": T0}


def best_for(bh):
    """blocks_best around a dataset block: its parent at h - 1 and another block (same bits) at h."""
    e = DATASET[bh]
    hd = si.parse_header(e["header"])
    return {e["height"] - 1: [{"block_hash": hd["prev_hash"], "bits": None}],
            e["height"]: [{"block_hash": OTHER, "bits": hd["bits"]}]}


def tampered(header: bytes, offset: int, value: bytes) -> bytes:
    return header[:offset] + value + header[offset + len(value):]


class HeaderTests(unittest.TestCase):
    def test_dataset_rows(self):
        self.assertEqual(len(DATASET), 4)
        self.assertIsNone(DATASET[NOHEADER]["header"])
        self.assertEqual(DATASET[H813]["height"], 813210)

    def test_header_fields_in_display_order(self):
        hd = si.parse_header(DATASET[H813]["header"])
        self.assertEqual(hd["block_hash"], H813)
        self.assertEqual(hd["prev_hash"], PREV813)
        self.assertEqual((hd["bits"], hd["version"]), (0x17049CA9, 0x3FFFE000))

    def test_bits_target(self):
        self.assertEqual(si.bits_target(0x1D00FFFF), si.POW_LIMIT)
        self.assertEqual(si.bits_target(0x01003456), 0)
        self.assertEqual(si.bits_target(0x03123456), 0x123456)
        self.assertIsNone(si.bits_target(0x04923456))   # sign bit: negative
        self.assertIsNone(si.bits_target(0x1D000000))

    def test_real_headers_validate(self):
        for bh in (H813, H188, H974):
            e = DATASET[bh]
            hd, reason = si.validate(candidate(bh, e["height"] + 1), e, best_for(bh))
            self.assertIsNone(reason, bh)
            self.assertEqual(hd["block_hash"], bh)
            self.assertTrue(hd["difficulty_checked"])

    def test_difficulty_unchecked_when_our_block_has_no_bits(self):
        best = best_for(H813)
        best[813210][0]["bits"] = None
        hd, reason = si.validate(candidate(H813, 813211), DATASET[H813], best)
        self.assertIsNone(reason)
        self.assertFalse(hd["difficulty_checked"])

    def test_no_header(self):
        self.assertEqual(si.validate(candidate(NOHEADER, 527472), DATASET[NOHEADER], {})[1], "no_header")

    def test_hash_mismatch(self):
        e = DATASET[H813]
        # a header changed after the fact no longer hashes to the dataset's (and the templates') hash
        bad = dict(e, header=tampered(e["header"], 76, b"\x00\x00\x00\x00"))
        self.assertEqual(si.validate(candidate(H813, 813211), bad, best_for(H813))[1], "hash_mismatch")
        # the dataset's hash isn't the templates' prev_hash
        self.assertEqual(si.validate(candidate(H188, 813211), e, best_for(H813))[1], "hash_mismatch")
        self.assertEqual(si.validate(candidate(H813, 813211), dict(e, header=e["header"][:79]), {})[1], "bad_header")

    def test_pow(self):
        # bits made easier: hash, dataset hash and templates all agree, but the hash doesn't meet the target
        e = DATASET[H813]
        for bits in (0x17009CA9, 0x1D00FFFF, 0x207FFFFF):   # harder; difficulty 1; regtest (beyond the PoW limit)
            header = tampered(e["header"], 72, bits.to_bytes(4, "little"))
            bh = si.parse_header(header)["block_hash"]
            hd, reason = si.validate(candidate(bh, 813211), dict(e, hash=bh, header=header), best_for(H813))
            self.assertEqual(reason, "pow", hex(bits))

    def test_wrong_prev(self):
        best = best_for(H813)
        best[813209] = [{"block_hash": "00" * 32, "bits": None}]
        self.assertEqual(si.validate(candidate(H813, 813211), DATASET[H813], best)[1], "prev_mismatch")
        del best[813209]
        self.assertEqual(si.validate(candidate(H813, 813211), DATASET[H813], best)[1], "prev_mismatch")

    def test_wrong_height(self):
        e = DATASET[H813]
        self.assertEqual(si.validate(candidate(H813, 813212), e, best_for(H813))[1], "height_mismatch")
        self.assertEqual(si.validate(candidate(H813, 813211), dict(e, height=813211), best_for(H813))[1],
                         "height_mismatch")

    def test_bits_differ_from_our_block_at_that_height(self):
        best = best_for(H813)
        best[813210][0]["bits"] = 0x17049CAA
        self.assertEqual(si.validate(candidate(H813, 813211), DATASET[H813], best)[1], "bits_mismatch")

    def test_our_best_block_is_not_stale(self):
        best = best_for(H813)
        best[813210].append({"block_hash": H813, "bits": None})
        self.assertEqual(si.validate(candidate(H813, 813211), DATASET[H813], best)[1], "on_best_chain")


class FullBlockTests(unittest.TestCase):
    def fields(self, bh, raw=None, identify=None):
        e = DATASET[bh]
        hd = si.parse_header(e["header"])
        raw = raw if raw is not None else bin_path(e["height"], bh).read_bytes()
        return si.full_block_fields(raw, e["header"], hd["merkle_root"], identify)

    def test_one_coinbase_block(self):
        seen = []
        f = self.fields(H813, identify=lambda script, addrs: seen.append((script, addrs)) or {"id": 7, "name": "P"})
        self.assertEqual((f["tx_count"], f["size"], f["weight"]), (1, 456, 1824))
        self.assertTrue(f["coinbase_script_sig"].startswith("039a680c"))   # BIP34 height 813210
        self.assertEqual(len(f["coinbase_outputs"]), 5)
        # highest paid first, OP_RETURN outputs have no address
        self.assertEqual(seen[0][1], ["1KFHE7w8BhaENAswwryaoccDb6qcT6DbYY", "1K6KoYC69NnafWJ7YgtrpwJxBLiijWqwa6"])
        self.assertEqual(f["coinbase_outputs"][1], {"value_sat": 624999454, "address": "1KFHE7w8BhaENAswwryaoccDb6qcT6DbYY",
                                                    "script_pubkey": "76a914c825a1ecf2a6830c4401620c3a16f1995057c2ab88ac"})
        self.assertEqual(f["mining_pool"], {"id": 7, "name": "P"})

    def test_merkle_over_nine_transactions(self):
        f = self.fields(H188)
        self.assertEqual((f["tx_count"], f["size"], f["weight"]), (9, 2237, 8948))
        self.assertEqual(f["coinbase_outputs"][0]["address"], None)   # P2PK: no address
        self.assertEqual(f["mining_pool"], {"name": "Unknown", "id": "unknown"})

    def test_tampered_blocks_are_rejected(self):
        raw = bin_path(188175, H188).read_bytes()
        cases = {
            "merkle": raw[:-5] + bytes([raw[-5] ^ 1]) + raw[-4:],   # a byte of the last transaction
            "header": self.fields_raw_header(raw),
            "leftover": raw + b"\x00",
            "truncated": raw[:-1],
        }
        for name, bad in cases.items():
            with self.assertRaises(ValueError, msg=name):
                self.fields(H188, raw=bad)

    @staticmethod
    def fields_raw_header(raw):
        return raw[:76] + b"\x00\x00\x00\x00" + raw[80:]

    def test_segwit_transactions_are_split_and_weighed(self):
        # the 813210 coinbase plus a legacy transaction of block 188175 re-serialized with the segwit marker and a
        # witness per input: same txid, witness bytes count once in the weight
        blk188 = si.parse_block(bin_path(188175, H188).read_bytes())
        legacy = blk188["txs"][1]
        n_in = legacy[4]
        self.assertLess(n_in, 0xFD)
        witness = b"".join(b"\x02\x03abc\x01z" for _ in range(n_in))
        segwit = legacy[:4] + b"\x00\x01" + legacy[4:-4] + witness + legacy[-4:]
        coinbase = bin_path(813210, H813).read_bytes()[81:]
        blk = si.parse_block(b"\x00" * 80 + b"\x02" + coinbase + segwit)
        self.assertEqual(blk["txs"], [coinbase, segwit])
        self.assertEqual(blk["txids"][1], blk188["txids"][1])
        self.assertEqual(blk["weight"], 3 * (81 + len(coinbase) + len(legacy)) + blk["size"])


class AddressTests(unittest.TestCase):
    def test_bip_vectors(self):
        cases = {
            "76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
            "a914b472a266d0bd89c13706a4132ccfb16f7c3b9fcb87": "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
            "0014751e76e8199196d454941c45d1b3a323f1433bd6": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
            "00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262":
                "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
            "5120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c":
                "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
        }
        for spk, addr in cases.items():
            self.assertEqual(si.script_address(bytes.fromhex(spk)), addr)

    def test_non_standard_scripts_have_none(self):
        for spk in ("6a0401020304", "21" + "02" * 33 + "ac", "0015" + "00" * 21, ""):
            self.assertIsNone(si.script_address(bytes.fromhex(spk)))


class FakeStore:
    """The importer's store calls, in memory."""

    def __init__(self, candidates, best, lo=100_000, hi=980_000):
        self.candidates, self.best, self.range = candidates, best, (lo, hi)
        self.rows, self.queries = {}, []

    def block_height_range(self):
        return self.range

    def unknown_parent_candidates(self, a, b):
        self.queries.append((a, b))
        return [c for c in self.candidates if a <= c["height"] <= b and c["block_hash"] not in self.rows]

    def best_blocks_at(self, heights):
        return {h: self.best[h] for h in heights if h in self.best}

    def insert_imported_stale_block(self, row):
        if row["block_hash"] in self.rows:
            return False
        self.rows[row["block_hash"]] = row
        return True


class RunTests(unittest.TestCase):
    def setUp(self):
        best = {}
        for bh in (H813, H188, H974):
            best.update(best_for(bh))
        self.candidates = [
            candidate(H813, 813211, pools=3),
            candidate(H188, 188176, pools=1),                    # single pool, in the dataset: accepted
            candidate(H974, 974402, pools=2),                    # one height off: rejected
            candidate(NOHEADER, 527472, pools=2),                # in the dataset without a header: rejected
            candidate("ab" * 32, 900_001, pools=2),              # not in the dataset: reported
            candidate("cd" * 32, 900_002, pools=1),              # single pool, not in the dataset: counted only
        ]
        self.store = FakeStore(self.candidates, best)

    def run_import(self, **kw):
        return si.run(self.store, DATASET, str(FIX / "blocks"), chunk=50_000, **kw)

    def test_summary_and_rows(self):
        s = self.run_import()
        self.assertEqual((s["candidates_multi_pool"], s["candidates_single_pool"]), (4, 2))
        self.assertEqual((s["in_dataset_multi_pool"], s["in_dataset_single_pool"]), (3, 1))
        self.assertEqual((s["validated"], s["stored"], s["full_blocks"], s["difficulty_unchecked"]), (2, 2, 2, 0))
        self.assertEqual(sorted((r["block_hash"], r["reason"]) for r in s["rejected"]),
                         sorted([(H974, "height_mismatch"), (NOHEADER, "no_header")]))
        self.assertEqual(s["multi_pool_not_in_dataset"], [{"height": 900_000, "block_hash": "ab" * 32, "pools": 2}])
        row = self.store.rows[H813]
        self.assertEqual((row["height"], row["fork_height"], row["tip_hash"], row["prev_hash"]),
                         (813210, 813209, H813, PREV813))
        self.assertEqual(row["first_seen"], T0)
        self.assertEqual(row["bits"], 0x17049CA9)
        self.assertTrue(row["full_block"])
        self.assertEqual(row["tx_count"], 1)
        self.assertEqual(s["heights"], [100_001, 980_001])
        self.assertEqual(self.store.queries[0], (100_001, 150_000))   # chunked by height

    def test_dry_run_stores_nothing(self):
        s = self.run_import(dry_run=True)
        self.assertEqual((s["validated"], s["stored"], len(self.store.rows)), (2, 0, 0))

    def test_idempotent(self):
        self.run_import()
        s = self.run_import()
        self.assertEqual((s["validated"], s["stored"], s["already_stored"]), (0, 0, 0))
        # a row that appears between the candidate read and the insert is left alone
        self.store.unknown_parent_candidates = lambda a, b: [c for c in self.candidates
                                                         if c["block_hash"] == H813 and a <= c["height"] <= b]
        s = self.run_import()
        self.assertEqual((s["stored"], s["already_stored"]), (0, 1))

    def test_a_bad_block_file_keeps_the_header(self):
        d = pathlib.Path(self._tmp())
        good = bin_path(813210, H813).read_bytes()
        (d / f"813210-{H813}.bin").write_bytes(good + b"\x00")
        s = si.run(self.store, DATASET, str(d), chunk=50_000)
        self.assertEqual((s["stored"], s["full_blocks"], len(s["full_block_rejected"])), (2, 0, 1))
        self.assertFalse(self.store.rows[H813]["full_block"])

    def test_height_bounds(self):
        s = self.run_import(from_height=813_000, to_height=813_500)
        self.assertEqual((s["heights"], s["stored"]), ([813_000, 813_500], 1))

    def _tmp(self):
        import tempfile
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(d, ignore_errors=True))
        return d


@unittest.skipUnless(os.getenv("PG_TEST_HOST"), "set PG_TEST_HOST etc. to run against a migrated Postgres")
class PostgresImportTests(unittest.TestCase):
    """Against a real, migrated database: seeded as the owner, imported as a user in the stratum_backend role."""

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
        cls.tag = f"si{int(time.time()) % 100000}"

    def setUp(self):
        hd = si.parse_header(DATASET[H813]["header"])
        self.block_time = datetime.fromtimestamp(hd["time"], timezone.utc)
        with self.psycopg.connect(self.admin) as c:
            self._cleanup(c)
            # our best chain: the stale block's parent at 813209 and its competitor at 813210 (same bits)
            c.execute("INSERT INTO blocks (block_hash, height, block_time, seen_at, coinbase_script_sig, bits) VALUES "
                      "(%s, 813209, %s, %s, '\\x00', %s), (%s, 813210, %s, %s, '\\x00', %s)",
                      (bytes.fromhex(PREV813), self.block_time - timedelta(minutes=10),
                       self.block_time - timedelta(minutes=10), hd["bits"], bytes.fromhex(OTHER), self.block_time,
                       self.block_time + timedelta(seconds=20), hd["bits"]))
            ids = [c.execute("INSERT INTO sources (name, site) VALUES (%s, 'si') RETURNING id", (f"{self.tag}-{p}",))
                   .fetchone()[0] for p in ("p1", "p2")]
            stratum_prev = c.execute("SELECT stratum_prev_hash_to_block_hash(%s)", (bytes.fromhex(H813),)).fetchone()[0]
            # p1 first at +5 s, p2 at +3 s and +9 s: first evidence at +3 s
            for src, secs in ((ids[0], 5), (ids[1], 3), (ids[1], 9)):
                c.execute("INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2,"
                          " merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)"
                          " VALUES (%s, %s, 813211, %s, %s, '\\x01', '\\x02', '', 536870912, 1, %s, true, '\\x03', 8)",
                          (self.block_time + timedelta(seconds=secs), src, f"j{secs}", stratum_prev, secs))
        self.addCleanup(self._cleanup_now)

    def _cleanup(self, c):
        c.execute("DELETE FROM stale_blocks WHERE block_hash = %s", (bytes.fromhex(H813),))
        c.execute("DELETE FROM blocks WHERE height BETWEEN 813209 AND 813210")
        c.execute("DELETE FROM templates WHERE height = 813211")
        c.execute("DELETE FROM sources WHERE site = 'si'")

    def _cleanup_now(self):
        with self.psycopg.connect(self.admin) as c:
            self._cleanup(c)

    def test_import_stores_the_row_and_bitcoin_parents_knows_it(self):
        identify = lambda script, addrs: {"id": 77, "name": "Synthetic"}   # noqa: E731
        dry = si.run(self.store, DATASET, str(FIX / "blocks"), dry_run=True, from_height=813211, to_height=813211,
                     identify=identify)
        self.assertEqual((dry["candidates_multi_pool"], dry["validated"], dry["stored"]), (1, 1, 0))
        s = si.run(self.store, DATASET, str(FIX / "blocks"), from_height=813211, to_height=813211, identify=identify)
        self.assertEqual((s["candidates_multi_pool"], s["in_dataset_multi_pool"], s["validated"], s["stored"],
                          s["full_blocks"], s["rejected"]), (1, 1, 1, 1, 1, []))
        with self.psycopg.connect(self.admin) as c:
            row = c.execute(
                "SELECT height, encode(prev_hash, 'hex'), header_source, chaintip_status, last_status, "
                "encode(tip_hash, 'hex'), fork_height, first_seen, was_active, reorg_id, full_block, tx_count, size, "
                "weight, pool_id, mining_pool->>'name', bits, version FROM stale_blocks WHERE block_hash = %s",
                (bytes.fromhex(H813),)).fetchone()
            self.assertEqual(row, (813210, PREV813, "bitcoin-data/stale-blocks", "not-in-node", "not-in-node", H813,
                                   813209, self.block_time + timedelta(seconds=3), False, None, True, 1, 456, 1824, 77,
                                   "Synthetic", 0x17049CA9, 0x3FFFE000))
            self.assertEqual(c.execute("SELECT source FROM bitcoin_parents WHERE block_hash = %s",
                                       (bytes.fromhex(H813),)).fetchall(), [("stale_blocks",)])
        # the stale-tip read (as the backend role) sees both pools on a recorded stale block with no reorg
        tips = self.store._run(lambda c: c.execute(
            "SELECT pool, tip, encode(stale_block_hash, 'hex'), reorg_id, stale_was_active, templates "
            "FROM stale_tip_templates(813211, 813211) ORDER BY pool").fetchall())
        self.assertEqual(tips, [(f"{self.tag}-p1", "stale", H813, None, False, 1),
                                (f"{self.tag}-p2", "stale", H813, None, False, 2)])
        # again: nothing left to import, the row untouched
        again = si.run(self.store, DATASET, str(FIX / "blocks"), from_height=813211, to_height=813211)
        self.assertEqual((again["candidates_multi_pool"], again["stored"]), (0, 0))
        self.assertFalse(self.store.insert_imported_stale_block(dict(
            si.parse_header(DATASET[H813]["header"]), height=813210, block_time=self.block_time, tip_hash=H813,
            fork_height=813209, first_seen=self.block_time)))

    def test_cli(self):
        import contextlib
        import io
        import json
        env = dict(PG_HOST=os.environ["PG_TEST_HOST"], PG_PORT=os.getenv("PG_TEST_PORT", "5432"),
                   PG_DATABASE=os.getenv("PG_TEST_DATABASE", "stratum"), PG_USER=os.environ["PG_TEST_USER"],
                   PG_PASSWORD=os.environ["PG_TEST_PASSWORD"], PG_SSLMODE="disable")
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            args = ["--csv", str(FIX / "stale-blocks.csv"), "--blocks-dir", str(FIX / "blocks"),
                    "--from-height", "813211", "--to-height", "813211"]
            for extra, stored in ((["--dry-run"], 0), ([], 1), ([], 0)):
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(si.main(args + extra), 0)
                summary = json.loads(out.getvalue())
                self.assertEqual((summary["stored"], summary["dry_run"]), (stored, bool(extra)), extra)
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        with self.psycopg.connect(self.admin) as c:
            self.assertEqual(c.execute("SELECT header_source, full_block, mining_pool IS NOT NULL FROM stale_blocks "
                                       "WHERE block_hash = %s", (bytes.fromhex(H813),)).fetchone(),
                             ("bitcoin-data/stale-blocks", True, True))

    def test_a_wrong_parent_is_not_stored(self):
        with self.psycopg.connect(self.admin) as c:
            c.execute("UPDATE blocks SET block_hash = %s WHERE height = 813209", (bytes.fromhex("00" * 32),))
        s = si.run(self.store, DATASET, None, from_height=813211, to_height=813211)
        self.assertEqual((s["stored"], [r["reason"] for r in s["rejected"]]), (0, ["prev_mismatch"]))
        with self.psycopg.connect(self.admin) as c:
            self.assertEqual(c.execute("SELECT count(*) FROM stale_blocks WHERE block_hash = %s",
                                       (bytes.fromhex(H813),)).fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
