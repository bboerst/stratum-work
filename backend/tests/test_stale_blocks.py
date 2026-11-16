"""#180 slice 3: stale blocks from getchaintips, against a simulated node (block tree) and an in-memory store."""
import pathlib
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from stale_blocks import StaleBlockTracker, block_unavailable, coinbase_outputs  # noqa: E402

NOW = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)


def bhash(name):
    return name.encode().hex().ljust(64, "0")


class FakeNode:
    """A block tree. active = list of hashes (index = height - base). Blocks have full data unless headers_only."""

    def __init__(self, base=1000, length=5):
        self.blocks, self.calls = {}, []
        self.active = []
        prev = None
        for i in range(length):
            prev = self.add(f"a{i}", prev, base + i)
            self.active.append(prev)
        self.base = base
        self.invalid = set()

    def add(self, name, prev, height=None, headers_only=False, time=None):
        h = bhash(name)
        if height is None:
            height = self.blocks[prev]["height"] + 1
        self.blocks[h] = {"hash": h, "height": height, "prev": prev, "headers_only": headers_only,
                          "time": time or int(NOW.timestamp()) - 600}
        return h

    def reorg_to(self, tip):
        chain = []
        h = tip
        while h is not None:
            chain.append(h)
            h = self.blocks[h]["prev"]
        self.active = list(reversed(chain))

    def __call__(self, method, *args):
        self.calls.append((method,) + args)
        return getattr(self, "rpc_" + method)(*args)

    def rpc_getchaintips(self):
        children = {b["prev"] for b in self.blocks.values()}
        active = set(self.active)
        tips = []
        for h, b in self.blocks.items():
            if h in children and h != self.active[-1]:   # Core always lists the active tip
                continue
            if h == self.active[-1]:
                tips.append({"height": b["height"], "hash": h, "branchlen": 0, "status": "active"})
                continue
            n, x = 0, h
            while x not in active:
                n, x = n + 1, self.blocks[x]["prev"]
            status = "invalid" if h in self.invalid else "headers-only" if b["headers_only"] else "valid-fork"
            tips.append({"height": b["height"], "hash": h, "branchlen": n, "status": status})
        return tips

    def rpc_getblockhash(self, height):
        return self.active[height - self.base]

    def rpc_getblockheader(self, h):
        b = self.blocks[h]
        out = {"hash": h, "height": b["height"], "version": 0x20000000, "time": b["time"], "bits": "207fffff",
               "nonce": 7, "merkleroot": "11" * 32}
        if b["prev"]:
            out["previousblockhash"] = b["prev"]
        return out

    def rpc_getblock(self, h, verbosity):
        b = self.blocks[h]
        if b["headers_only"]:
            raise Exception("Block not available (not fully downloaded)")
        return {"hash": h, "height": b["height"], "size": 300, "weight": 1200, "nTx": 1,
                "tx": [{"vin": [{"coinbase": "03aabbcc2f746573742f"}],
                        "vout": [{"value": 3.125, "scriptPubKey": {"hex": "0014" + "22" * 20, "address": "bcrt1qsynthetic"}},
                                 {"value": 0, "scriptPubKey": {"hex": "6a24aa21a9ed" + "33" * 32}}]}]}


class FakeStore:
    supports_stale_blocks = True

    def __init__(self, active_blocks=()):
        self.blocks = set(active_blocks)   # what the backend stored as tips (blocks table)
        self.stale, self.reorgs = {}, []

    def stale_block_states(self, hashes):
        return {h: {k: self.stale[h][k] for k in ("last_status", "full_block", "reorged_in_at")}
                for h in hashes if h in self.stale}

    def known_block_hashes(self, hashes):
        return {h for h in hashes if h in self.blocks}

    def current_stale_blocks(self, min_height):
        return [{"block_hash": h, "height": r["height"]} for h, r in self.stale.items()
                if r["height"] >= min_height and r["reorged_in_at"] is None]

    def mark_stale_block_reactivated(self, h):
        self.stale[h].update(reorged_in_at=NOW, last_status="active")

    def save_stale_branch(self, rows, reorg=None):
        reorg_id = None
        if reorg:
            self.reorgs.append(reorg)
            reorg_id = len(self.reorgs)
        for r in rows:
            old = self.stale.get(r["block_hash"])
            new = dict(r, last_status=r["status"], reorged_in_at=None,
                       reorg_id=reorg_id if r["was_active"] and r["newly_stale"] else None)
            if old:   # same merge rules as the SQL upsert
                new["chaintip_status"], new["first_seen"] = old["chaintip_status"], old["first_seen"]
                new["full_block"] = old["full_block"] or r["full_block"]
                new["reorg_id"] = new["reorg_id"] or old["reorg_id"]
                new["was_active"] = old["was_active"] or r["was_active"]
                for k in ("coinbase_script_sig", "mining_pool"):
                    new[k] = old.get(k) or r.get(k)
            else:
                new["chaintip_status"] = r["status"]
            self.stale[r["block_hash"]] = new
        return reorg_id


def tracker(node, store, **kw):
    reorgs = []
    t = StaleBlockTracker(node, store, identify_pool=lambda s, a: {"id": 9, "name": "Synthetic", "seen": a},
                          on_reorg=lambda *a: reorgs.append(a), now=lambda: NOW, **kw)
    t.reorg_calls = reorgs
    return t


class ParsingTests(unittest.TestCase):
    def test_block_unavailable(self):
        self.assertTrue(block_unavailable(Exception("Block not available (not fully downloaded)")))
        self.assertTrue(block_unavailable(Exception("Block not available (pruned data)")))
        self.assertTrue(block_unavailable(Exception("Block not found on disk")))
        self.assertFalse(block_unavailable(Exception("Connection refused")))

    def test_coinbase_outputs_in_sats(self):
        node = FakeNode()
        outs = coinbase_outputs(node.rpc_getblock(node.active[0], 2))
        self.assertEqual(outs[0], {"value_sat": 312_500_000, "script_pubkey": "0014" + "22" * 20, "address": "bcrt1qsynthetic"})
        self.assertEqual(outs[1]["value_sat"], 0)
        self.assertIsNone(outs[1]["address"])

    def test_only_active_tip_nothing_recorded(self):
        node, store = FakeNode(), FakeStore()
        stats = tracker(node, store).poll()
        self.assertEqual(stats["tips"], 0)
        self.assertEqual(store.stale, {})
        self.assertEqual([c[0] for c in node.calls], ["getchaintips"])

    def test_no_active_tip(self):
        t = tracker(lambda m, *a: [{"height": 1, "hash": "00", "branchlen": 1, "status": "valid-fork"}], FakeStore())
        self.assertEqual(t.poll()["branches_recorded"], 0)


class BranchTests(unittest.TestCase):
    def test_one_block_fork_full_data_and_pool(self):
        node, store = FakeNode(), FakeStore(FakeNode().active)
        s = node.add("s4", node.active[3])                      # competes with a4 at the tip height
        stats = tracker(node, store).poll()
        self.assertEqual((stats["branches_recorded"], stats["blocks_recorded"], stats["full_blocks"]), (1, 1, 1))
        row = store.stale[s]
        self.assertEqual((row["height"], row["fork_height"], row["chaintip_status"]), (1004, 1003, "valid-fork"))
        self.assertEqual(row["prev_hash"], node.active[3])
        self.assertEqual((row["bits"], row["nonce"], row["version"]), (0x207fffff, 7, 0x20000000))
        self.assertTrue(row["full_block"])
        self.assertEqual(row["coinbase_script_sig"], "03aabbcc2f746573742f")
        self.assertEqual((row["tx_count"], row["size"], row["weight"]), (1, 300, 1200))
        self.assertEqual(row["mining_pool"]["name"], "Synthetic")
        self.assertEqual(row["mining_pool"]["seen"], ["bcrt1qsynthetic"])   # coinbase addresses reach identification
        self.assertFalse(row["was_active"])
        self.assertEqual(store.reorgs, [])

    def test_walk_to_fork_point(self):
        node, store = FakeNode(), FakeStore(FakeNode().active)
        x = node.add("s2", node.active[1])
        x = node.add("s3", x)
        tip = node.add("s4", x)
        tracker(node, store).poll()
        self.assertEqual(sorted(r["height"] for r in store.stale.values()), [1002, 1003, 1004])
        self.assertTrue(all(r["fork_height"] == 1001 and r["tip_hash"] == tip for r in store.stale.values()))
        # headers walked tip-first, and nothing below the fork point
        headers = [c[1] for c in node.calls if c[0] == "getblockheader"]
        self.assertEqual(headers, [tip, x, bhash("s2")])

    def test_header_only(self):
        node, store = FakeNode(), FakeStore()
        s = node.add("h4", node.active[3], headers_only=True)
        stats = tracker(node, store).poll()
        self.assertEqual((stats["blocks_recorded"], stats["full_blocks"]), (1, 0))
        row = store.stale[s]
        self.assertEqual(row["chaintip_status"], "headers-only")
        self.assertFalse(row["full_block"])
        self.assertIsNone(row.get("coinbase_script_sig"))

    def test_header_only_upgraded_when_block_arrives(self):
        node, store = FakeNode(), FakeStore()
        s = node.add("h4", node.active[3], headers_only=True)
        t = tracker(node, store)
        t.poll()
        node.blocks[s]["headers_only"] = False                  # the node downloads it: status valid-fork
        t.poll()
        row = store.stale[s]
        self.assertEqual((row["chaintip_status"], row["last_status"], row["full_block"]), ("headers-only", "valid-fork", True))

    def test_other_getblock_errors_abort_the_poll(self):
        node, store = FakeNode(), FakeStore()
        node.add("s4", node.active[3])
        def broken(method, *a):
            if method == "getblock":
                raise Exception("Connection reset by peer")
            return node(method, *a)
        with self.assertRaises(Exception):
            tracker(broken, store).poll()
        self.assertEqual(store.stale, {})                       # nothing half-recorded; retried next poll

    def test_idempotent(self):
        node, store = FakeNode(), FakeStore()
        x = node.add("s3", node.active[2])
        node.add("s4", x)
        t = tracker(node, store)
        t.poll()
        before = {h: dict(r) for h, r in store.stale.items()}
        node.calls.clear()
        stats = t.poll()
        self.assertEqual((stats["branches_recorded"], stats["skipped_known"]), (0, 1))
        self.assertEqual(store.stale, before)
        self.assertEqual([c[0] for c in node.calls], ["getchaintips", "getblockhash", "getblockhash"])  # reactivation check only

    def test_branch_extended_fetches_only_the_new_block(self):
        node, store = FakeNode(), FakeStore()
        x = node.add("s3", node.active[2])
        t = tracker(node, store)
        t.poll()
        node.add("s4", x)
        node.calls.clear()
        t.poll()
        self.assertEqual([c[1] for c in node.calls if c[0] == "getblock"], [bhash("s4")])
        self.assertEqual(len(store.stale), 2)


class BoundsTests(unittest.TestCase):
    def test_too_deep_ignored(self):
        node, store = FakeNode(length=10), FakeStore()
        node.add("old", node.active[1])                          # tip 8 blocks below the active tip
        stats = tracker(node, store, max_depth=5).poll()
        self.assertEqual((stats["skipped_bounds"], len(store.stale)), (1, 0))
        self.assertNotIn("getblockheader", [c[0] for c in node.calls])

    def test_too_old_ignored(self):
        node, store = FakeNode(), FakeStore()
        node.add("s4", node.active[3], time=int((NOW - timedelta(days=30)).timestamp()))
        stats = tracker(node, store, max_age_days=7).poll()
        self.assertEqual((stats["skipped_bounds"], len(store.stale)), (1, 0))

    def test_branch_ahead_of_tip_waits(self):
        node, store = FakeNode(), FakeStore()
        node.add("next", node.active[-1], headers_only=True)    # a header the node is still downloading
        self.assertEqual(tracker(node, store).poll()["skipped_bounds"], 1)
        self.assertEqual(store.stale, {})

    def test_long_branch_capped(self):
        node, store = FakeNode(length=10), FakeStore()
        x = node.active[1]
        for i in range(2, 10):
            x = node.add(f"s{i}", x)
        tracker(node, store, max_branch_blocks=3).poll()
        self.assertEqual(sorted(r["height"] for r in store.stale.values()), [1007, 1008, 1009])


class ReorgTests(unittest.TestCase):
    def test_reorg_records_disconnected_blocks(self):
        node = FakeNode()
        store = FakeStore(node.active)                           # a0..a4 stored as tips
        old3, old4 = node.active[3], node.active[4]
        x = node.add("b3", node.active[2])
        x = node.add("b4", x)
        new_tip = node.add("b5", x)
        node.reorg_to(new_tip)
        t = tracker(node, store)
        stats = t.poll()
        self.assertEqual(stats["reorgs"], 1)
        self.assertEqual(store.reorgs, [{"fork_height": 1002, "depth": 2, "old_tip_hash": old4, "old_tip_height": 1004,
                                         "new_tip_hash": new_tip, "new_tip_height": 1005, "detected_at": NOW}])
        for h in (old3, old4):
            self.assertTrue(store.stale[h]["was_active"])
            self.assertEqual(store.stale[h]["reorg_id"], 1)
        self.assertEqual(t.reorg_calls, [(1002, 1005, new_tip)])
        self.assertEqual(t.poll()["reorgs"], 0)                 # not counted twice

    def test_reorg_back_marks_reactivated_and_re_stales(self):
        node = FakeNode()
        store = FakeStore(node.active)
        a4 = node.active[4]
        b4 = node.add("b4", node.active[3])
        t = tracker(node, store)
        t.poll()                                                  # b4 stale (never active)
        self.assertFalse(store.stale[b4]["was_active"])
        b5 = node.add("b5", b4)
        node.reorg_to(b5)                                         # b's branch wins: a4 stale, b4 active again
        stats = t.poll()
        self.assertEqual((stats["reactivated"], stats["reorgs"]), (1, 1))
        self.assertIsNotNone(store.stale[b4]["reorged_in_at"])
        self.assertEqual(store.stale[b4]["last_status"], "active")
        self.assertTrue(store.stale[a4]["was_active"])
        a5 = node.add("a5", a4)
        a6 = node.add("a6", a5)
        node.reorg_to(a6)                                         # and back: b4 (and b5) stale again
        store.blocks.add(b5)                                      # the backend stored b5 as a tip
        stats = t.poll()
        self.assertEqual(stats["reorgs"], 1)
        self.assertIsNone(store.stale[b4]["reorged_in_at"])
        self.assertTrue(store.stale[b4]["was_active"])
        self.assertEqual(store.reorgs[-1]["depth"], 2)
        self.assertEqual(store.reorgs[-1]["old_tip_hash"], b5)

    def test_invalid_tip_recorded(self):
        node, store = FakeNode(), FakeStore()
        s = node.add("bad", node.active[3])
        node.invalid.add(s)
        tracker(node, store).poll()
        self.assertEqual(store.stale[s]["chaintip_status"], "invalid")


if __name__ == "__main__":
    unittest.main()
