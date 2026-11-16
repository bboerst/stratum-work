import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import main  # noqa: E402


class MissingHeightsTests(unittest.TestCase):
    def test_interior_gap(self):
        self.assertEqual(main.missing_heights(100, 105, {100, 101, 103, 105}), [104, 102])

    def test_none_missing(self):
        self.assertEqual(main.missing_heights(100, 102, {100, 101, 102}), [])

    def test_empty_range(self):
        self.assertEqual(main.missing_heights(105, 100, set()), [])


class FakeStore:
    enabled = True

    def __init__(self, heights):
        self.heights = set(heights)
        self.calls = []

    def highest_block_height(self):
        return max(self.heights) if self.heights else None

    def block_heights_between(self, low, high_exclusive):
        self.calls.append((low, high_exclusive))
        return {h for h in self.heights if low <= h < high_exclusive}


class FillRecentGapsTests(unittest.TestCase):
    def run_fill(self, heights, tip=None, window=144, min_height=0, fail=()):
        store = FakeStore(heights)
        processed = []

        def process_block(block_hash, is_new_block=False):
            h = int(block_hash.split("-")[1])
            if h in fail:
                raise RuntimeError("db down")
            processed.append((h, is_new_block))
            store.heights.add(h)

        with mock.patch.object(main, "store", store), \
             mock.patch.object(main, "BLOCK_GAP_WINDOW", window), \
             mock.patch.object(main, "MIN_BLOCK_HEIGHT", min_height), \
             mock.patch.object(main, "retry_rpc", lambda fn, name, h: f"hash-{h}"), \
             mock.patch.object(main, "process_block", process_block):
            n = main.fill_recent_gaps(tip)
        return n, processed, store

    def test_fills_an_interior_gap_once_as_sync(self):
        n, processed, _ = self.run_fill({1000, 1001, 1003, 1004}, window=5)
        self.assertEqual(n, 1)
        self.assertEqual(processed, [(1002, False)])

    def test_window_bounds_the_check(self):
        _, processed, store = self.run_fill({900, 1000}, tip=1000, window=10)
        self.assertEqual(store.calls, [(991, 1001)])
        self.assertEqual(processed, [(h, False) for h in range(999, 990, -1)])

    def test_respects_min_block_height(self):
        _, processed, _ = self.run_fill({1000}, tip=1000, window=144, min_height=998)
        self.assertEqual(processed, [(999, False), (998, False)])

    def test_failure_is_logged_and_others_continue(self):
        n, processed, store = self.run_fill({1000, 1004}, window=5, fail={1002})
        self.assertEqual(n, 2)
        self.assertEqual(processed, [(1003, False), (1001, False)])
        self.assertNotIn(1002, store.heights)

    def test_disabled_with_zero_window(self):
        n, processed, store = self.run_fill({1000, 1002}, window=0)
        self.assertEqual((n, processed, store.calls), (0, [], []))

    def test_no_blocks_stored(self):
        n, processed, _ = self.run_fill(set())
        self.assertEqual((n, processed), (0, []))


if __name__ == "__main__":
    unittest.main()
