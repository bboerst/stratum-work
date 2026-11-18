import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from header_fill import BlockHeaderFiller  # noqa: E402

HEADER_FIELDS = {"nTx": "transactions", "version": "version", "merkleroot": "merkle_root", "bits": "bits",
                 "nonce": "nonce", "difficulty": "difficulty", "size": "size", "weight": "weight"}


def fields(h):  # same mapping as main.block_header_fields
    return {v: h[k] for k, v in HEADER_FIELDS.items() if h.get(k) is not None}


class FakeStore:
    def __init__(self, missing):
        self.missing, self.filled, self.fail_next = list(missing), [], False

    def blocks_missing_header(self, limit):
        return self.missing[:limit]

    def fill_block_headers(self, docs):
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("db down")
        self.filled.extend(docs)
        return len(docs)


def header(h):
    return {"hash": h, "nTx": 3000, "version": 0x20000000, "merkleroot": "ab" * 32, "bits": "17034219", "nonce": 7,
            "difficulty": 1.5e14}


class HeaderFillTests(unittest.TestCase):
    def test_nothing_missing_makes_no_rpc(self):
        calls = []
        s = FakeStore([])
        stats = BlockHeaderFiller(lambda *a: calls.append(a), s, fields).run()
        self.assertEqual(stats, {"missing": 0, "filled": 0, "failed": 0})
        self.assertEqual(calls, [])

    def test_fills_header_fields_in_batches_without_size_or_weight(self):
        s = FakeStore([f"{i:064x}" for i in range(5)])
        stats = BlockHeaderFiller(lambda m, h: header(h), s, fields, batch=2).run()
        self.assertEqual(stats, {"missing": 5, "filled": 5, "failed": 0})
        self.assertEqual([d["block_hash"] for d in s.filled], s.missing)
        d = s.filled[0]
        self.assertEqual((d["transactions"], d["bits"], d["merkle_root"]), (3000, "17034219", "ab" * 32))
        self.assertNotIn("size", d)  # getblockheader has no size/weight: they stay NULL

    def test_rpc_and_store_failures_are_counted_and_skipped(self):
        s = FakeStore([f"{i:064x}" for i in range(4)])
        def rpc(m, h):
            if h.endswith("1"):
                raise RuntimeError("node busy")
            return header(h)
        s.fail_next = True  # the first batch fails to store
        stats = BlockHeaderFiller(rpc, s, fields, batch=2).run()
        self.assertEqual(stats["missing"], 4)
        self.assertEqual(stats["failed"], 1 + 2)   # one RPC error + one failed batch of 2
        self.assertEqual(stats["filled"], 1)
        self.assertEqual(len(s.filled), 1)

    def test_respects_max_blocks(self):
        s = FakeStore([f"{i:064x}" for i in range(10)])
        stats = BlockHeaderFiller(lambda m, h: header(h), s, fields, max_blocks=3).run()
        self.assertEqual(stats["missing"], 3)
        self.assertEqual(len(s.filled), 3)


if __name__ == "__main__":
    unittest.main()
