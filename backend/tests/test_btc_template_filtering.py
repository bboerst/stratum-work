import importlib
import sys
import types
import unittest
from unittest import mock


def make_fake_postgres():
    module = types.ModuleType("integrations.postgres")
    module.template_queries = []

    def btc_templates_for_height(height):
        module.template_queries.append(height)
        return []

    module.btc_templates_for_height = btc_templates_for_height
    module.connect = lambda: None
    module.is_enabled = lambda: True
    return module


class FakeRPCConnection:
    def getblockcount(self):
        return 0


class FakeAuthServiceProxy:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs

    def getblockcount(self):
        return 0


def import_main_module():
    fake_postgres = make_fake_postgres()

    bitcoinrpc_module = types.ModuleType("bitcoinrpc")
    authproxy_module = types.ModuleType("bitcoinrpc.authproxy")
    authproxy_module.AuthServiceProxy = FakeAuthServiceProxy
    bitcoinrpc_module.authproxy = authproxy_module

    integrations_module = types.ModuleType("integrations")
    integrations_module.postgres = fake_postgres
    integrations_module.publish_to_rabbitmq = lambda *args, **kwargs: None
    integrations_module.rabbitmq_manager = types.SimpleNamespace(connection=None)
    integrations_module.__path__ = []

    rabbitmq_module = types.ModuleType("integrations.rabbitmq")
    rabbitmq_module.start_heartbeat_thread = lambda: None

    analytics_package = types.ModuleType("analytics")
    analytics_package.__path__ = []

    prev_hash_divergence_module = types.ModuleType("analytics.prev_hash_divergence")
    prev_hash_divergence_module.analyze_prev_hash_divergence = lambda templates, logger: None

    invalid_coinbase_module = types.ModuleType("analytics.invalid_coinbase_no_merkle")
    invalid_coinbase_module.analyze_invalid_coinbase_without_merkle = lambda templates, height, logger: None

    pool_identification_module = types.ModuleType("analytics.pool_identification")
    pool_identification_module.analyze_pool_identification = lambda *args, **kwargs: {}
    pool_identification_module.identify_pool_from_data = lambda *args, **kwargs: {}
    pool_identification_module.load_pools = lambda *args, **kwargs: None

    bitcoin_utils_module = types.ModuleType("bitcoin_utils")
    bitcoin_utils_module.extract_coinbase_data = lambda block: ("", [])

    zmq_module = types.ModuleType("zmq")
    zmq_module.Context = lambda: types.SimpleNamespace(socket=lambda *args, **kwargs: types.SimpleNamespace(
        setsockopt=lambda *a, **k: None,
        connect=lambda *a, **k: None,
        recv_multipart=lambda: [],
    ))
    zmq_module.SUB = 1
    zmq_module.SUBSCRIBE = 2

    sys.modules["bitcoinrpc"] = bitcoinrpc_module
    sys.modules["bitcoinrpc.authproxy"] = authproxy_module
    sys.modules["integrations"] = integrations_module
    sys.modules["integrations.postgres"] = fake_postgres
    sys.modules["integrations.rabbitmq"] = rabbitmq_module
    sys.modules["analytics"] = analytics_package
    sys.modules["analytics.prev_hash_divergence"] = prev_hash_divergence_module
    sys.modules["analytics.invalid_coinbase_no_merkle"] = invalid_coinbase_module
    sys.modules["analytics.pool_identification"] = pool_identification_module
    sys.modules["bitcoin_utils"] = bitcoin_utils_module
    sys.modules["zmq"] = zmq_module

    sys.modules.pop("main", None)
    return importlib.import_module("main"), fake_postgres


class BTCTemplateFilteringTests(unittest.TestCase):
    def test_run_block_analyses_queries_btc_only_templates(self):
        with mock.patch.dict(sys.modules):
            main, fake_postgres = import_main_module()

            main.run_block_analyses(123)

        self.assertEqual(fake_postgres.template_queries, [123])


if __name__ == "__main__":
    unittest.main()
