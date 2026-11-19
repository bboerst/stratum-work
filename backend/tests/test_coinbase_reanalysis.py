"""coinbase_reanalysis: per height, the analyzer's result replaces only the coinbase keys of every block row there."""
import logging
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import coinbase_reanalysis as cr  # noqa: E402
from tests.test_invalid_coinbase import SUBSIDY, P2SH, H, output, split_coinbase, tpl  # noqa: E402



class FakeStore:
    """blocks: {hash: (height, analysis)}; templates: {height: [template]}. Applies update_coinbase_analysis the way
    the Postgres store does (only the flag and coinbase_parse change)."""

    def __init__(self, blocks, templates):
        self.blocks, self.templates, self.writes = blocks, templates, 0

    def templates_at_height(self, height):
        return self.templates.get(height, [])

    def block_height_range(self):
        hs = [h for h, _ in self.blocks.values()]
        return (min(hs), max(hs)) if hs else (None, None)

    def block_heights_between(self, low, high_exclusive):
        return {h for h, _ in self.blocks.values() if low <= h < high_exclusive}

    def update_coinbase_analysis(self, height, flag, report, dry_run=False):
        changed = []
        for bh, (h, old) in sorted(self.blocks.items()):
            if h != height:
                continue
            new = {k: v for k, v in old.items() if k not in ("flags", "coinbase_parse")}
            before = next((f for f in old.get("flags", []) if f.get("key") == "invalid_coinbase_no_merkle"), None)
            flags = [f for f in old.get("flags", []) if f.get("key") != "invalid_coinbase_no_merkle"] + ([flag] if flag else [])
            if flags:
                new["flags"] = flags
            if report:
                new["coinbase_parse"] = report
            if new != old:
                changed.append({"block_hash": bh, "before_flag": before, "after_flag": flag})
                if not dry_run:
                    self.blocks[bh] = (h, new)
                    self.writes += 1
        return changed


FORK = {"key": "prev_hash_fork", "icon": "fork", "details": {}}
STALE_FLAG = {"key": "invalid_coinbase_no_merkle", "icon": "error",
              "details": {"offenders": [{"pool_name": "Gone", "total_sats": 1, "subsidy_sats": 0}]}}


class ReanalysisTests(unittest.TestCase):
    def setUp(self):
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        bad = split_coinbase([output(546, P2SH), output(SUBSIDY + 1_000_000, P2SH)], declared_extra=4)
        ok = split_coinbase([output(SUBSIDY, P2SH)])
        self.store = FakeStore(
            blocks={"aa": (H, {"pool_identification": {"x": 1}, "flags": [FORK]}),   # gains the missed flag
                    "ab": (H, {}),                                                  # a stale block at the same height
                    "bb": (H + 1, {"flags": [FORK, STALE_FLAG]}),                   # its old flag no longer holds
                    "cc": (H + 2, {"pool_identification": {"y": 2}})},              # nothing to change
            templates={H: [tpl(bad)], H + 1: [tpl(ok)], H + 2: [tpl(ok)]})

    def test_updates_only_the_coinbase_keys_and_reports(self):
        out = cr.main(["--from", str(H), "--to", str(H + 2)], store=self.store)
        self.assertEqual(out, 0)
        aa = self.store.blocks["aa"][1]
        self.assertEqual(aa["pool_identification"], {"x": 1})
        self.assertEqual([f["key"] for f in aa["flags"]], ["prev_hash_fork", "invalid_coinbase_no_merkle"])
        self.assertEqual(aa["coinbase_parse"]["repaired"][0]["extranonce2_length"], 8)
        self.assertIn("invalid_coinbase_no_merkle", [f["key"] for f in self.store.blocks["ab"][1]["flags"]])
        self.assertEqual(self.store.blocks["bb"][1], {"flags": [FORK]})
        self.assertEqual(self.store.blocks["cc"][1], {"pool_identification": {"y": 2}})
        self.assertEqual(self.store.writes, 3)

    def test_summary_and_idempotence(self):
        s = cr.reanalyze(self.store, [H, H + 1, H + 2])
        self.assertEqual((s["heights"], s["blocks_changed"]), (3, 3))
        self.assertEqual([a["block_hash"] for a in s["flags_added"]], ["aa", "ab"])
        self.assertEqual(s["flags_removed"], [{"height": H + 1, "block_hash": "bb", "pools": ["Gone"]}])
        self.assertEqual(s["repaired_templates"], {"PoolA": 1})
        self.assertEqual(cr.reanalyze(self.store, [H, H + 1, H + 2])["blocks_changed"], 0)

    def test_dry_run_writes_nothing(self):
        s = cr.reanalyze(self.store, [H, H + 1, H + 2], dry_run=True)
        self.assertEqual((s["blocks_changed"], self.store.writes), (3, 0))


if __name__ == "__main__":
    unittest.main()
