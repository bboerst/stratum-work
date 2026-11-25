import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from coinbase import coinbase_facts, dsha256, fold, merkle_branches, strip_witness  # noqa: E402
from coinbase_fill import BlockCoinbaseFiller  # noqa: E402


def root_of(txids):
    """Independent merkle root (whole-tree pairwise hashing), to check branches + fold against."""
    level = list(txids)
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [dsha256(level[i] + level[i + 1]) for i in range(0, len(level), 2)]
    return level[0]


def synthetic_segwit_coinbase():
    """A coinbase with the segwit marker and a 32-byte witness reserved value, and its non-witness form."""
    version, locktime = bytes.fromhex("01000000"), bytes(4)
    vin = bytes([1]) + bytes(32) + bytes.fromhex("ffffffff") + bytes([5]) + bytes.fromhex("03a0e40e00") + bytes.fromhex("ffffffff")
    vout = bytes([1]) + (50 * 10**8).to_bytes(8, "little") + bytes([2]) + bytes.fromhex("6a00")
    witness = bytes([1]) + bytes([32]) + bytes(32)
    return version + b"\x00\x01" + vin + vout + witness + locktime, version + vin + vout + locktime


def block_dict(txs_display, coinbase_hex=None, root=None):
    tx = [{"txid": t, **({"hex": coinbase_hex} if i == 0 and coinbase_hex else {})} for i, t in enumerate(txs_display)]
    return {"tx": tx, "merkleroot": root}


class CoinbaseTests(unittest.TestCase):
    def test_strip_witness(self):
        with_wit, without = synthetic_segwit_coinbase()
        self.assertEqual(strip_witness(with_wit), without)
        self.assertEqual(strip_witness(without), without)        # no marker: unchanged

    def test_branches_fold_to_the_root_for_odd_and_even_counts(self):
        for n in (1, 2, 3, 5, 8, 13):
            txids = [dsha256(bytes([i])) for i in range(n)]
            br = merkle_branches(txids)
            self.assertEqual(fold(txids[0], br), root_of(txids), n)
            if n > 1:
                self.assertEqual(br[0], txids[1])                  # branch 0 = the first transaction after the coinbase

    def test_facts_from_a_verbosity_2_block(self):
        with_wit, without = synthetic_segwit_coinbase()
        cb_txid = dsha256(without)
        txids = [cb_txid] + [dsha256(bytes([i])) for i in range(1, 5)]
        disp = [t[::-1].hex() for t in txids]
        f = coinbase_facts(block_dict(disp, with_wit.hex(), root_of(txids)[::-1].hex()))
        self.assertEqual(f["coinbase_txid"], disp[0])
        self.assertEqual(f["coinbase_tx"], without.hex())
        self.assertEqual(bytes.fromhex(f["merkle_branches"]), b"".join(merkle_branches(txids)))

    def test_facts_from_verbosity_1_have_no_coinbase_bytes(self):
        txids = [dsha256(bytes([i])) for i in range(3)]
        f = coinbase_facts({"tx": [t[::-1].hex() for t in txids], "merkleroot": root_of(txids)[::-1].hex()})
        self.assertNotIn("coinbase_tx", f)
        self.assertEqual(len(bytes.fromhex(f["merkle_branches"])), 64)

    def test_self_checks_reject_bad_data(self):
        txids = [dsha256(bytes([i])) for i in range(3)]
        disp = [t[::-1].hex() for t in txids]
        with self.assertRaises(ValueError):                         # wrong merkle root
            coinbase_facts(block_dict(disp, None, "00" * 32))
        with_wit, without = synthetic_segwit_coinbase()
        with self.assertRaises(ValueError):                         # coinbase bytes that don't hash to tx[0]'s txid
            coinbase_facts(block_dict(disp, with_wit.hex(), root_of(txids)[::-1].hex()))
        self.assertIsNone(coinbase_facts({"tx": [], "merkleroot": "00" * 32}))


class FakeStore:
    def __init__(self, hashes, missing_tx=()):
        self.hashes, self.missing_tx, self.filled = hashes, list(missing_tx), []

    def blocks_missing_branches(self, limit):
        return self.hashes[:limit]

    def blocks_missing_coinbase_tx(self, limit):
        return self.missing_tx[:limit]

    def fill_block_coinbase(self, docs):
        self.filled += docs
        return len(docs)


class CoinbaseFillTests(unittest.TestCase):
    def test_fills_newest_first_and_stops_at_the_first_pruned_block(self):
        good = {}
        for i in range(3):
            txids = [dsha256(bytes([i, j])) for j in range(4)]
            good[f"{i:064x}"] = {"tx": [t[::-1].hex() for t in txids], "merkleroot": root_of(txids)[::-1].hex()}
        hashes = list(good) + ["pruned", "older"]
        calls = []
        def rpc(m, h, v):
            calls.append(h)
            if h in ("pruned", "older"):
                raise RuntimeError("Block not available (pruned data)")
            return good[h]
        s = FakeStore(hashes)
        stats = BlockCoinbaseFiller(rpc, s, batch=2).run()
        self.assertEqual((stats["filled"], stats["failed"], stats["pruned_at"]), (3, 0, 1))
        self.assertNotIn("older", calls)                             # stopped at the first pruned one
        self.assertEqual([d["block_hash"] for d in s.filled], list(good))

    def test_a_block_failing_the_self_check_is_skipped(self):
        s = FakeStore(["bad"])
        stats = BlockCoinbaseFiller(lambda m, h, v: {"tx": ["11" * 32, "22" * 32], "merkleroot": "00" * 32}, s).run()
        self.assertEqual((stats["filled"], stats["failed"]), (0, 1))


    def test_coinbase_bytes_pass_fills_newest_first_checks_the_txid_and_stops_at_the_first_pruned_block(self):
        with_wit, stripped = synthetic_segwit_coinbase()
        txid = dsha256(stripped)[::-1].hex()
        legacy = bytes.fromhex("01000000") + stripped[4:]                     # same bytes: a non-segwit coinbase
        other = bytes.fromhex("02000000") + stripped[4:]
        raw = {"b1": with_wit.hex(), "b2": other.hex(), "b3": legacy.hex()}
        todo = [("b1", txid), ("b2", txid), ("b3", dsha256(legacy)[::-1].hex()), ("bp", txid), ("old", txid)]
        calls = []
        def rpc(m, txid_, verbose, block_hash):
            self.assertEqual((m, verbose), ("getrawtransaction", False))
            calls.append(block_hash)
            if block_hash in ("bp", "old"):
                raise RuntimeError("Block not available")
            return raw[block_hash]
        s = FakeStore([], todo)
        stats = BlockCoinbaseFiller(rpc, s, batch=2).run()
        self.assertEqual((stats["tx_missing"], stats["tx_filled"], stats["tx_failed"], stats["tx_pruned_at"]), (5, 2, 1, 1))
        self.assertNotIn("old", calls)                               # stopped at the first pruned one
        # b1: witness stripped; b2's bytes don't hash to the stored txid, so nothing is stored for it
        self.assertEqual(s.filled, [{"block_hash": "b1", "coinbase_tx": stripped.hex()},
                                    {"block_hash": "b3", "coinbase_tx": legacy.hex()}])

    def test_coinbase_bytes_pass_retries_other_rpc_errors_next_run(self):
        def rpc(*a):
            raise RuntimeError("No such transaction found in the provided block")
        s = FakeStore([], [("b1", "aa" * 32), ("b2", "bb" * 32)])
        stats = BlockCoinbaseFiller(rpc, s).run()
        self.assertEqual((stats["tx_filled"], stats["tx_failed"], stats["tx_pruned_at"]), (0, 2, 0))
        self.assertEqual(s.filled, [])


if __name__ == "__main__":
    unittest.main()
