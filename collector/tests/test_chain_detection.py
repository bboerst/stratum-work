import unittest
import types
import sys
from argparse import Namespace
from unittest.mock import Mock, patch

import requests

from collector.chain_detection import (
    BCHConfirmationCache,
    BCHConfirmer,
    ChainClassifier,
    TipState,
    reverse_prev_hash,
)

sys.modules.setdefault("pika", types.SimpleNamespace())
sys.modules.setdefault("socks", types.SimpleNamespace())
sys.modules.setdefault("pymongo", types.SimpleNamespace(MongoClient=Mock()))
fake_network = types.SimpleNamespace(Tx=types.SimpleNamespace(from_hex=Mock()))
sys.modules.setdefault("pycoin", types.SimpleNamespace())
sys.modules.setdefault("pycoin.symbols", types.SimpleNamespace())
sys.modules.setdefault("pycoin.symbols.btc", types.SimpleNamespace(network=fake_network))

import collector.main as collector_main
from collector.main import create_notification_document


class ChainDetectionTests(unittest.TestCase):
    def test_reverse_prev_hash_converts_stratum_little_endian_to_rpc_big_endian(self):
        self.assertEqual(
            reverse_prev_hash(
                "40d9f2088de1ca410fcddd20e0f713e225e4176800fc282d0000000000000000"
            ),
            "00000000000000002d28fc006817e425e213f7e020ddcd0f41cae18d08f2d940",
        )

    def test_classifier_skips_detection_when_tip_state_is_unavailable(self):
        classifier = ChainClassifier(
            tip_state=TipState(
                current_height=None,
                last_update_monotonic=None,
                stale_after_seconds=60,
            ),
            divergence_threshold=5,
            confirmer=Mock(spec=BCHConfirmer),
            monotonic_now=lambda: 120.0,
        )

        self.assertIsNone(classifier.classify(height=945964, prev_hash="00" * 32))
        classifier.confirmer.confirm_bch.assert_not_called()

    def test_classifier_skips_detection_inside_height_window(self):
        classifier = ChainClassifier(
            tip_state=TipState(
                current_height=945964,
                last_update_monotonic=100.0,
                stale_after_seconds=60,
            ),
            divergence_threshold=5,
            confirmer=Mock(spec=BCHConfirmer),
            monotonic_now=lambda: 120.0,
        )

        self.assertIsNone(classifier.classify(height=945960, prev_hash="00" * 32))
        classifier.confirmer.confirm_bch.assert_not_called()

    def test_classifier_marks_confirmed_bch_when_height_diverges_and_api_confirms(self):
        confirmer = Mock(spec=BCHConfirmer)
        confirmer.confirm_bch.return_value = True
        classifier = ChainClassifier(
            tip_state=TipState(
                current_height=945964,
                last_update_monotonic=100.0,
                stale_after_seconds=60,
            ),
            divergence_threshold=5,
            confirmer=confirmer,
            monotonic_now=lambda: 120.0,
        )

        result = classifier.classify(
            height=945900,
            prev_hash="40d9f2088de1ca410fcddd20e0f713e225e4176800fc282d0000000000000000",
        )

        self.assertEqual(result, "bch")
        confirmer.confirm_bch.assert_called_once_with(
            "40d9f2088de1ca410fcddd20e0f713e225e4176800fc282d0000000000000000"
        )

    def test_classifier_marks_divergent_non_bch_as_unknown(self):
        confirmer = Mock(spec=BCHConfirmer)
        confirmer.confirm_bch.return_value = False
        classifier = ChainClassifier(
            tip_state=TipState(
                current_height=945964,
                last_update_monotonic=100.0,
                stale_after_seconds=60,
            ),
            divergence_threshold=5,
            confirmer=confirmer,
            monotonic_now=lambda: 120.0,
        )

        result = classifier.classify(
            height=6560463,
            prev_hash="58dcd5b64e522d28de60983366c6788b1a74584a69845173d6faa16b2718c906",
        )

        self.assertEqual(result, "unknown")
        confirmer.confirm_bch.assert_called_once_with(
            "58dcd5b64e522d28de60983366c6788b1a74584a69845173d6faa16b2718c906"
        )

    def test_one_entry_cache_reuses_last_confirmed_prev_hash(self):
        cache = BCHConfirmationCache()
        confirmer = BCHConfirmer("https://example.invalid", timeout_seconds=1.5, cache=cache)
        prev_hash = "40d9f2088de1ca410fcddd20e0f713e225e4176800fc282d0000000000000000"

        response = Mock()
        response.ok = True
        response.json.return_value = {"data": {"chain": "bch"}}

        with patch("collector.chain_detection.requests.get", return_value=response) as get_mock:
            self.assertTrue(confirmer.confirm_bch(prev_hash))
            self.assertTrue(confirmer.confirm_bch(prev_hash))
            self.assertEqual(get_mock.call_count, 1)
            self.assertEqual(cache.lookup(prev_hash), True)
            self.assertIsNone(cache.lookup("def"))

    def test_confirm_bch_returns_false_when_request_raises(self):
        cache = BCHConfirmationCache()
        confirmer = BCHConfirmer("https://example.invalid", timeout_seconds=1.5, cache=cache)

        with patch(
            "collector.chain_detection.requests.get",
            side_effect=requests.RequestException("boom"),
        ):
            self.assertFalse(
                confirmer.confirm_bch(
                    "40d9f2088de1ca410fcddd20e0f713e225e4176800fc282d0000000000000000"
                )
            )

    def test_confirm_bch_returns_false_when_response_is_not_json(self):
        cache = BCHConfirmationCache()
        confirmer = BCHConfirmer("https://example.invalid", timeout_seconds=1.5, cache=cache)

        response = Mock()
        response.ok = True
        response.json.side_effect = ValueError("not json")

        with patch("collector.chain_detection.requests.get", return_value=response):
            self.assertFalse(
                confirmer.confirm_bch(
                    "40d9f2088de1ca410fcddd20e0f713e225e4176800fc282d0000000000000000"
                )
            )

    def test_confirm_bch_returns_false_when_data_payload_is_null(self):
        cache = BCHConfirmationCache()
        confirmer = BCHConfirmer("https://example.invalid", timeout_seconds=1.5, cache=cache)

        response = Mock()
        response.ok = True
        response.json.return_value = {"data": None}

        with patch("collector.chain_detection.requests.get", return_value=response):
            self.assertFalse(
                confirmer.confirm_bch(
                    "40d9f2088de1ca410fcddd20e0f713e225e4176800fc282d0000000000000000"
                )
            )


class NotificationDocumentTests(unittest.TestCase):
    @patch("collector.main.classify_notification_chain")
    @patch("collector.main.network.Tx.from_hex")
    def test_create_notification_document_calls_classifier_with_parsed_height_and_prev_hash(
        self, from_hex_mock, classify_mock
    ):
        classify_mock.return_value = None
        tx = Mock()
        tx.txs_in = [Mock(script=b"\x03\x34\x12\x00")]
        from_hex_mock.return_value = tx
        data = {
            "params": [
                "job1",
                "22" * 32,
                "coinbase1",
                "coinbase2",
                [],
                "20000000",
                "18014bb3",
                "69d72a43",
                True,
            ]
        }

        doc = create_notification_document(data, "Braiins", "abcd", 2, "deadbeef")

        self.assertEqual(doc["height"], 0x1234)
        classify_mock.assert_called_once_with(0x1234, "22" * 32)

    @patch("collector.main.classify_notification_chain")
    def test_create_notification_document_omits_chain_family_for_btc_default(
        self, classify_mock
    ):
        classify_mock.return_value = None
        data = {
            "params": [
                "job1",
                "00" * 32,
                "coinbase1",
                "coinbase2",
                [],
                "20000000",
                "18014bb3",
                "69d72a43",
                True,
            ]
        }

        doc = create_notification_document(data, "Braiins", "", 6, "deadbeef")

        self.assertNotIn("chain_family", doc)

    @patch("collector.main.classify_notification_chain")
    @patch("collector.main.network.Tx.from_hex", side_effect=ValueError("bad coinbase"))
    def test_create_notification_document_omits_chain_family_when_height_parse_fails(
        self, from_hex_mock, classify_mock
    ):
        classify_mock.return_value = None
        data = {
            "params": [
                "job1",
                "33" * 32,
                "coinbase1",
                "coinbase2",
                [],
                "20000000",
                "18014bb3",
                "69d72a43",
                True,
            ]
        }

        doc = create_notification_document(data, "Braiins", "", 6, "deadbeef")

        self.assertEqual(doc["height"], 0)
        self.assertNotIn("chain_family", doc)
        classify_mock.assert_called_once_with(0, "33" * 32)
        from_hex_mock.assert_called_once()

    @patch("collector.main.classify_notification_chain")
    def test_create_notification_document_sets_chain_family_for_confirmed_bch(
        self, classify_mock
    ):
        classify_mock.return_value = "bch"
        data = {
            "params": [
                "job1",
                "11" * 32,
                "coinbase1",
                "coinbase2",
                [],
                "20000000",
                "18014bb3",
                "69d72a43",
                True,
            ]
        }

        doc = create_notification_document(data, "Braiins", "", 6, "deadbeef")

        self.assertEqual(doc["chain_family"], "bch")

    @patch("collector.main.classify_notification_chain")
    def test_create_notification_document_sets_chain_family_for_unknown_non_btc(
        self, classify_mock
    ):
        classify_mock.return_value = "unknown"
        data = {
            "params": [
                "job1",
                "58dcd5b64e522d28de60983366c6788b1a74584a69845173d6faa16b2718c906",
                "coinbase1",
                "coinbase2",
                [],
                "20000000",
                "18014bb3",
                "69d72a43",
                True,
            ]
        }

        doc = create_notification_document(data, "Headframe", "", 6, "deadbeef")

        self.assertEqual(doc["chain_family"], "unknown")


class RuntimeConfigTests(unittest.TestCase):
    def test_configure_chain_detection_applies_cli_bitcoin_config(self):
        original = {
            "tip_state_stale_after": collector_main.tip_state.stale_after_seconds,
            "classifier_threshold": collector_main.chain_classifier.divergence_threshold,
            "confirmer_url": collector_main.bch_confirmer.api_base_url,
            "confirmer_timeout": collector_main.bch_confirmer.timeout_seconds,
        }
        try:
            collector_main.configure_chain_detection(
                Namespace(
                    bitcoin_zmq_block="tcp://btc-node:29000",
                    bitcoin_rpc_user="rpcuser",
                    bitcoin_rpc_password="rpcpass",
                    bitcoin_rpc_host="btc-node",
                    bitcoin_rpc_port="18443",
                    bitcoin_rpc_timeout=7.5,
                    btc_chain_divergence_threshold=12,
                    btc_tip_stale_seconds=90,
                    bch_confirmation_url="https://example.invalid/bch",
                    bch_confirmation_timeout=4.25,
                )
            )

            self.assertEqual(collector_main.tip_state.stale_after_seconds, 90)
            self.assertEqual(collector_main.chain_classifier.divergence_threshold, 12)
            self.assertEqual(collector_main.bch_confirmer.api_base_url, "https://example.invalid/bch")
            self.assertEqual(collector_main.bch_confirmer.timeout_seconds, 4.25)
        finally:
            collector_main.tip_state.stale_after_seconds = original["tip_state_stale_after"]
            collector_main.chain_classifier.divergence_threshold = original["classifier_threshold"]
            collector_main.bch_confirmer.api_base_url = original["confirmer_url"]
            collector_main.bch_confirmer.timeout_seconds = original["confirmer_timeout"]


class TipListenerTests(unittest.TestCase):
    def test_fetch_local_btc_tip_height_closes_underlying_rpc_connection(self):
        args = Namespace(
            bitcoin_rpc_user="rpcuser",
            bitcoin_rpc_password="rpcpass",
            bitcoin_rpc_host="btc-node",
            bitcoin_rpc_port="18443",
            bitcoin_rpc_timeout=7.5,
        )
        http_conn = Mock()
        proxy = types.SimpleNamespace(
            getblockcount=Mock(return_value=101),
            _AuthServiceProxy__conn=http_conn,
        )
        auth_proxy_cls = Mock(return_value=proxy)

        with patch.dict(
            sys.modules,
            {
                "bitcoinrpc": types.SimpleNamespace(),
                "bitcoinrpc.authproxy": types.SimpleNamespace(
                    AuthServiceProxy=auth_proxy_cls
                ),
            },
        ):
            height = collector_main.fetch_local_btc_tip_height(args)

        self.assertEqual(height, 101)
        auth_proxy_cls.assert_called_once_with(
            "http://rpcuser:rpcpass@btc-node:18443",
            timeout=7.5,
        )
        proxy.getblockcount.assert_called_once_with()
        http_conn.close.assert_called_once_with()

    def test_close_rpc_connection_uses_underlying_http_connection_not_rpc_method(self):
        http_conn = Mock()

        class FakeProxy:
            def __init__(self):
                self._AuthServiceProxy__conn = http_conn

            def close(self):
                raise AssertionError("RPC close() method should not be invoked")

        collector_main.close_rpc_connection(FakeProxy())

        http_conn.close.assert_called_once_with()


class MongoClientReuseTests(unittest.TestCase):
    def setUp(self):
        collector_main.cached_mongo_client = None
        collector_main.cached_mongo_collection = None
        collector_main.cached_mongo_config = None

    def tearDown(self):
        collector_main.cached_mongo_client = None
        collector_main.cached_mongo_collection = None
        collector_main.cached_mongo_config = None

    @patch("collector.main.MongoClient")
    def test_get_mongo_collection_reuses_cached_client_for_same_config(
        self, mongo_client_cls
    ):
        client = Mock()
        database = Mock()
        collection = Mock()
        mongo_client_cls.return_value = client
        client.__getitem__ = Mock(return_value=database)
        database.__getitem__ = Mock(return_value=collection)

        first = collector_main.get_mongo_collection(
            "mongodb://mongo:27017",
            "stratum-logger",
            "user",
            "pass",
        )
        second = collector_main.get_mongo_collection(
            "mongodb://mongo:27017",
            "stratum-logger",
            "user",
            "pass",
        )

        self.assertIs(first, collection)
        self.assertIs(second, collection)
        mongo_client_cls.assert_called_once_with("mongodb://user:pass@mongo:27017")

    @patch("collector.main.MongoClient")
    def test_close_cached_mongo_client_closes_shared_client(self, mongo_client_cls):
        client = Mock()
        database = Mock()
        collection = Mock()
        mongo_client_cls.return_value = client
        client.__getitem__ = Mock(return_value=database)
        database.__getitem__ = Mock(return_value=collection)

        collector_main.get_mongo_collection(
            "mongodb://mongo:27017",
            "stratum-logger",
            "user",
            "pass",
        )
        collector_main.close_cached_mongo_client()

        client.close.assert_called_once_with()
        self.assertIsNone(collector_main.cached_mongo_client)
        self.assertIsNone(collector_main.cached_mongo_collection)
        self.assertIsNone(collector_main.cached_mongo_config)


if __name__ == "__main__":
    unittest.main()
