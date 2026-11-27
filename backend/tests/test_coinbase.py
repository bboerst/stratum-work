import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from coinbase import coinbase_facts, dsha256, fold, merkle_branches, strip_witness  # noqa: E402
from coinbase_fill import BlockCoinbaseFiller  # noqa: E402
from gap_fill import HistoricalGapFiller  # noqa: E402


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
    def __init__(self, missing=(), missing_tx=(), stale=()):
        self.missing, self.missing_tx, self.filled, self.headers = list(missing), list(missing_tx), [], []
        self.stale = set(stale)

    def stale_block_hashes(self, hashes):
        return self.stale & set(hashes)

    def blocks_missing_branches(self, limit):
        return self.missing[:limit]

    def blocks_missing_coinbase_tx(self, limit):
        return self.missing_tx[:limit]

    def fill_block_coinbase(self, docs):
        self.filled += [dict(d) for d in docs]
        return len(docs)

    def fill_block_headers(self, docs):
        self.headers += docs
        return len(docs)


def coinbase_variant(i):
    """A segwit coinbase (with witness) and its stripped form, distinct per i (the locktime)."""
    with_wit, stripped = synthetic_segwit_coinbase()
    locktime = i.to_bytes(4, "little")
    return with_wit[:-4] + locktime, stripped[:-4] + locktime


class FakeNode:
    """getblock (verbosity 1), getrawtransaction <txid> false <hash>, getblockchaininfo; pruned blocks raise."""
    def __init__(self, n, pruned=()):
        self.blocks, self.pruned, self.calls = {}, set(pruned), []
        for i in range(n):
            with_wit, stripped = coinbase_variant(i)
            txids = [dsha256(stripped)] + [dsha256(bytes([i, j])) for j in range(1, 5)]
            h = f"{i:064x}"
            self.blocks[h] = {"tx": [t[::-1].hex() for t in txids], "merkleroot": root_of(txids)[::-1].hex(),
                              "size": 1000 + i, "weight": 4000 + i, "raw": with_wit.hex(), "stripped": stripped.hex()}

    def rpc(self, method, *args):
        self.calls.append((method, *args))
        if method == "getblockchaininfo":
            return {"pruneheight": 100, "blocks": 200}
        h = args[0] if method == "getblock" else args[2]
        if h in self.pruned:
            raise RuntimeError("Block not available (pruned data)" if method == "getblock" else "Block not available")
        b = self.blocks[h]
        if method == "getblock":
            return {k: v for k, v in b.items() if k not in ("raw", "stripped")}
        assert args[0] == b["tx"][0] and args[1] is False
        return b["raw"]


class FakeFetcher:
    """The gap filler's peer path: delivers the blocks in `deliverable` (un-prunes them on the node)."""
    def __init__(self, node, deliverable=(), peers=(1, 2, 3)):
        self.node, self.deliverable, self._peers, self.asked = node, set(deliverable), list(peers), []

    def peers(self):
        return list(self._peers)

    def fetch_from_peers(self, height, block_hash, peers, store_step):
        self.asked.append((height, block_hash, peers[0]))
        if block_hash not in self.deliverable:
            return False
        self.node.pruned.discard(block_hash)
        ok = store_step() == "ok"
        self.node.pruned.add(block_hash)          # the node may prune it again at once
        return ok


def header_fields(block):
    return {"size": block["size"], "weight": block["weight"]}


class CoinbaseFillTests(unittest.TestCase):
    def test_reads_everything_newest_first_and_stops_at_the_first_pruned_block(self):
        node = FakeNode(5, pruned={f"{3:064x}", f"{4:064x}"})
        todo = [(f"{i:064x}", 100 - i) for i in range(5)]
        s = FakeStore(todo)
        stats = BlockCoinbaseFiller(node.rpc, s, batch=2, header_fields=header_fields).run()
        self.assertEqual((stats["filled"], stats["failed"], stats["pruned_at"], stats["from_peer"]), (3, 0, 1, 0))
        self.assertNotIn(("getblock", f"{4:064x}", 1), node.calls)        # stopped at the first pruned one
        self.assertEqual([d["block_hash"] for d in s.filled], [h for h, _ in todo[:3]])
        for d in s.filled:
            b = node.blocks[d["block_hash"]]
            self.assertEqual(d["coinbase_txid"], b["tx"][0])
            self.assertEqual(d["coinbase_tx"], b["stripped"])            # witness stripped
            self.assertEqual(fold(bytes.fromhex(b["tx"][0])[::-1],
                                  [bytes.fromhex(d["merkle_branches"])[k:k + 32] for k in range(0, 96, 32)])[::-1].hex(),
                             b["merkleroot"])
        self.assertEqual([h["size"] for h in s.headers], [1000, 1001, 1002])

    def test_a_block_failing_the_self_check_is_skipped(self):
        node = FakeNode(2)
        node.blocks[f"{0:064x}"]["merkleroot"] = "00" * 32                 # branches don't fold to it
        node.blocks[f"{1:064x}"]["raw"] = coinbase_variant(9)[0].hex()       # bytes don't hash to the txid
        s = FakeStore([(f"{i:064x}", 10 - i) for i in range(2)])
        stats = BlockCoinbaseFiller(node.rpc, s).run()
        self.assertEqual((stats["filled"], stats["failed"]), (0, 2))
        self.assertEqual(s.filled, [])

    def test_coinbase_bytes_pass_fills_newest_first_checks_the_txid_and_stops_at_the_first_pruned_block(self):
        node = FakeNode(5, pruned={f"{3:064x}", f"{4:064x}"})
        node.blocks[f"{1:064x}"]["raw"] = coinbase_variant(9)[0].hex()       # doesn't hash to block 1's txid
        todo = [(h, b["tx"][0], 9) for h, b in node.blocks.items()]
        s = FakeStore([], todo)
        stats = BlockCoinbaseFiller(node.rpc, s, batch=1).run()
        self.assertEqual((stats["tx_missing"], stats["tx_filled"], stats["tx_failed"], stats["tx_pruned_at"]), (5, 2, 1, 1))
        self.assertNotIn(f"{4:064x}", [c[3] for c in node.calls if c[0] == "getrawtransaction"])
        self.assertEqual(s.filled, [{"block_hash": f"{i:064x}", "coinbase_tx": node.blocks[f"{i:064x}"]["stripped"]}
                                    for i in (0, 2)])

    def test_other_rpc_errors_are_retried_next_run(self):
        def rpc(*a):
            raise RuntimeError("No such transaction found in the provided block")
        s = FakeStore([("b1", 2)], [("b1", "aa" * 32, 2), ("b2", "bb" * 32, 1)])
        stats = BlockCoinbaseFiller(rpc, s).run()
        self.assertEqual((stats["tx_filled"], stats["tx_failed"], stats["tx_pruned_at"]), (0, 2, 0))
        self.assertEqual((stats["filled"], stats["failed"], stats["pruned_at"]), (0, 1, 0))
        self.assertEqual(s.filled, [])

    def test_peers_are_off_by_default(self):
        node = FakeNode(2, pruned={f"{0:064x}", f"{1:064x}"})
        f = FakeFetcher(node, deliverable=node.blocks)
        stats = BlockCoinbaseFiller(node.rpc, FakeStore([(h, 0) for h in node.blocks]), fetcher=f).run()
        self.assertEqual((stats["from_peer"], stats["pruned_at"]), (0, 1))
        self.assertEqual(f.asked, [])

    def test_pruned_blocks_come_from_peers_read_at_once_with_a_budget(self):
        hashes = [f"{i:064x}" for i in range(6)]
        node = FakeNode(6, pruned=set(hashes[1:]))
        f = FakeFetcher(node, deliverable=hashes)
        s = FakeStore([(h, 100 - i) for i, h in enumerate(hashes)])
        stats = BlockCoinbaseFiller(node.rpc, s, fetcher=f, peer_max_blocks=3, header_fields=header_fields).run()
        self.assertEqual((stats["filled"], stats["from_peer"], stats["pruned_at"]), (4, 3, 1))   # 0 locally, 1-3 from peers
        self.assertEqual([a[2] for a in f.asked], [1, 1, 1])        # the run's one list, ordered by the fetcher
        self.assertEqual([d["coinbase_tx"] for d in s.filled], [node.blocks[h]["stripped"] for h in hashes[:4]])
        self.assertEqual(len(s.headers), 4)
        self.assertIn(("getblockchaininfo",), node.calls)                                     # prune height logged

    def test_bad_peers_dont_stop_a_run_while_a_good_one_is_connected(self):
        # With the real gap filler's peer path. Outbound 2 delivers 5 blocks, then disconnects; outbound 5 and
        # inbound 3 never deliver (timeout); inbound 1 is gone; inbound 4 is pre-SegWit (no WITNESS); inbound 6
        # delivers. The whole budget is fetched, each slow peer waited out once.
        n = 21
        hashes = [f"{i:064x}" for i in range(n)]
        node = FakeNode(n, pruned=set(hashes))
        info = [{"id": 2, "servicesnames": ["NETWORK", "WITNESS"], "inbound": False},
                {"id": 5, "servicesnames": ["NETWORK", "WITNESS"], "inbound": False},
                {"id": 1, "servicesnames": ["NETWORK", "WITNESS"], "inbound": True},
                {"id": 3, "servicesnames": ["NETWORK", "WITNESS"], "inbound": True},
                {"id": 4, "servicesnames": ["NETWORK"], "inbound": True},
                {"id": 6, "servicesnames": ["NETWORK", "WITNESS"], "inbound": True}]
        gone, delivered, asked = set(), {2: 0, 6: 0}, []

        def rpc(method, *args):
            if method == "getpeerinfo":
                listed = [p for p in info if p["id"] not in gone]
                gone.add(1)                                           # 1 disconnects right after the listing
                return listed
            if method == "getblockfrompeer":
                h, p = args
                asked.append(p)
                if p in gone:
                    raise RuntimeError("Peer does not exist")
                if p == 4:
                    raise RuntimeError("Pre-SegWit peer")
                if p in delivered:
                    node.pruned.discard(h)
                    delivered[p] += 1
                    if p == 2 and delivered[2] == 5:
                        gone.add(2)
                return {}
            return node.rpc(method, *args)
        t = [0.0]

        def sleep(s):
            t[0] += s
        clock = lambda: t[0]  # noqa: E731
        fetcher = HistoricalGapFiller(rpc, None, None, None, min_height=0, max_peers=3, peer_timeout=30,
                                      poll_interval=1, sleep=sleep, clock=clock)
        s = FakeStore([(h, 1000 - i) for i, h in enumerate(hashes)])
        filler = BlockCoinbaseFiller(rpc, s, fetcher=fetcher, peer_max_blocks=n - 1, peer_max_failures=3, clock=clock)
        stats = filler.run()
        self.assertEqual((stats["from_peer"], stats["peer_failed"], stats["filled"]), (n - 1, 0, n - 1))
        self.assertIn("budget of", filler._peer["stopped"])
        self.assertNotIn(4, asked)                                    # filtered out by its services
        self.assertEqual(asked[:5], [2] * 5)
        self.assertEqual(asked[5:10], [2, 5, 1, 3, 6])                # 2 and 1 gone (no try used), 5 and 3 slow
        self.assertEqual(asked[10:], [6] * (n - 1 - 6))               # then the peer that delivers
        self.assertLessEqual(t[0], 2 * 31)                            # two timeouts in the whole run

    def test_peer_fetching_stops_after_failures_in_a_row_and_without_peers(self):
        hashes = [f"{i:064x}" for i in range(6)]
        node = FakeNode(6, pruned=set(hashes))
        f = FakeFetcher(node, deliverable={hashes[0]})
        stats = BlockCoinbaseFiller(node.rpc, FakeStore([(h, 9 - i) for i, h in enumerate(hashes)]), fetcher=f,
                                    peer_max_blocks=100, peer_max_failures=2).run()
        self.assertEqual((stats["from_peer"], stats["peer_failed"], stats["filled"]), (1, 2, 1))
        self.assertEqual(len(f.asked), 3)
        f2 = FakeFetcher(node, deliverable=hashes, peers=())
        stats = BlockCoinbaseFiller(node.rpc, FakeStore([(hashes[0], 9)]), fetcher=f2, peer_max_blocks=5).run()
        self.assertEqual((stats["from_peer"], stats["pruned_at"]), (0, 1))
        self.assertEqual(f2.asked, [])

    def test_peer_fetching_waits_until_the_coinbase_bytes_pass_is_caught_up(self):
        node = FakeNode(3, pruned={f"{2:064x}"})
        f = FakeFetcher(node, deliverable=node.blocks)
        # two blocks still need their bytes and the budget is 1: pass 1 isn't caught up, so no peer downloads
        s = FakeStore([(f"{2:064x}", 5)], [(h, node.blocks[h]["tx"][0], 9) for h in (f"{0:064x}", f"{1:064x}")])
        stats = BlockCoinbaseFiller(node.rpc, s, max_blocks=1, fetcher=f, peer_max_blocks=5).run()
        self.assertEqual((stats["tx_filled"], stats["from_peer"], stats["pruned_at"]), (1, 0, 1))
        self.assertEqual(f.asked, [])

    def test_a_pruned_block_missing_only_its_coinbase_bytes_comes_from_peers_too(self):
        node = FakeNode(2, pruned={f"{1:064x}"})
        f = FakeFetcher(node, deliverable=node.blocks)
        s = FakeStore([], [(h, node.blocks[h]["tx"][0], 9 - i) for i, h in enumerate(node.blocks)])
        stats = BlockCoinbaseFiller(node.rpc, s, fetcher=f, peer_max_blocks=5).run()
        self.assertEqual((stats["tx_filled"], stats["from_peer"], stats["tx_pruned_at"]), (2, 1, 0))
        self.assertEqual([d["coinbase_tx"] for d in s.filled], [b["stripped"] for b in node.blocks.values()])

    def test_stale_blocks_at_the_head_of_both_passes_dont_stop_the_run(self):
        # #339: peers never serve stale blocks. One heads pass 1, two head pass 2; before the fix they were 3
        # failures in a row and the run stopped with nothing fetched.
        hashes = [f"{i:064x}" for i in range(7)]
        node = FakeNode(7, pruned=set(hashes))
        stale = {hashes[0], hashes[3], hashes[4]}
        f = FakeFetcher(node, deliverable=set(hashes) - stale)
        s = FakeStore([(h, 90 - i) for i, h in enumerate(hashes[3:])],                     # pass 2: 3, 4 stale; 5, 6
                      [(h, node.blocks[h]["tx"][0], 99 - i) for i, h in enumerate(hashes[:3])],  # pass 1: 0 stale; 1, 2
                      stale=stale)
        filler = BlockCoinbaseFiller(node.rpc, s, fetcher=f, peer_max_blocks=4, peer_max_failures=3)
        stats = filler.run()
        self.assertEqual((stats["from_peer"], stats["peer_failed"], stats["stale_skipped"]), (4, 0, 3))
        self.assertEqual((stats["tx_filled"], stats["filled"], stats["tx_pruned_at"]), (2, 2, 0))
        self.assertEqual([a[1] for a in f.asked], [hashes[1], hashes[2], hashes[5], hashes[6]])   # stale never asked
        self.assertEqual(filler._peer["stopped"], "")              # the budget of 4 held exactly the 4 non-stale blocks
        self.assertEqual({d["block_hash"] for d in s.filled}, {hashes[1], hashes[2], hashes[5], hashes[6]})

    def test_a_stale_block_the_node_still_has_is_read_locally(self):
        hashes = [f"{i:064x}" for i in range(2)]
        node = FakeNode(2, pruned={hashes[1]})
        f = FakeFetcher(node, deliverable=hashes)
        s = FakeStore([(h, 9 - i) for i, h in enumerate(hashes)], stale=set(hashes))
        stats = BlockCoinbaseFiller(node.rpc, s, fetcher=f, peer_max_blocks=5).run()
        self.assertEqual((stats["filled"], stats["from_peer"], stats["stale_skipped"]), (1, 0, 1))
        self.assertEqual([d["block_hash"] for d in s.filled], [hashes[0]])
        self.assertEqual(f.asked, [])


if __name__ == "__main__":
    unittest.main()
