"""Historical gap fill (gap_fill.py): missing blocks between MIN_BLOCK_HEIGHT and the stored tip, fetched from a peer
with getblockfrompeer when the node has pruned them. Against a fake pruned node and an in-memory store."""
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from gap_fill import HistoricalGapFiller, full_history_peers  # noqa: E402

PRUNED = "-1: Block not available (pruned data)"
FULL = ["NETWORK", "WITNESS", "NETWORK_LIMITED"]
LIMITED = ["WITNESS", "NETWORK_LIMITED"]


def bh(height):
    return f"{height:064x}"


class FakeNode:
    """A pruned node: heights in `pruned` have no block data until a peer in `serves` delivers it, `delay` polls
    after getblockfrompeer."""

    def __init__(self, tip, pruned=(), peers=(), serves=(), delay=0):
        self.tip, self.pruned, self.peers, self.serves, self.delay = tip, set(pruned), list(peers), set(serves), delay
        self.calls = []
        self.pending = {}   # hash -> polls left

    def __call__(self, method, *args):
        self.calls.append((method,) + args)
        if method == "getblockhash":
            if args[0] > self.tip:
                raise Exception("-8: Block height out of range")
            return bh(args[0])
        if method == "getpeerinfo":
            return self.peers
        if method == "getblockfrompeer":
            h, peer = args
            if not any(p["id"] == peer for p in self.peers):
                raise Exception("-1: Peer does not exist")
            if peer in self.serves:
                self.pending[h] = self.delay
            return {}
        if method == "getblock":
            return self.getblock(args[0])
        raise AssertionError(method)

    def getblock(self, h):
        height = int(h, 16)
        if height in self.pruned:
            if h in self.pending:
                if self.pending[h] <= 0:
                    self.pruned.discard(height)
                    return {"height": height}
                self.pending[h] -= 1
            raise Exception(PRUNED)
        return {"height": height}

    def rpc_methods(self):
        return [c[0] for c in self.calls]


class FakeStore:
    enabled = True

    def __init__(self, heights, known=()):
        self.heights = set(heights)
        self.known = set(known)
        self.reads = 0
        self.best_marked = []

    def highest_block_height(self):
        self.reads += 1
        return max(self.heights) if self.heights else None

    def block_heights_between(self, low, high_exclusive):
        self.reads += 1
        return {h for h in self.heights if low <= h < high_exclusive}

    def has_block_at_height(self, h):
        return h in self.heights

    def known_block_hashes(self, hashes):
        return [h for h in hashes if h in self.known]

    def mark_block_best(self, h):
        self.best_marked.append(h)
        self.heights.add(int(h, 16))


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def make(node, store, **kw):
    clock = Clock()
    stored = []

    def store_block(h):   # main.process_block_status: getblock, then save
        try:
            node.getblock(h)
        except Exception as e:
            return "pruned" if "pruned data" in str(e) else "error"
        store.heights.add(int(h, 16))
        stored.append(int(h, 16))
        return "ok"
    on_processor = []

    def run_on_processor(fn):
        on_processor.append(fn)
        return fn()
    kw.setdefault("min_height", 100)
    f = HistoricalGapFiller(node, store, store_block, run_on_processor, sleep=clock.sleep, clock=clock, **kw)
    f.stored, f.on_processor, f.fake_clock = stored, on_processor, clock
    return f


def peer(i, services=FULL, inbound=False):
    return {"id": i, "servicesnames": services, "inbound": inbound}


class GapFillTests(unittest.TestCase):
    def test_no_gaps_no_rpc(self):
        node = FakeNode(tip=110)
        store = FakeStore(range(100, 111))
        stats = make(node, store).run()
        self.assertEqual(node.calls, [])
        self.assertEqual(store.reads, 2)   # the tip and one ranged read
        self.assertEqual(stats["missing"], 0)

    def test_disabled_store_does_nothing(self):
        store = FakeStore([100, 105])
        store.enabled = False
        node = FakeNode(tip=110)
        make(node, store).run()
        self.assertEqual((node.calls, store.reads), ([], 0))

    def test_not_pruned_stored_directly(self):
        node = FakeNode(tip=110, peers=[peer(1)])
        store = FakeStore(set(range(100, 111)) - {103, 104})
        f = make(node, store)
        stats = f.run()
        self.assertEqual(sorted(f.stored), [103, 104])
        self.assertNotIn("getpeerinfo", node.rpc_methods())
        self.assertNotIn("getblockfrompeer", node.rpc_methods())
        self.assertEqual((stats["stored"], stats["from_peer"]), (2, 0))

    def test_pruned_fetched_from_peer_then_stored(self):
        node = FakeNode(tip=110, pruned=[103], peers=[peer(7)], serves=[7], delay=2)
        store = FakeStore(set(range(100, 111)) - {103})
        f = make(node, store)
        stats = f.run()
        self.assertEqual(f.stored, [103])
        self.assertIn(("getblockfrompeer", bh(103), 7), node.calls)
        self.assertEqual((stats["stored"], stats["from_peer"], stats["failed"]), (1, 1, 0))
        # the wait for the peer happened outside the block processor: two short store steps only
        self.assertEqual(len(f.on_processor), 2)

    def test_no_suitable_peer(self):
        node = FakeNode(tip=110, pruned=[103], peers=[peer(1, LIMITED), peer(2, LIMITED, inbound=True)], serves=[1, 2])
        store = FakeStore(set(range(100, 111)) - {103})
        stats = make(node, store).run()
        self.assertNotIn("getblockfrompeer", node.rpc_methods())
        self.assertEqual((stats["no_peer"], stats["stored"]), (1, 0))
        self.assertNotIn(103, store.heights)

    def test_no_peers_at_all(self):
        node = FakeNode(tip=110, pruned=[103, 105])
        store = FakeStore(set(range(100, 111)) - {103, 105})
        stats = make(node, store).run()
        self.assertEqual(stats["no_peer"], 2)
        self.assertEqual(node.rpc_methods().count("getpeerinfo"), 1)   # once per run

    def test_failing_peer_then_next_peer(self):
        # peer 1 accepts the request but never delivers; peer 2 rejects it (gone); peer 3 delivers
        node = FakeNode(tip=110, pruned=[103], peers=[peer(1), peer(3)], serves=[3])
        node.peers.insert(1, peer(2))
        real = node.__call__

        def rpc(method, *args):
            if method == "getblockfrompeer" and args[1] == 2:
                node.calls.append((method,) + args)
                raise Exception("-1: Peer does not exist")
            return real(method, *args)
        store = FakeStore(set(range(100, 111)) - {103})
        f = make(node, store, peer_timeout=5, poll_interval=1)
        f.rpc = rpc
        stats = f.run()
        asked = [c[2] for c in node.calls if c[0] == "getblockfrompeer"]
        self.assertEqual(asked, [1, 2, 3])
        self.assertEqual((stats["from_peer"], stats["failed"]), (1, 0))
        self.assertGreaterEqual(f.fake_clock.t, 5)   # waited out peer 1

    def test_all_peers_fail(self):
        node = FakeNode(tip=110, pruned=[103], peers=[peer(1), peer(2)], serves=[])
        store = FakeStore(set(range(100, 111)) - {103})
        stats = make(node, store, peer_timeout=3).run()
        self.assertEqual((stats["failed"], stats["stored"]), (1, 0))

    def test_max_peers_respected(self):
        node = FakeNode(tip=110, pruned=[103], peers=[peer(i) for i in range(1, 7)], serves=[6])
        store = FakeStore(set(range(100, 111)) - {103})
        stats = make(node, store, max_peers=3, peer_timeout=2).run()
        self.assertEqual([c[2] for c in node.calls if c[0] == "getblockfrompeer"], [1, 2, 3])
        self.assertEqual(stats["failed"], 1)

    def test_per_peer_timeout_bounds_the_wait(self):
        node = FakeNode(tip=110, pruned=[103], peers=[peer(1)], serves=[1], delay=1000)
        store = FakeStore(set(range(100, 111)) - {103})
        f = make(node, store, peer_timeout=10, poll_interval=1)
        f.run()
        self.assertLessEqual(f.fake_clock.t, 11)
        self.assertLessEqual(node.rpc_methods().count("getblock"), 12)

    def test_max_blocks_newest_first(self):
        missing = {101, 102, 103, 104, 105, 106}
        node = FakeNode(tip=110)
        store = FakeStore(set(range(100, 111)) - missing)
        f = make(node, store, max_blocks=4)
        stats = f.run()
        self.assertEqual(f.stored, [106, 105, 104, 103])
        self.assertEqual((stats["missing"], stats["attempted"]), (6, 4))
        self.assertEqual(node.rpc_methods().count("getblockhash"), 4)
        f.stored.clear()
        f.run()   # the next run takes the rest
        self.assertEqual(f.stored, [102, 101])

    def test_below_lowest_stored_block_counts(self):
        node = FakeNode(tip=110)
        store = FakeStore(range(105, 111))
        f = make(node, store)
        f.run()
        self.assertEqual(f.stored, [104, 103, 102, 101, 100])

    def test_block_stored_meanwhile_is_not_stored_again(self):
        node = FakeNode(tip=110)
        store = FakeStore(set(range(100, 111)) - {103})
        f = make(node, store)
        real = store.block_heights_between
        store.block_heights_between = lambda lo, hi: real(lo, hi) - {104}   # 104 "missing" at read time only
        f.run()
        self.assertEqual(f.stored, [103])

    def test_known_replaced_block_is_marked_best(self):
        node = FakeNode(tip=110)
        store = FakeStore(set(range(100, 111)) - {103}, known=[bh(103)])
        f = make(node, store)
        stats = f.run()
        self.assertEqual((store.best_marked, f.stored, stats["stored"]), ([bh(103)], [], 1))

    def test_already_downloaded_counts_as_delivered(self):
        node = FakeNode(tip=110, pruned=[], peers=[peer(1)])
        store = FakeStore(set(range(100, 111)) - {103})
        f = make(node, store)
        # pruned on the first store attempt only (e.g. downloaded by someone else in between)
        first = {"n": 0}
        orig = f.store_block

        def store_block(h):
            first["n"] += 1
            return "pruned" if first["n"] == 1 else orig(h)
        f.store_block = store_block
        real = node.__call__

        def rpc(method, *args):
            if method == "getblockfrompeer":
                node.calls.append((method,) + args)
                raise Exception("-1: Block already downloaded")
            return real(method, *args)
        f.rpc = rpc
        stats = f.run()
        self.assertEqual((stats["from_peer"], f.stored), (1, [103]))

    def test_getblockhash_failure_skips_height(self):
        node = FakeNode(tip=110)
        store = FakeStore(set(range(100, 111)) - {103, 104})
        f = make(node, store)
        real = node.__call__
        f.rpc = lambda m, *a: (_ for _ in ()).throw(Exception("timeout")) if (m, a) == ("getblockhash", (104,)) else real(m, *a)
        stats = f.run()
        self.assertEqual((stats["failed"], f.stored), (1, [103]))

    def test_store_error_does_not_ask_peers(self):
        node = FakeNode(tip=110, peers=[peer(1)])
        store = FakeStore(set(range(100, 111)) - {103})
        f = make(node, store)
        f.store_block = lambda h: "error"
        stats = f.run()
        self.assertNotIn("getpeerinfo", node.rpc_methods())
        self.assertEqual(stats["failed"], 1)


class PeerSelectionTests(unittest.TestCase):
    def test_network_peers_outbound_first(self):
        peers = [peer(5, inbound=True), peer(2, LIMITED), peer(9), peer(1, inbound=True), peer(4)]
        self.assertEqual(full_history_peers(peers), [4, 9, 1, 5])

    def test_services_hex_fallback(self):
        peers = [{"id": 1, "services": "0000000000000409"}, {"id": 2, "services": "0000000000000408"}]
        self.assertEqual(full_history_peers(peers), [1])


class MainWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import main
        cls.main = main

    def test_process_block_status_reports_pruned(self):
        with mock.patch.object(self.main, "build_block_doc", side_effect=self.main.PrunedBlockError("getblock: pruned data")):
            self.assertEqual(self.main.process_block_status("aa"), "pruned")
            self.assertFalse(self.main.process_block("aa"))

    def test_process_block_status_reports_error(self):
        with mock.patch.object(self.main, "build_block_doc", side_effect=RuntimeError("db down")):
            self.assertEqual(self.main.process_block_status("aa"), "error")

    def test_gap_filler_runs_the_store_step_on_the_block_processor(self):
        import threading
        f = self.main.gap_filler()
        self.assertEqual(f.on_block_processor(lambda: threading.current_thread().name).split("_")[0:2],
                         ["block", "processor"])


if __name__ == "__main__":
    unittest.main()
