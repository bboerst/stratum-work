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


# (block hash as explorers show it, the prev_hash a Stratum mining.notify carries for the next block). Public chain
# data: the Stratum form is the block header's prev-hash field with each 4-byte word byte-swapped, as pools send it.
PREV_HASH_VECTORS = [
    # Bitcoin 976051, and the prev_hash of a template for 976052
    ("00000000000000000001a8d326d8c59ccb89fde87a9fec130ac332c99c4ac17e",
     "9c4ac17e0ac332c97a9fec13cb89fde826d8c59c0001a8d30000000000000000"),
    # Bitcoin 99999 (pre-segwit; from block 100000's header)
    ("000000000002d01c1fccc21636b607dfd930d31d01c3a62104612a1719011250",
     "1901125004612a1701c3a621d930d31d36b607df1fccc2160002d01c00000000"),
    # Bitcoin genesis (from block 1's header)
    ("000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
     "0a8ce26f72b3f1b646a2a6c14ff763ae65831e939c085ae10019d66800000000"),
    # Bitcoin Cash 945963, and the prev_hash of a template for 945964
    ("000000000000000000fc282d25e41768e0f713e20fcddd208de1ca4140d9f208",
     "40d9f2088de1ca410fcddd20e0f713e225e4176800fc282d0000000000000000"),
    # Bitcoin Cash 945962 (from 945963's header)
    ("000000000000000000cd65f3dca7fb2bb3a909339a66bb3d7535c1dec40ddb41",
     "c40ddb417535c1de9a66bb3db3a90933dca7fb2b00cd65f30000000000000000"),
    # Synthetic: every word distinct and none zero, so any byte or word mix-up shows
    ("1c1d1e1f18191a1b14151617101112130c0d0e0f08090a0b0405060700010203",
     "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"),
]
PREV_BCH = PREV_HASH_VECTORS[3][1]
BLOCK_BCH = PREV_HASH_VECTORS[3][0]


class ChainDetectionTests(unittest.TestCase):
    def test_reverse_prev_hash_reverses_word_order_to_the_block_hash(self):
        for block_hash, prev_hash in PREV_HASH_VECTORS:
            with self.subTest(block_hash=block_hash):
                self.assertEqual(reverse_prev_hash(prev_hash), block_hash)
                self.assertEqual(reverse_prev_hash(prev_hash.upper()), block_hash)
                # Not the byte reversal (#192)
                self.assertNotEqual(bytes.fromhex(prev_hash)[::-1].hex(), block_hash)

    def test_reverse_prev_hash_rejects_anything_but_32_bytes(self):
        for bad in ("", "ab", "00" * 31, "00" * 33, "zz" * 32, "0" * 63):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                reverse_prev_hash(bad)

    def test_confirm_bch_asks_the_api_for_the_block_hash(self):
        confirmer = BCHConfirmer("https://example.invalid/block/", timeout_seconds=1.5, cache=BCHConfirmationCache())
        response = Mock()
        response.ok = True
        response.json.return_value = {"data": {BLOCK_BCH: {}}}

        with patch("collector.chain_detection.requests.get", return_value=response) as get_mock:
            self.assertTrue(confirmer.confirm_bch(PREV_BCH))
        get_mock.assert_called_once_with(f"https://example.invalid/block/{BLOCK_BCH}", timeout=1.5)

    def test_confirm_bch_is_false_for_an_empty_data_list(self):
        # The default API answers an unknown hash with 200 and "data": []
        confirmer = BCHConfirmer("https://example.invalid", timeout_seconds=1.5, cache=BCHConfirmationCache())
        response = Mock()
        response.ok = True
        response.json.return_value = {"data": []}

        with patch("collector.chain_detection.requests.get", return_value=response):
            self.assertFalse(confirmer.confirm_bch(PREV_BCH))

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
    def test_create_notification_document_calls_classifier_with_parsed_height_and_prev_hash(
        self, classify_mock
    ):
        classify_mock.return_value = None
        # coinbase1 with a 3-byte BIP34 push of 0x001234
        coinbase1 = "01000000" + "01" + "00" * 32 + "ffffffff" + "0a" + "03341200"
        data = {
            "params": [
                "job1",
                "22" * 32,
                coinbase1,
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
    def test_create_notification_document_omits_chain_family_when_height_parse_fails(
        self, classify_mock
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

    def test_fetch_local_btc_tip_height_https_uses_ca_verified_connection(self):
        args = Namespace(
            bitcoin_rpc_scheme="https",
            bitcoin_rpc_ca_file="/certs/ca.pem",
            bitcoin_rpc_user="rpcuser",
            bitcoin_rpc_password="rpcpass",
            bitcoin_rpc_host="10.0.0.5",
            bitcoin_rpc_port="8443",
            bitcoin_rpc_timeout=7.5,
        )
        proxy = types.SimpleNamespace(
            getblockcount=Mock(return_value=202),
            _AuthServiceProxy__conn=Mock(),
        )
        auth_proxy_cls = Mock(return_value=proxy)
        ssl_context = object()

        with patch.dict(
            sys.modules,
            {
                "bitcoinrpc": types.SimpleNamespace(),
                "bitcoinrpc.authproxy": types.SimpleNamespace(
                    AuthServiceProxy=auth_proxy_cls
                ),
            },
        ), patch.object(
            collector_main.ssl, "create_default_context", return_value=ssl_context
        ) as create_ctx, patch.object(
            collector_main.http.client, "HTTPSConnection"
        ) as https_conn_cls:
            height = collector_main.fetch_local_btc_tip_height(args)

        self.assertEqual(height, 202)
        create_ctx.assert_called_once_with(cafile="/certs/ca.pem")
        https_conn_cls.assert_called_once_with(
            "10.0.0.5", 8443, timeout=7.5, context=ssl_context
        )
        auth_proxy_cls.assert_called_once_with(
            "https://rpcuser:rpcpass@10.0.0.5:8443",
            timeout=7.5,
            connection=https_conn_cls.return_value,
        )

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
