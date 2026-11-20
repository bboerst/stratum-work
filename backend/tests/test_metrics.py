"""/metrics (metrics.py): ZMQ hashblock receipt -> block saved, and blocks the reconciliation found instead of ZMQ."""
import os
import pathlib
import sys
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import metrics  # noqa: E402
from main_harness import import_main_module  # noqa: E402


def bucket(h: metrics.Histogram, le: float) -> int:
    cum, _, _ = h.snapshot()
    return cum[(list(h.bounds) + [float("inf")]).index(le)]


class HistogramTest(unittest.TestCase):
    def test_buckets_are_cumulative_and_inclusive(self):
        h = metrics.Histogram("t_seconds", "test", (0.05, 1, 10))
        for v in (0.05, 0.2, 1, 3, 50):
            h.observe(v)
        self.assertEqual([bucket(h, le) for le in (0.05, 1, 10, float("inf"))], [1, 3, 4, 5])
        text = h.render()
        for line in ('# TYPE t_seconds histogram', 't_seconds_bucket{le="0.05"} 1', 't_seconds_bucket{le="1.0"} 3',
                     't_seconds_bucket{le="10.0"} 4', 't_seconds_bucket{le="+Inf"} 5', 't_seconds_sum 54.25',
                     't_seconds_count 5'):
            self.assertIn(line + "\n", text)

    def test_counter(self):
        c = metrics.Counter("t_total", "test")
        c.inc()
        c.inc()
        self.assertIn("# TYPE t_total counter\nt_total 2.0\n", c.render())

    def test_buckets_cover_the_expected_range(self):
        b = metrics.zmq_block_saved_seconds.bounds
        self.assertEqual((b[0], b[-1]), (0.05, 40))
        self.assertIn(10, b)

    def test_render_lists_both_series(self):
        text = metrics.render()
        self.assertIn("# TYPE stratum_backend_zmq_block_saved_seconds histogram\n", text)
        self.assertIn("# TYPE stratum_backend_reconcile_blocks_saved_total counter\n", text)


class ProcessBlockMetricsTest(unittest.TestCase):
    def setUp(self):
        self.main, _ = import_main_module()
        self.store = mock.Mock()
        patches = [
            mock.patch.object(self.main, "store", self.store),
            mock.patch.object(self.main, "build_block_doc", return_value={"height": 900000, "timestamp": 0}),
            mock.patch.object(self.main, "publish_to_rabbitmq", lambda doc: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.hist, self.recon = metrics.zmq_block_saved_seconds, metrics.reconcile_blocks_saved_total
        self.assertIs(self.main.metrics, metrics)

    def counts(self):
        return self.hist.snapshot()[2], self.recon.value

    def test_zmq_block_observes_receipt_to_saved(self):
        n, r = self.counts()
        below, upto = bucket(self.hist, 1.5), bucket(self.hist, 3)
        seen_at = datetime.now(timezone.utc) - timedelta(seconds=2)
        self.assertEqual(self.main.process_block_status("aa", True, seen_at, "zmq"), "ok")
        self.store.save_block.assert_called_once()
        self.assertEqual(self.counts(), (n + 1, r))
        self.assertEqual(bucket(self.hist, 1.5), below)       # 2 s, not <= 1.5
        self.assertEqual(bucket(self.hist, 3), upto + 1)

    def test_clock_step_back_observes_zero(self):
        _, total, n = self.hist.snapshot()
        lowest = bucket(self.hist, 0.05)
        seen_at = datetime.now(timezone.utc) + timedelta(seconds=5)   # the clock stepped back after the receipt
        self.assertEqual(self.main.process_block_status("ab", True, seen_at, "zmq"), "ok")
        _, total2, n2 = self.hist.snapshot()
        self.assertEqual((n2, total2, bucket(self.hist, 0.05)), (n + 1, total, lowest + 1))

    def test_reconcile_block_is_counted(self):
        n, r = self.counts()
        self.assertTrue(self.main.process_block("bb", is_new_block=True, seen_via="reconcile"))
        self.assertEqual(self.counts(), (n, r + 1))

    def test_synced_and_failed_blocks_are_not_counted(self):
        n, r = self.counts()
        self.assertTrue(self.main.process_block("cc", is_new_block=False))
        self.store.save_block.side_effect = RuntimeError("db down")
        seen_at = datetime.now(timezone.utc)
        self.assertEqual(self.main.process_block_status("dd", True, seen_at, "zmq"), "error")
        self.assertFalse(self.main.process_block("ee", is_new_block=True, seen_via="reconcile"))
        self.assertEqual(self.counts(), (n, r))

    def test_reconciler_saves_blocks_as_reconcile(self):
        # The window's reconciler stores a missing block through process_block(h, True, seen_via="reconcile").
        self.main._reconciler = None
        with mock.patch("reconcile.BestChainReconciler") as cls:
            self.main.reconcile_recent_window()
        store_block = cls.call_args.kwargs["store_block"]
        n, r = self.counts()
        self.assertTrue(store_block("ff"))
        self.assertEqual(self.counts(), (n, r + 1))
        self.assertEqual(self.store.save_block.call_args.kwargs["seen_via"], "reconcile")

    def test_off_by_default(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("BACKEND_METRICS_PORT", None)
            main, _ = import_main_module()
        self.assertEqual(main.METRICS_PORT, 0)


class ServeTest(unittest.TestCase):
    def test_serves_metrics_and_nothing_else(self):
        server = metrics.serve(0, "127.0.0.1")
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_address[1]}"
        with urllib.request.urlopen(base + "/metrics", timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            self.assertTrue(resp.headers["Content-Type"].startswith("text/plain; version=0.0.4"))
            body = resp.read().decode()
        self.assertIn("stratum_backend_zmq_block_saved_seconds_count ", body)
        self.assertIn("stratum_backend_reconcile_blocks_saved_total ", body)
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(base + "/", timeout=5)
        self.assertEqual(e.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
