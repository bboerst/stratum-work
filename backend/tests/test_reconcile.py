"""#212: best-chain reconciliation (reconcile.py) in both database modes, against a simulated node.

Postgres mode runs the real StaleBlockTracker.record_replaced() against an in-memory store with the blocks_best rule
(blocks minus currently stale stale_blocks rows). MongoDB mode uses the `stale: true` flag. Replaces test_gap_fill.py:
gap filling is the "missing" case of the reconciler.
"""
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from reconcile import BestChainReconciler  # noqa: E402
from stale_blocks import StaleBlockTracker  # noqa: E402
from test_stale_blocks import NOW, FakeNode, FakeStore, bhash  # noqa: E402

BASE = 1000   # node heights 1000..1004 unless a test grows the chain


class PgStore(FakeStore):
    """Postgres semantics: `blocks` keeps every stored block (hash -> height, seen_at); best = blocks_best."""
    enabled = True

    def __init__(self):
        super().__init__()
        self.rows = {}   # hash -> {"height", "seen_at"}

    def put(self, h, height, seen_at=None):
        self.rows[h] = {"height": height, "seen_at": seen_at}
        self.blocks.add(h)

    def _best(self):
        return {h: r for h, r in self.rows.items() if not (h in self.stale and self.stale[h]["reorged_in_at"] is None)}

    def highest_block_height(self):
        best = self._best()
        return max(r["height"] for r in best.values()) if best else None

    def best_block_hashes_between(self, low, high):
        out = {}
        for h, r in sorted(self._best().items()):
            if low <= r["height"] <= high:
                out.setdefault(r["height"], []).append(h)
        return out

    def mark_block_best(self, h):
        if h in self.stale and self.stale[h]["reorged_in_at"] is None:
            self.mark_stale_block_reactivated(h)

    def best_at(self, height):
        return self.best_block_hashes_between(height, height).get(height, [])

    def is_stale(self, h):
        return h in self.stale and self.stale[h]["reorged_in_at"] is None


class MongoStore:
    """MongoDB semantics: documents with an optional `stale` flag."""
    enabled = True

    def __init__(self):
        self.docs = {}   # hash -> {"height", "seen_at", "stale"}

    def put(self, h, height, seen_at=None):
        self.docs.setdefault(h, {"height": height, "seen_at": None, "stale": False})
        self.docs[h]["seen_at"] = self.docs[h]["seen_at"] or seen_at

    def highest_block_height(self):
        best = [d["height"] for d in self.docs.values() if not d["stale"]]
        return max(best) if best else None

    def best_block_hashes_between(self, low, high):
        out = {}
        for h, d in sorted(self.docs.items()):
            if low <= d["height"] <= high and not d["stale"]:
                out.setdefault(d["height"], []).append(h)
        return out

    def known_block_hashes(self, hashes):
        return {h for h in hashes if h in self.docs}

    def mark_blocks_stale(self, hashes):
        for h in hashes:
            self.docs[h]["stale"] = True

    def mark_block_best(self, h):
        self.docs[h]["stale"] = False

    def best_at(self, height):
        return self.best_block_hashes_between(height, height).get(height, [])

    def is_stale(self, h):
        return self.docs[h]["stale"]

    @property
    def rows(self):
        return self.docs


class Harness:
    def __init__(self, mode, window=144, min_height=BASE, length=5):
        self.mode = mode
        self.node = FakeNode(base=BASE, length=length)
        self.store = PgStore() if mode == "pg" else MongoStore()
        self.fail_store, self.fail_hash, self.fail_mark = set(), set(), False
        self.stored, self.hash_calls = [], []
        self.tracker = StaleBlockTracker(self.node, self.store, now=lambda: NOW) if mode == "pg" else None
        self.rec = BestChainReconciler(node_height=lambda: self.node.base + len(self.node.active) - 1,
                                       node_hashes=self.node_hashes, store=self.store, store_block=self.store_block,
                                       mark_replaced=self.mark_replaced, window=window, min_height=min_height)

    def node_hashes(self, heights):
        self.hash_calls.append(list(heights))
        return {h: self.node.rpc_getblockhash(h) for h in heights if h not in self.fail_hash}

    def store_block(self, h):   # main.process_block(h, is_new_block=True): fetched, seen now
        if h in self.fail_store:
            return False
        self.stored.append(h)
        self.store.put(h, self.node.blocks[h]["height"], seen_at=NOW)
        return True

    def mark_replaced(self, hashes):
        if self.fail_mark:
            raise RuntimeError("db down")
        if self.mode == "pg":
            self.tracker.record_replaced(hashes)
        else:
            self.store.mark_blocks_stale(hashes)

    def store_chain(self, hashes):
        """What the backend stored as each block arrived (seen live)."""
        for h in hashes:
            self.store.put(h, self.node.blocks[h]["height"], seen_at="live")

    def node_chain_is_best(self, low=BASE, high=None):
        high = high if high is not None else self.node.base + len(self.node.active) - 1
        return all(self.store.best_at(h) == [self.node.rpc_getblockhash(h)] for h in range(low, high + 1))


class ReconcileTests:
    mode = None

    def h(self, **kw):
        return Harness(self.mode, **kw)

    def test_interior_gap_is_filled_with_seen_at(self):
        t = self.h()
        a = t.node.active
        t.store_chain([a[0], a[1], a[3], a[4]])
        stats = t.rec.reconcile()
        self.assertEqual(t.stored, [a[2]])
        self.assertEqual(t.store.rows[a[2]]["seen_at"], NOW)
        self.assertEqual((stats["stored"], stats["replaced"], stats["checked"]), (1, 0, 5))
        self.assertTrue(t.node_chain_is_best())

    def test_replaced_block_is_marked_stale_and_winner_stored(self):
        # The node first had B at 1003 (stored by ZMQ), then reorged to a3 + a4; ZMQ announced only a4.
        t = self.h()
        a = t.node.active
        b = t.node.add("B", a[2], 1003)
        t.store_chain([a[0], a[1], a[2], b, a[4]])
        self.assertEqual(t.store.best_at(1003), [b])
        stats = t.rec.reconcile()
        self.assertEqual(t.stored, [a[3]])
        self.assertEqual(t.store.rows[a[3]]["seen_at"], NOW)   # detection time, not NULL
        self.assertTrue(t.store.is_stale(b))
        self.assertEqual(t.store.best_at(1003), [a[3]])
        self.assertEqual((stats["stored"], stats["replaced"]), (1, 1))
        self.assertTrue(t.node_chain_is_best())
        self.assertIn(b, t.store.rows)   # kept, only flagged

    def test_two_deep_replacement(self):
        t = self.h(length=6)
        a = t.node.active
        b1 = t.node.add("B1", a[1], 1002)
        b2 = t.node.add("B2", b1)
        t.store_chain([a[0], a[1], b1, b2, a[5]])   # ZMQ stored a5 after the reorg; a2..a4 never announced
        stats = t.rec.reconcile()
        self.assertEqual(sorted(t.stored), sorted([a[2], a[3], a[4]]))
        self.assertTrue(t.store.is_stale(b1) and t.store.is_stale(b2))
        self.assertEqual(stats["replaced"], 2)
        self.assertTrue(t.node_chain_is_best())

    def test_backend_down_across_the_reorg(self):
        # Stored up to B (the tip then); the backend restarts after the node reorged and grew: the startup sync adds
        # the heights above the stored tip, then the reconciler fixes B's height.
        t = self.h()
        a = t.node.active
        b = t.node.add("B", a[2], 1003)
        t.store_chain([a[0], a[1], a[2], b])
        t.rec.reconcile()   # before the sync: only up to the stored tip
        self.assertEqual(t.stored, [a[3]])
        self.assertTrue(t.store.is_stale(b))
        t.store_chain([a[4]])   # sync above the stored tip
        self.assertTrue(t.node_chain_is_best())

    def test_idempotent(self):
        t = self.h()
        a = t.node.active
        b = t.node.add("B", a[2], 1003)
        t.store_chain([a[0], a[1], a[2], b, a[4]])
        t.rec.reconcile()
        stored = list(t.stored)
        stats = t.rec.reconcile()
        self.assertEqual(t.stored, stored)
        self.assertEqual((stats["stored"], stats["replaced"], stats["reactivated"]), (0, 0, 0))

    def test_replaced_block_back_on_the_active_chain(self):
        # Reorg to a3, then back to B's branch (B + C now longer): B is known, so it's marked best, not refetched.
        t = self.h()
        a = t.node.active
        b = t.node.add("B", a[2], 1003)
        t.store_chain([a[0], a[1], a[2], b, a[4]])
        t.rec.reconcile()
        c = t.node.add("C", b)
        d = t.node.add("D", c)
        t.node.reorg_to(d)
        t.store_chain([d])   # ZMQ: the new tip
        stats = t.rec.reconcile()
        self.assertFalse(t.store.is_stale(b))
        self.assertTrue(t.store.is_stale(a[3]) and t.store.is_stale(a[4]))
        self.assertEqual(t.stored[-1], c)
        self.assertEqual(stats["reactivated"], 1)
        self.assertTrue(t.node_chain_is_best())

    def test_window_bounds_the_check(self):
        t = self.h(window=3)
        a = t.node.active
        t.store_chain([a[4]])
        t.rec.reconcile()
        self.assertEqual(t.hash_calls, [[1004, 1003, 1002]])
        self.assertEqual(sorted(t.stored), sorted([a[2], a[3]]))
        self.assertEqual(t.store.best_at(1001), [])

    def test_explicit_low_height_overrides_the_window(self):
        t = self.h(window=2)
        a = t.node.active
        t.store_chain([a[4]])
        t.rec.reconcile(low_height=1001)
        self.assertEqual(t.hash_calls, [[1004, 1003, 1002, 1001]])

    def test_respects_min_block_height(self):
        t = self.h(min_height=1003)
        t.store_chain([t.node.active[4]])
        t.rec.reconcile()
        self.assertEqual(t.hash_calls, [[1004, 1003]])
        self.assertEqual(t.stored, [t.node.active[3]])

    def test_failure_at_one_height_continues_and_retries_next_time(self):
        t = self.h()
        a = t.node.active
        t.store_chain([a[0], a[4]])
        t.fail_store, t.fail_hash = {a[2]}, {1001}
        stats = t.rec.reconcile()
        self.assertEqual(t.stored, [a[3]])
        self.assertEqual(stats["failed"], 2)
        t.fail_store, t.fail_hash = set(), set()
        t.rec.reconcile()
        self.assertTrue(t.node_chain_is_best())

    def test_marking_failure_is_retried(self):
        t = self.h()
        a = t.node.active
        b = t.node.add("B", a[2], 1003)
        t.store_chain([a[0], a[1], a[2], b, a[4]])
        t.fail_mark = True
        t.rec.reconcile()
        self.assertFalse(t.store.is_stale(b))
        t.fail_mark = False
        stats = t.rec.reconcile()
        self.assertEqual(stats["replaced"], 1)
        self.assertTrue(t.node_chain_is_best())

    def test_node_behind_the_stored_tip(self):
        # The node restarted and is catching up: blocks above its tip are left alone.
        t = self.h()
        a = t.node.active
        t.store_chain(a)
        t.node.active = a[:3]
        t.rec.reconcile()
        self.assertEqual(t.hash_calls, [[1002, 1001, 1000]])
        self.assertFalse(t.store.is_stale(a[4]))

    def test_disabled_with_zero_window(self):
        t = self.h(window=0)
        a = t.node.active
        t.store_chain([a[0], a[4]])
        stats = t.rec.reconcile()
        self.assertEqual((t.stored, t.hash_calls, stats["checked"]), ([], [], 0))
        t.rec.reconcile(low_height=1001)   # a reorg the tracker reported still runs
        self.assertTrue(t.node_chain_is_best())

    def test_nothing_stored_yet(self):
        t = self.h()
        t.rec.reconcile()
        self.assertEqual((t.stored, t.hash_calls), ([], []))

    def test_disabled_store(self):
        t = self.h()
        t.store.enabled = False
        t.rec.reconcile()
        self.assertEqual(t.hash_calls, [])


class PostgresModeTests(ReconcileTests, unittest.TestCase):
    mode = "pg"

    def test_stale_blocks_rows_like_the_tracker(self):
        t = self.h(length=6)
        a = t.node.active
        b1 = t.node.add("B1", a[1], 1002)
        b2 = t.node.add("B2", b1)
        t.store_chain([a[0], a[1], b1, b2, a[5]])
        t.rec.reconcile()
        rows = t.store.stale
        self.assertEqual(set(rows), {b1, b2})
        for h in (b1, b2):
            self.assertTrue(rows[h]["was_active"])
            self.assertEqual((rows[h]["fork_height"], rows[h]["tip_hash"], rows[h]["status"]), (1001, b2, "valid-fork"))
            self.assertTrue(rows[h]["full_block"])
            self.assertEqual(rows[h]["reorg_id"], 1)
        self.assertEqual(len(t.store.reorgs), 1)
        r = t.store.reorgs[0]
        self.assertEqual((r["depth"], r["fork_height"], r["old_tip_hash"], r["new_tip_hash"], r["new_tip_height"]),
                         (2, 1001, b2, a[5], 1005))

    def test_tracker_poll_afterwards_adds_no_second_reorg(self):
        t = self.h()
        a = t.node.active
        b = t.node.add("B", a[2], 1003)
        t.store_chain([a[0], a[1], a[2], b, a[4]])
        t.rec.reconcile()
        t.tracker.poll()
        self.assertEqual(len(t.store.reorgs), 1)
        self.assertTrue(t.store.is_stale(b))

    def test_tracker_first_then_reconciler(self):
        # The poll saw the reorg (stale row for B) before the reconciler ran: the reconciler only stores the winner.
        t = self.h()
        a = t.node.active
        b = t.node.add("B", a[2], 1003)
        t.store_chain([a[0], a[1], a[2], b, a[4]])
        t.tracker.poll()
        self.assertEqual(len(t.store.reorgs), 1)
        stats = t.rec.reconcile()
        self.assertEqual((stats["stored"], stats["replaced"]), (1, 0))
        self.assertEqual(len(t.store.reorgs), 1)
        self.assertTrue(t.node_chain_is_best())

    def test_invalid_status_from_getchaintips(self):
        t = self.h()
        a = t.node.active
        b = t.node.add("B", a[2], 1003)
        t.node.invalid.add(b)
        t.store_chain([a[0], a[1], a[2], b, a[4]])
        t.rec.reconcile()
        self.assertEqual(t.store.stale[b]["status"], "invalid")


class MongoModeTests(ReconcileTests, unittest.TestCase):
    mode = "mongo"


class RecordReplacedTests(unittest.TestCase):
    def test_unrelated_blocks_are_separate_branches(self):
        node = FakeNode(base=BASE, length=6)
        a = node.active
        x = node.add("X", a[0], 1001)
        y = node.add("Y", a[3], 1004)
        store = PgStore()
        store.put(x, 1001)
        store.put(y, 1004)
        StaleBlockTracker(node, store, now=lambda: NOW).record_replaced([y, x])
        self.assertEqual((store.stale[x]["fork_height"], store.stale[y]["fork_height"]), (1000, 1003))
        self.assertEqual(len(store.reorgs), 2)

    def test_unknown_header_is_skipped(self):
        node = FakeNode(base=BASE, length=3)
        store = PgStore()
        self.assertEqual(StaleBlockTracker(node, store, now=lambda: NOW).record_replaced([bhash("nope")]), 0)


class MainWiringTests(unittest.TestCase):
    """main.reconcile_recent_window / mark_replaced_blocks: which store path each mode takes."""

    @classmethod
    def setUpClass(cls):
        import main
        cls.main = main

    def test_mongo_marks_documents_stale(self):
        store = mock.Mock(spec=["mark_blocks_stale"])
        with mock.patch.object(self.main, "store", store):
            self.main.mark_replaced_blocks(["aa"])
        store.mark_blocks_stale.assert_called_once_with(["aa"])

    def test_postgres_records_through_the_tracker(self):
        store = mock.Mock(supports_stale_blocks=True)
        recorder = mock.Mock()
        with mock.patch.object(self.main, "store", store), mock.patch.object(self.main, "stale_recorder", lambda: recorder):
            self.main.mark_replaced_blocks(["aa"])
        recorder.record_replaced.assert_called_once_with(["aa"])
        store.mark_blocks_stale.assert_not_called()

    def test_reconcile_never_raises(self):
        broken = mock.Mock()
        broken.reconcile.side_effect = RuntimeError("rpc down")
        with mock.patch.object(self.main, "_reconciler", broken):
            self.assertEqual(self.main.reconcile_recent_window(), {})

    def test_process_block_reports_failure(self):
        with mock.patch.object(self.main, "build_block_doc", side_effect=RuntimeError("db down")):
            self.assertFalse(self.main.process_block("aa", True))

    def test_block_processor_is_serial(self):
        self.assertEqual(self.main.block_processor._max_workers, 1)


if __name__ == "__main__":
    unittest.main()
