"""Full-history best-chain check (best_chain_history.py): a wrong stored best block deep below the reconciler's window
is found in chunks outside the block processor and fixed on it, stored as synced (seen_at NULL), through the gap
filler's getblockfrompeer path on a pruned node. Against the simulated node and store of test_reconcile.py (with the
real StaleBlockTracker.record_replaced)."""
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from best_chain_history import BestChainHistoryCheck  # noqa: E402
from gap_fill import HistoricalGapFiller  # noqa: E402
from reconcile import BestChainReconciler  # noqa: E402
from stale_blocks import StaleBlockTracker  # noqa: E402
from test_reconcile import BASE, PgStore  # noqa: E402
from test_stale_blocks import NOW, FakeNode, bhash  # noqa: E402

PRUNED = "-1: Block not available (pruned data)"
LENGTH = 40   # node heights 1000..1039


class Harness:
    def __init__(self, chunk=8, window=3, min_height=BASE):
        self.node = FakeNode(base=BASE, length=LENGTH)
        self.store = PgStore()
        self.tracker = StaleBlockTracker(self.node, self.store, now=lambda: NOW)
        self.pruned, self.fail_store, self.peer_list = set(), set(), [{"id": 1, "servicesnames": ["NETWORK"]}]
        self.stored, self.marked, self.hash_calls, self.on_processor_calls = [], [], [], []
        self.in_processor = False
        self.reconciler = BestChainReconciler(
            node_height=self.tip, node_hashes=self.node_hashes, store=self.store, store_block=self.never,
            mark_replaced=self.mark_replaced, window=window, min_height=min_height)
        self.filler = HistoricalGapFiller(self.rpc, self.store, store_block=self.never,
                                          on_block_processor=self.on_processor, min_height=min_height,
                                          peer_timeout=5, poll_interval=1, sleep=lambda s: None)
        self.check = BestChainHistoryCheck(self.reconciler, node_height=self.tip, node_hashes=self.node_hashes,
                                           store_block=self.store_block, on_block_processor=self.on_processor,
                                           fetcher=self.filler, min_height=min_height, chunk=chunk)

    def tip(self):
        return self.node.base + len(self.node.active) - 1

    def never(self, h):
        raise AssertionError("the history check passes its own store_block")

    def node_hashes(self, heights):
        self.hash_calls.append((self.in_processor, list(heights)))
        return {h: self.node.rpc_getblockhash(h) for h in heights}

    def on_processor(self, fn):
        self.on_processor_calls.append(fn)
        self.in_processor = True
        try:
            return fn()
        finally:
            self.in_processor = False

    def store_block(self, h):   # main.process_block_status(h, is_new_block=False): getblock, save as synced
        assert self.in_processor, "stores run on the block processor"
        if h in self.pruned:
            return "pruned"
        if h in self.fail_store:
            return "error"
        self.stored.append(h)
        self.store.put(h, self.node.blocks[h]["height"], seen_at=None)
        return "ok"

    def mark_replaced(self, hashes):
        assert self.in_processor
        self.marked.append(list(hashes))
        self.tracker.record_replaced(hashes)

    def rpc(self, method, *args):   # the node as the gap filler's peer path sees it
        if method == "getpeerinfo":
            return self.peer_list
        if method == "getblockfrompeer":
            self.pruned.discard(args[0])
            return {}
        if method == "getblock":
            if args[0] in self.pruned:
                raise Exception(PRUNED)
            return {}
        raise AssertionError(method)

    def store_chain(self, hashes):
        for h in hashes:
            self.store.put(h, self.node.blocks[h]["height"], seen_at="live")

    def with_stale_at(self, height, node_knows_header=True):
        """The stored chain, but at `height` a stale block S instead of the node's (the node's isn't stored)."""
        a = self.node.active
        if node_knows_header:
            s = self.node.add("S", a[height - BASE - 1], height)
        else:
            s = bhash("S-unknown")
        self.store_chain([x for x in a if x != a[height - BASE]])
        self.store.put(s, height, seen_at="live")
        return s, a[height - BASE]

    def node_chain_is_best(self):
        return all(self.store.best_at(h) == [self.node.rpc_getblockhash(h)] for h in range(BASE, self.tip() + 1))


class HistoryTests(unittest.TestCase):
    def h(self, **kw):
        return Harness(**kw)

    def test_mismatch_deep_below_the_window_is_found_and_fixed(self):
        t = self.h(window=3)
        s, w = t.with_stale_at(1005)
        self.assertEqual(t.reconciler.reconcile(), {"checked": 3, "stored": 0, "reactivated": 0, "replaced": 0, "failed": 0})
        self.assertEqual(t.store.best_at(1005), [s])   # the window doesn't reach it
        stats = t.check.run()
        self.assertEqual({k: stats[k] for k in ("checked", "mismatched", "stored", "replaced", "failed")},
                         {"checked": LENGTH, "mismatched": 1, "stored": 1, "replaced": 1, "failed": 0})
        self.assertIn("duration_s", stats)
        self.assertEqual(t.stored, [w])
        self.assertTrue(t.store.is_stale(s))
        self.assertTrue(t.node_chain_is_best())
        again = t.check.run()   # idempotent
        self.assertEqual((again["mismatched"], again["stored"], again["replaced"]), (0, 0, 0))

    def test_stored_block_is_not_seen_live(self):
        t = self.h()
        _, w = t.with_stale_at(1005)
        t.check.run()
        self.assertIsNone(t.store.rows[w]["seen_at"])

    def test_scan_outside_the_block_processor_fixes_on_it(self):
        t = self.h(chunk=8)
        t.with_stale_at(1005)
        t.check.run()
        outside = [hs for inside, hs in t.hash_calls if not inside]
        inside = [hs for inside, hs in t.hash_calls if inside]
        self.assertEqual(len(outside), 5)   # 40 heights / 8
        self.assertEqual(inside, [[1005]])   # only the mismatched height, re-read on the processor
        self.assertEqual(len(t.on_processor_calls), 1)

    def test_chunking_covers_every_height_exactly_once(self):
        for chunk in (1, 7, 8, 39, 40, 1000):
            t = self.h(chunk=chunk)
            t.store_chain(t.node.active)
            t.check.run()
            seen = [h for inside, hs in t.hash_calls if not inside for h in hs]
            self.assertEqual(sorted(seen), list(range(BASE, BASE + LENGTH)), chunk)
            self.assertEqual(sorted(h for c in t.check.chunks(BASE + LENGTH - 1) for h in c), sorted(seen))
            self.assertEqual(t.on_processor_calls, [])   # nothing wrong: the block processor isn't used

    def test_min_height_and_node_behind(self):
        t = self.h(min_height=1010)
        t.store_chain(t.node.active)
        t.node.active = t.node.active[:30]   # node restarted, at 1029
        stats = t.check.run()
        self.assertEqual(stats["checked"], 20)
        self.assertEqual(sorted(h for _, hs in t.hash_calls for h in hs), list(range(1010, 1030)))

    def test_missing_height_is_left_to_the_gap_filler(self):
        t = self.h()
        a = t.node.active
        t.store_chain(a[:5] + a[6:])
        stats = t.check.run()
        self.assertEqual((stats["mismatched"], t.stored), (0, []))

    def test_pruned_block_is_fetched_from_a_peer_then_stored(self):
        t = self.h()
        s, w = t.with_stale_at(1005)
        t.pruned.add(w)
        stats = t.check.run()
        self.assertEqual((stats["stored"], stats["from_peer"], stats["failed"], stats["replaced"]), (1, 1, 0, 1))
        self.assertNotIn(w, t.pruned)   # getblockfrompeer was asked
        self.assertIsNone(t.store.rows[w]["seen_at"])
        self.assertTrue(t.node_chain_is_best())
        self.assertEqual(len(t.marked), 1)   # marked once, after the store from the peer

    def test_pruned_and_no_peer_retried_next_run(self):
        t = self.h()
        s, w = t.with_stale_at(1005)
        t.pruned.add(w)
        t.peer_list = []
        stats = t.check.run()
        self.assertEqual((stats["stored"], stats["failed"], t.marked), (0, 1, []))
        self.assertEqual(t.store.best_at(1005), [s])   # untouched: never marked without storing the node's block
        t.peer_list = [{"id": 1, "servicesnames": ["NETWORK"]}]
        t.check.run()
        self.assertTrue(t.node_chain_is_best())

    def test_no_mark_replaced_when_the_store_fails(self):
        t = self.h()
        s, w = t.with_stale_at(1005)
        t.fail_store.add(w)
        stats = t.check.run()
        self.assertEqual((stats["stored"], stats["replaced"], stats["failed"]), (0, 0, 1))
        self.assertEqual(t.marked, [])
        self.assertEqual(t.store.best_at(1005), [s])
        t.fail_store.clear()
        stats = t.check.run()
        self.assertEqual((stats["stored"], stats["replaced"]), (1, 1))
        self.assertTrue(t.node_chain_is_best())

    def test_store_error_while_reading_a_chunk_continues(self):
        t = self.h(chunk=8)
        t.with_stale_at(1030)
        real = t.store.best_block_hashes_between
        calls = []

        def flaky(low, high):
            calls.append(low)
            if len(calls) == 1:
                raise RuntimeError("db down")
            return real(low, high)
        with mock.patch.object(t.store, "best_block_hashes_between", flaky):
            stats = t.check.run()
        self.assertEqual((stats["failed"], stats["stored"]), (8, 1))
        self.assertTrue(t.node_chain_is_best())

    def test_disabled_store(self):
        t = self.h()
        t.store.enabled = False
        t.check.run()
        self.assertEqual(t.hash_calls, [])

    def test_stale_row_for_the_replaced_block(self):
        t = self.h()
        s, w = t.with_stale_at(1005)
        t.check.run()
        row = t.store.stale[s]
        self.assertTrue(row["was_active"])
        self.assertEqual((row["height"], row["fork_height"], row["status"]), (1005, 1004, "valid-fork"))

    def test_node_without_the_header_does_not_crash_and_retries(self):
        # The node never saw the stale block: no header, so record_replaced can't write its stale_blocks row.
        t = self.h()
        s, w = t.with_stale_at(1005, node_knows_header=False)
        stats = t.check.run()
        self.assertEqual((stats["stored"], stats["replaced"], stats["failed"]), (1, 0, 1))
        self.assertEqual(sorted(t.store.best_at(1005)), sorted([s, w]))   # node's stored, the stale one not hidden
        self.assertNotIn(s, t.store.stale)
        stats = t.check.run()   # retried: nothing stored again, still failed
        self.assertEqual((stats["mismatched"], stats["stored"], stats["failed"]), (1, 0, 1))
        self.assertEqual(t.stored, [w])


class ReconcileHeightsTests(unittest.TestCase):
    def test_window_default_still_marks_when_the_store_fails(self):
        # reconcile()'s behaviour is unchanged: the replaced block is marked even if the winner couldn't be stored.
        marked = []
        store = mock.Mock(enabled=True)
        store.known_block_hashes.return_value = set()
        r = BestChainReconciler(node_height=lambda: 0, node_hashes=lambda hs: {}, store=store,
                                store_block=lambda h: False, mark_replaced=marked.append, window=1, min_height=0)
        r.reconcile_heights([5], {5: ["old"]}, {5: "new"})
        self.assertEqual(marked, [["old"]])
        marked.clear()
        r.reconcile_heights([5], {5: ["old"]}, {5: "new"}, replace_only_when_best=True)
        self.assertEqual(marked, [])


class MainWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import main
        cls.main = main

    def test_stores_as_synced_and_fixes_on_the_block_processor(self):
        import threading
        c = self.main.best_chain_history_check()
        with mock.patch.object(self.main, "process_block_status", return_value="ok") as pbs:
            self.assertEqual(c.store_block("aa"), "ok")
        pbs.assert_called_once_with("aa", is_new_block=False)
        self.assertEqual(c.on_block_processor(lambda: threading.current_thread().name).split("_")[0:2],
                         ["block", "processor"])
        self.assertEqual(c.min_height, self.main.MIN_BLOCK_HEIGHT)

    def _loop(self, fill_s, history_s, runs=3):
        """sync_then_fill_gaps with the given intervals on a fake clock (sleep advances it); stops after `runs`
        sleeps."""
        class Stop(Exception):
            pass
        t, sleeps = [0.0], []

        def sleep(s):
            sleeps.append(s)
            t[0] += s
            if len(sleeps) >= runs:
                raise Stop
        filler, history = mock.Mock(), mock.Mock()
        store = mock.Mock(enabled=True)
        with mock.patch.multiple(self.main, BLOCK_GAP_FILL_INTERVAL_S=fill_s, BEST_CHAIN_HISTORY_INTERVAL_S=history_s,
                                 HEADER_FILL_MAX_BLOCKS=0, COINBASE_FILL_MAX_BLOCKS=0, store=store,
                                 sync_blocks=mock.DEFAULT, start_unknown_parents_refresher=mock.DEFAULT,
                                 gap_filler=lambda: filler,
                                 best_chain_history_check=mock.Mock(return_value=history)), \
                mock.patch.object(self.main.time, "sleep", sleep), \
                mock.patch.object(self.main.time, "monotonic", lambda: t[0]):
            try:
                self.main.sync_then_fill_gaps()
            except Stop:
                pass
        return filler, history, sleeps

    def test_interval_zero_is_off(self):
        filler, history, _ = self._loop(fill_s=3600, history_s=0)
        self.assertEqual(history.run.call_count, 0)
        self.assertEqual(filler.run.call_count, 3)

    def test_both_off_returns(self):
        filler, history, sleeps = self._loop(fill_s=0, history_s=0)
        self.assertEqual((filler.run.call_count, history.run.call_count, sleeps), (0, 0, []))

    def test_runs_once_at_startup_with_gap_fill_off(self):
        filler, history, sleeps = self._loop(fill_s=0, history_s=86400, runs=2)
        self.assertEqual((filler.run.call_count, history.run.call_count), (0, 2))
        self.assertEqual(sleeps, [86400, 86400])

    def test_each_on_its_own_interval(self):
        # t=0: both; 3600: fill; 7200: both; 10800: fill
        filler, history, sleeps = self._loop(fill_s=3600, history_s=7200, runs=4)
        self.assertEqual((filler.run.call_count, history.run.call_count), (4, 2))
        self.assertEqual(sleeps, [3600] * 4)


if __name__ == "__main__":
    unittest.main()
