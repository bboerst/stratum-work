"""#135: pool-definition changes re-identify pools from stored data (no RPC), one pass at a time; pruned blocks
fail fast instead of being retried."""
import pathlib
import sys
import unittest
from contextlib import contextmanager
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tests"))
from test_btc_template_filtering import import_main_module  # noqa: E402


class FakeStore:
    enabled = True

    def __init__(self, blocks):
        self.blocks, self.updates = blocks, []

    def blocks_for_reidentify(self):
        return iter(self.blocks)

    def update_block_pool(self, block_hash, mining_pool, pool_identification, analysis_is_object=True):
        self.updates.append((block_hash, mining_pool, pool_identification, analysis_is_object))


def block(h, pool, addresses=("bc1qpool",), method="address"):
    pi = None if addresses is None else {"mining_pool": pool, "method": method, "addresses_considered": list(addresses)}
    return {"block_hash": f"{h:064x}", "height": h, "coinbase_script_sig": "03aabbcc", "mining_pool": pool,
            "pool_identification": pi, "analysis_is_object": True}


POOL_A = {"id": 1, "name": "A", "match_type": "address", "identification_method": "address"}
POOL_B = {"id": 2, "name": "B", "match_type": "address", "identification_method": "address"}


class ReidentifyTests(unittest.TestCase):
    def setUp(self):
        self.main, _ = import_main_module()
        self.main.pools_cache = {"1": {"name": "A"}}
        def no_rpc(*a, **k):
            raise AssertionError("re-identification must not call RPC")
        self.main.retry_rpc = no_rpc

    def test_changed_pool_is_updated_without_rpc(self):
        self.main.identify_pool_from_data = lambda pools, script, addrs: dict(POOL_B)
        store = self.main.store = FakeStore([block(10, POOL_A)])
        stats = self.main.reidentify_pools()
        self.assertEqual(stats["changed"], 1)
        h, mp, pi, _ = store.updates[0]
        self.assertEqual(mp, POOL_B)
        self.assertEqual(pi, {"mining_pool": POOL_B, "method": "address", "addresses_considered": ["bc1qpool"]})

    def test_unchanged_pool_is_not_written(self):
        self.main.identify_pool_from_data = lambda pools, script, addrs: dict(POOL_A)
        store = self.main.store = FakeStore([block(10, POOL_A)])
        self.assertEqual(self.main.reidentify_pools()["changed"], 0)
        self.assertEqual(store.updates, [])

    def test_identification_uses_stored_script_and_addresses(self):
        seen = []
        self.main.identify_pool_from_data = lambda pools, script, addrs: seen.append((script, addrs)) or dict(POOL_A)
        self.main.store = FakeStore([block(10, POOL_A, addresses=["a1", "a2"])])
        self.main.reidentify_pools()
        self.assertEqual(seen, [("03aabbcc", ["a1", "a2"])])

    def test_no_match_becomes_unknown(self):
        self.main.identify_pool_from_data = lambda pools, script, addrs: {}
        store = self.main.store = FakeStore([block(10, POOL_A)])
        self.main.reidentify_pools()
        _, mp, pi, _ = store.updates[0]
        self.assertEqual(mp, {"name": "Unknown", "id": "unknown"})
        self.assertEqual(pi["method"], "none")

    def test_blocks_without_stored_addresses_are_left_alone(self):
        self.main.identify_pool_from_data = lambda pools, script, addrs: dict(POOL_B)
        store = self.main.store = FakeStore([block(10, POOL_A, addresses=None)])
        stats = self.main.reidentify_pools()
        self.assertEqual((stats["skipped_no_addresses"], store.updates), (1, []))

    def test_no_pool_definitions_means_no_pass(self):
        self.main.pools_cache = {}
        self.main.identify_pool_from_data = lambda *a: dict(POOL_B)
        store = self.main.store = FakeStore([block(10, POOL_A)])
        self.assertEqual(self.main.reidentify_pools()["checked"], 0)
        self.assertEqual(store.updates, [])

    def test_one_bad_block_does_not_stop_the_pass(self):
        def identify(pools, script, addrs):
            if addrs == ["bad"]:
                raise ValueError("boom")
            return dict(POOL_B)
        self.main.identify_pool_from_data = identify
        store = self.main.store = FakeStore([block(11, POOL_A, addresses=["bad"]), block(10, POOL_A)])
        stats = self.main.reidentify_pools()
        self.assertEqual((stats["errors"], stats["changed"], len(store.updates)), (1, 1, 1))


class SingleFlightTests(unittest.TestCase):
    def setUp(self):
        self.main, _ = import_main_module()
        self.spawned = []
        self.main._spawn = self.spawned.append      # capture instead of starting a thread

    def test_requests_during_a_pass_do_not_stack(self):
        runs = []
        def fake_pass():
            runs.append(1)
            if len(runs) == 1:                       # definitions change twice more mid-pass
                self.main.request_pool_reidentify()
                self.main.request_pool_reidentify()
        self.main.reidentify_pools = fake_pass
        self.main.request_pool_reidentify()
        self.main.request_pool_reidentify()          # while the first is pending: no second worker
        self.assertEqual(len(self.spawned), 1)
        self.spawned[0]()                            # run the worker
        self.assertEqual(len(runs), 2)               # one pass, plus exactly one more for the mid-pass changes
        self.assertEqual(len(self.spawned), 1)
        self.assertFalse(self.main._reindex_lock.locked())

    def test_full_reindex_does_not_start_while_a_pass_runs(self):
        self.main._reindex_lock.acquire()
        self.main.store = FakeStore([])
        self.main.store.block_hashes_by_height_desc = lambda: (_ for _ in ()).throw(AssertionError("must not run"))
        self.main.start_full_reindex_background()   # returns without touching the store
        self.main._reindex_lock.release()


class PrunedFastFailTests(unittest.TestCase):
    def setUp(self):
        self.main, _ = import_main_module()
        calls = self.calls = []

        class Pool:
            @contextmanager
            def get_connection(self):
                yield object()
            def recreate_pool(self, force=False):
                pass
        self.main.rpc_pool = Pool()
        no_sleep = mock.patch.object(self.main.time, "sleep", side_effect=AssertionError("must not back off on pruned"))
        no_sleep.start()
        self.addCleanup(no_sleep.stop)

        def getblock(conn, h):
            calls.append(h)
            raise Exception("-1: Block not available (pruned data)")
        self.getblock = getblock

    def test_pruned_is_raised_after_one_attempt(self):
        with self.assertRaises(self.main.PrunedBlockError):
            self.main.retry_rpc(self.getblock, "getblock(x)", "x")
        self.assertEqual(self.calls, ["x"])

    def test_reprocess_reports_pruned(self):
        self.main.get_block = self.getblock
        self.assertEqual(self.main.reprocess_block_full("ab" * 32), "pruned")
        self.assertEqual(len(self.calls), 1)


if __name__ == "__main__":
    unittest.main()
