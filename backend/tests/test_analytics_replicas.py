"""Analytics on every collector's rows (templates_at_height returns all of them): copies received by several
collectors must not inflate results. Synthetic templates only."""
import logging
import pathlib
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from analytics import invalid_coinbase_no_merkle as icm  # noqa: E402
from analytics.prev_hash_divergence import analyze_prev_hash_divergence  # noqa: E402

LOG = logging.getLogger("test")
H = 900_000
SUBSIDY = icm.get_block_subsidy_sats(H)


def tpl(pool="PoolA", site="s1", replica="a", ntime="66000000", prev="11" * 32, branches=(), en1="00", **over):
    t = {"pool_name": pool, "height": H, "prev_hash": prev, "merkle_branches": list(branches), "version": "20000000",
         "nbits": "17034219", "ntime": ntime, "coinbase1": "01", "coinbase2": "02", "extranonce1": en1,
         "extranonce2_length": 8, "site": site, "replica": replica}
    t.update(over)
    return t


class InvalidCoinbaseTests(unittest.TestCase):
    def run_it(self, templates):
        # every template with no branches pays more than the subsidy
        with mock.patch.object(icm, "parse_tx_total_output_value_sats", return_value=SUBSIDY + 1):
            return icm.analyze_invalid_coinbase_without_merkle(templates, H, LOG)

    def pools(self, flag):
        out = {}
        for o in flag["details"]["offenders"]:
            out[o["pool_name"]] = out.get(o["pool_name"], 0) + 1
        return out

    def test_copy_from_another_collector_counts_once(self):
        flag = self.run_it([tpl(), tpl(replica="b", en1="ff"), tpl(site="s2", en1="ee")])
        self.assertEqual(self.pools(flag), {"PoolA": 1})

    def test_own_resends_still_count_and_pair_one_to_one(self):
        # a sends the same template twice, b once: two offending templates, as with one collector
        flag = self.run_it([tpl(), tpl(), tpl(replica="b")])
        self.assertEqual(self.pools(flag), {"PoolA": 2})

    def test_one_collector_unchanged(self):
        # MongoDB rows have no site/replica: every row counts, identical re-sends included, as before
        legacy = dict(site=None, replica=None)
        flag = self.run_it([tpl(**legacy), tpl(**legacy), tpl(ntime="66000001", **legacy)])
        self.assertEqual(self.pools(flag), {"PoolA": 3})

    def test_template_only_one_collector_received_is_analyzed(self):
        flag = self.run_it([tpl(branches=["aa" * 32]), tpl(replica="b", ntime="66000009")])
        self.assertEqual(self.pools(flag), {"PoolA": 1})   # the primary's template has branches; b's alone is flagged

    def test_per_connection_jobs_count_per_job(self):
        flag = self.run_it([tpl(ntime="1"), tpl(replica="b", ntime="2")])
        self.assertEqual(self.pools(flag), {"PoolA": 2})   # two different templates the pool sent

    def test_pools_are_separate(self):
        flag = self.run_it([tpl(), tpl(pool="PoolB")])
        self.assertEqual(self.pools(flag), {"PoolA": 1, "PoolB": 1})

    def test_nothing_offending(self):
        self.assertIsNone(self.run_it([tpl(branches=["aa" * 32]), tpl(replica="b", branches=["aa" * 32])]))


class PrevHashDivergenceTests(unittest.TestCase):
    def test_copies_do_not_change_the_groups(self):
        rows = [tpl(), tpl(replica="b"), tpl(pool="PoolB", prev="22" * 32), tpl(pool="PoolB", replica="b", prev="22" * 32)]
        flag = analyze_prev_hash_divergence(rows, LOG)
        groups = {g["prev_hash"]: g["pools"] for g in flag["details"]["groups"]}
        self.assertEqual(groups, {"11" * 32: ["PoolA"], "22" * 32: ["PoolB"]})

    def test_a_divergence_only_one_collector_saw_is_reported(self):
        flag = analyze_prev_hash_divergence([tpl(), tpl(replica="b", prev="33" * 32)], LOG)
        self.assertEqual(len(flag["details"]["groups"]), 2)


if __name__ == "__main__":
    unittest.main()
