import socket
import struct
import unittest
from unittest.mock import Mock, patch

from collector.latency import LatencyTracker, parse_tcp_info_rtt_us


def ms(n):
    return n * 1_000_000


class LatencyTrackerEstimateTests(unittest.TestCase):
    def test_no_samples_returns_none(self):
        tracker = LatencyTracker(proxied=False)
        self.assertIsNone(tracker.estimate())

    def test_direct_prefers_tcp_rtt_half(self):
        tracker = LatencyTracker(proxied=False)
        tracker.record_tcp_rtt_us(20_000)  # 20 ms RTT
        tracker.record_send(1, 0)
        tracker.try_resolve({"id": 1}, ms(100))  # 100 ms app RTT
        latency_ms, method = tracker.estimate()
        self.assertAlmostEqual(latency_ms, 10.0)
        self.assertEqual(method, "tcp")

    def test_direct_falls_back_to_app_without_tcp_info(self):
        tracker = LatencyTracker(proxied=False)
        tracker.record_send(1, 0)
        tracker.try_resolve({"id": 1}, ms(30))
        latency_ms, method = tracker.estimate()
        self.assertAlmostEqual(latency_ms, 15.0)
        self.assertEqual(method, "app")

    def test_proxied_uses_app_min_over_window_ignoring_tcp(self):
        tracker = LatencyTracker(proxied=True)
        tracker.record_tcp_rtt_us(1_000)  # RTT to local proxy: must be ignored
        for i, rtt_ms in enumerate([80, 60, 120]):
            tracker.record_send(i, 0)
            tracker.try_resolve({"id": i}, ms(rtt_ms))
        latency_ms, method = tracker.estimate()
        self.assertAlmostEqual(latency_ms, 30.0)  # min(60 ms) / 2
        self.assertEqual(method, "app")

    def test_proxied_without_app_samples_returns_none(self):
        tracker = LatencyTracker(proxied=True)
        tracker.record_tcp_rtt_us(1_000)
        self.assertIsNone(tracker.estimate())

    def test_app_window_keeps_last_8_samples(self):
        tracker = LatencyTracker(proxied=True)
        tracker.record_send(0, 0)
        tracker.try_resolve({"id": 0}, ms(10))  # will be evicted
        for i in range(1, 9):
            tracker.record_send(i, 0)
            tracker.try_resolve({"id": i}, ms(50))
        latency_ms, _ = tracker.estimate()
        self.assertAlmostEqual(latency_ms, 25.0)


class LatencyTrackerSampleFilterTests(unittest.TestCase):
    def test_rejects_non_positive_and_absurd_samples(self):
        tracker = LatencyTracker(proxied=True)
        tracker.record_send(1, ms(100))
        tracker.try_resolve({"id": 1}, ms(100))  # zero RTT -> rejected
        tracker.record_send(2, 0)
        tracker.try_resolve({"id": 2}, ms(31_000))  # >30 s -> rejected
        self.assertIsNone(tracker.estimate())
        tracker.record_tcp_rtt_us(0)  # rejected
        tracker_direct = LatencyTracker(proxied=False)
        tracker_direct.record_tcp_rtt_us(31_000_000)  # >30 s -> rejected
        self.assertIsNone(tracker_direct.estimate())

    def test_try_resolve_unknown_or_malformed_returns_false(self):
        tracker = LatencyTracker(proxied=False)
        self.assertFalse(tracker.try_resolve({"id": 99}, 0))
        self.assertFalse(tracker.try_resolve({"method": "mining.notify"}, 0))
        self.assertFalse(tracker.try_resolve("not-a-dict", 0))
        self.assertFalse(tracker.try_resolve({"id": None}, 0))

    def test_try_resolve_consumes_pending_id(self):
        tracker = LatencyTracker(proxied=False)
        tracker.record_send(5, 0)
        self.assertTrue(tracker.try_resolve({"id": 5}, ms(10)))
        self.assertFalse(tracker.try_resolve({"id": 5}, ms(20)))

    def test_prune_pending_drops_stale_entries(self):
        tracker = LatencyTracker(proxied=False)
        tracker.record_send(1, 0)
        tracker.record_send(2, ms(500))
        tracker.prune_pending(now_monotonic_ns=ms(1_000), max_age_ns=ms(600))
        self.assertFalse(tracker.try_resolve({"id": 1}, ms(1_001)))
        self.assertTrue(tracker.try_resolve({"id": 2}, ms(1_001)))

    def test_reset_clears_all_state(self):
        tracker = LatencyTracker(proxied=False)
        tracker.record_tcp_rtt_us(10_000)
        tracker.record_send(1, 0)
        tracker.try_resolve({"id": 1}, ms(10))
        tracker.reset()
        self.assertIsNone(tracker.estimate())
        self.assertFalse(tracker.try_resolve({"id": 1}, ms(20)))


class ParseTcpInfoTests(unittest.TestCase):
    def _tcp_info_bytes(self, rtt_us):
        # struct tcp_info layout: 8 unsigned chars then unsigned ints;
        # tcpi_rtt is the 16th u32 (index 15 of the int block).
        ints = [0] * 24
        ints[15] = rtt_us
        return struct.pack("B" * 8 + "I" * 24, *([0] * 8), *ints)

    def test_parses_rtt_from_buffer(self):
        self.assertEqual(parse_tcp_info_rtt_us(self._tcp_info_bytes(12_345)), 12_345)

    def test_short_buffer_returns_none(self):
        self.assertIsNone(parse_tcp_info_rtt_us(b"\x00" * 10))

    def test_sample_via_socket_mock(self):
        from collector.latency import sample_tcp_rtt_us
        sock = Mock()
        sock.getsockopt.return_value = self._tcp_info_bytes(2_500)
        with patch.object(socket, "TCP_INFO", 11, create=True):
            self.assertEqual(sample_tcp_rtt_us(sock), 2_500)

    def test_sample_handles_getsockopt_failure(self):
        from collector.latency import sample_tcp_rtt_us
        sock = Mock()
        sock.getsockopt.side_effect = OSError("not supported")
        with patch.object(socket, "TCP_INFO", 11, create=True):
            self.assertIsNone(sample_tcp_rtt_us(sock))


if __name__ == "__main__":
    unittest.main()
