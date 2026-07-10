import time
import types
import sys
import unittest
from unittest.mock import Mock

sys.modules.setdefault("pika", types.SimpleNamespace())
sys.modules.setdefault("socks", types.SimpleNamespace())
sys.modules.setdefault("pymongo", types.SimpleNamespace(MongoClient=Mock()))
sys.modules.setdefault("requests", types.SimpleNamespace(
    get=Mock(),
    RequestException=Exception,
    Response=object,
))
fake_network = types.SimpleNamespace(Tx=types.SimpleNamespace(from_hex=Mock()))
sys.modules.setdefault("pycoin", types.SimpleNamespace())
sys.modules.setdefault("pycoin.symbols", types.SimpleNamespace())
sys.modules.setdefault("pycoin.symbols.btc", types.SimpleNamespace(network=fake_network))

from collector.main import Watcher, create_notification_document

NOTIFY_PARAMS = [
    "job1",
    "00" * 32,
    "01",
    "02",
    [],
    "20000000",
    "1d00ffff",
    "665f3bde",
    True,
]


def make_watcher():
    return Watcher(
        "stratum+tcp://pool.example:3333",
        "user:pass",
        "test-pool",
        "localhost", 5672, None, None, "exchange",
        "localhost", "db", None, None,
        rabbitmq_enabled=False, db_enabled=False,
    )


class DocumentLatencyFieldsTests(unittest.TestCase):
    def test_document_includes_latency_when_estimated(self):
        doc = create_notification_document(
            {"params": NOTIFY_PARAMS}, "test-pool", "aa", 4, "17abc",
            latency=(12.5, "tcp"),
        )
        self.assertEqual(doc["lat_ms"], 12.5)
        self.assertEqual(doc["lat_m"], "tcp")
        self.assertNotIn("latency_ms", doc)
        self.assertNotIn("latency_method", doc)

    def test_document_omits_latency_when_unknown(self):
        doc = create_notification_document(
            {"params": NOTIFY_PARAMS}, "test-pool", "aa", 4, "17abc",
        )
        self.assertNotIn("lat_ms", doc)
        self.assertNotIn("lat_m", doc)


class WatcherLatencyWiringTests(unittest.TestCase):
    def test_watcher_tracker_matches_proxy_flag(self):
        self.assertFalse(make_watcher().latency_tracker.proxied)
        proxied_watcher = Watcher(
            "stratum+tcp://pool.example:3333", "user:pass", "test-pool",
            "localhost", 5672, None, None, "exchange",
            "localhost", "db", None, None,
            True, "localhost", 9050,  # use_proxy, proxy_host, proxy_port
            rabbitmq_enabled=False, db_enabled=False,
        )
        self.assertTrue(proxied_watcher.latency_tracker.proxied)

    def test_send_jsonrpc_records_send_and_resolves_response(self):
        watcher = make_watcher()
        watcher.sock = Mock()
        watcher.sock.getsockopt.return_value = b""  # short buffer -> TCP RTT sample skipped
        response = {"id": 1, "result": [[], "aa", 4], "error": None}

        def fake_get_msg():
            # get_msg stamps the receive time; make it later than the send
            watcher.last_recv_monotonic_ns = time.monotonic_ns() + 5_000_000
            return (response, 123)

        watcher.get_msg = fake_get_msg
        resp = watcher.send_jsonrpc("mining.subscribe", [])
        self.assertEqual(resp, response)
        # the request id was resolved into an app-RTT sample
        self.assertIsNotNone(watcher.latency_tracker.estimate())

    def test_send_jsonrpc_resolves_probe_responses_instead_of_queueing(self):
        watcher = make_watcher()
        watcher.sock = Mock()
        watcher.sock.getsockopt.return_value = b""  # short buffer -> TCP RTT sample skipped
        watcher.latency_tracker.record_send(99, 0)
        probe_response = {"id": 99, "result": [[], "aa", 4], "error": None}
        wanted = {"id": 1, "result": True, "error": None}
        replies = [(probe_response, 1), (wanted, 2)]

        def fake_get_msg():
            watcher.last_recv_monotonic_ns = time.monotonic_ns() + 5_000_000
            return replies.pop(0)

        watcher.get_msg = fake_get_msg
        resp = watcher.send_jsonrpc("mining.authorize", ["u", "p"])
        self.assertEqual(resp, wanted)
        self.assertEqual(watcher.pending_notifications, [])


if __name__ == "__main__":
    unittest.main()
