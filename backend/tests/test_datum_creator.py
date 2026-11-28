"""DATUM template creator (#320): only exact pool/gateway markers are skipped; a gateway's default tag is its own value;
--datum-creators re-runs the choice on stored blocks, changing only the creator keys."""
import logging
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import coinbase_reanalysis as cr  # noqa: E402
from analytics.pool_identification import datum_creator_fields, identify_pool_from_data  # noqa: E402


def script(*parts, pool_marker="< OCEAN.XYZ >", tail=b"\x07\x11x\x00@\xce\x90]"):
    """A coinbase scriptSig the way a DATUM gateway writes it: height push, then one push of
    primary 0x0f secondary [0x0f tertiary] 0x00, then the extranonce bytes."""
    tag = b"\x0f".join([pool_marker.encode(), *(p.encode() for p in parts)]) + b"\x00"
    return (b"\x03\x2a\x9c\x0e" + bytes([len(tag)]) + tag + tail).hex()


POOLS = {"9": {"name": "OCEAN", "tags": ["OCEAN.XYZ"], "addresses": ["bc1qpool"]},
         "7": {"name": "Other", "tags": ["/other/"], "addresses": []}}


class ChoiceRuleTests(unittest.TestCase):
    # The 4 cases of the issue.
    def test_a_creator_name_containing_datum_is_a_creator(self):
        self.assertEqual(datum_creator_fields(script("Datum Farm")), {"datum_template_creator": "Datum Farm"})
        self.assertEqual(datum_creator_fields(script("Acme-Datum")), {"datum_template_creator": "AcmeDatum"})

    def test_the_exact_gateway_default_is_its_own_value(self):
        self.assertEqual(datum_creator_fields(script("DATUM User")), {"datum_gateway_default": "DATUM User"})

    def test_the_exact_pool_marker_names_no_one(self):
        self.assertEqual(datum_creator_fields(script("OCEAN.XYZ")), {})
        self.assertEqual(datum_creator_fields(script("Farm", pool_marker="DATUM Gateway")),
                         {"datum_template_creator": "Farm"})

    def test_an_ordinary_name_is_a_creator(self):
        self.assertEqual(datum_creator_fields(script("Farm One")), {"datum_template_creator": "Farm One"})

    # Edges seen in the stored blocks.
    def test_a_one_part_tag_names_no_one(self):
        # No 0x0f: the pool's own tag. The parser picks up the byte after the tag ("OCEANXYZ 1"), which isn't the
        # exact marker but still names no one.
        self.assertEqual(datum_creator_fields((b"\x03\xe7\xfe\x0c\x10\x00< OCEAN.XYZ >\x001").hex()), {})
        self.assertEqual(datum_creator_fields(script(pool_marker="< OCEAN.XYZ >")), {})

    def test_the_last_part_that_is_not_a_marker_decides(self):
        self.assertEqual(datum_creator_fields(script("", "00OC")), {"datum_template_creator": "00OC"})
        self.assertEqual(datum_creator_fields(script("Farm", "OCEAN.XYZ")), {"datum_template_creator": "Farm"})
        self.assertEqual(datum_creator_fields(script("Farm", "DATUM User")), {"datum_gateway_default": "DATUM User"})

    def test_markers_are_case_sensitive_exact_strings(self):
        self.assertEqual(datum_creator_fields(script("datum user")), {"datum_template_creator": "datum user"})
        self.assertEqual(datum_creator_fields(script("DATUM Users")), {"datum_template_creator": "DATUM Users"})

    def test_identify_sets_the_keys_only_for_the_datum_pool(self):
        ocean = identify_pool_from_data(POOLS, script("Datum Farm"), ["bc1qpool"])
        self.assertEqual((ocean["name"], ocean["datum_template_creator"]), ("OCEAN", "Datum Farm"))
        by_tag = identify_pool_from_data(POOLS, script("DATUM User"), [])
        self.assertEqual((by_tag["name"], by_tag.get("datum_gateway_default"), "datum_template_creator" in by_tag),
                         ("OCEAN", "DATUM User", False))
        other = identify_pool_from_data(POOLS, script("Farm", pool_marker="/other/"), [])
        self.assertEqual(other["name"], "Other")
        self.assertNotIn("datum_template_creator", other)


class FakeStore:
    def __init__(self, blocks):
        self.blocks, self.writes = blocks, []

    def datum_pool_blocks(self):
        return [dict(b, block_hash=h) for h, b in sorted(self.blocks.items())]

    def update_datum_creator(self, block_hash, fields):
        b = self.blocks[block_hash]
        for key in ("mining_pool", "analysis_mining_pool"):
            if isinstance(b.get(key), dict):
                b[key] = {**{k: v for k, v in b[key].items()
                             if k not in ("datum_template_creator", "datum_gateway_default")}, **fields}
        self.writes.append(block_hash)


def pool(**creator):
    return {"id": 9, "name": "OCEAN", "match_type": "address", **creator}


class ReanalysisTests(unittest.TestCase):
    def setUp(self):
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)
        self.store = FakeStore({
            "a1": {"height": 1, "coinbase_script_sig": script("Farm One"),                  # unchanged
                   "mining_pool": pool(datum_template_creator="Farm One"),
                   "analysis_mining_pool": pool(datum_template_creator="Farm One")},
            "a2": {"height": 2, "coinbase_script_sig": script("Datum Farm"),                # was skipped
                   "mining_pool": pool(), "analysis_mining_pool": pool()},
            "a3": {"height": 3, "coinbase_script_sig": script("DATUM User"),                # gateway default
                   "mining_pool": pool(), "analysis_mining_pool": None},
            "a4": {"height": 4, "coinbase_script_sig": (b"\x03\xe7\xfe\x0c\x10\x00< OCEAN.XYZ >\x001").hex(),
                   "mining_pool": pool(), "analysis_mining_pool": pool()},                    # one part: none
        })

    def test_changes_only_the_creator_keys(self):
        self.assertEqual(cr.main(["--datum-creators"], store=self.store), 0)
        self.assertEqual(self.store.writes, ["a2", "a3"])
        self.assertEqual(self.store.blocks["a2"]["mining_pool"], pool(datum_template_creator="Datum Farm"))
        self.assertEqual(self.store.blocks["a2"]["analysis_mining_pool"], pool(datum_template_creator="Datum Farm"))
        self.assertEqual(self.store.blocks["a3"]["mining_pool"], pool(datum_gateway_default="DATUM User"))
        self.assertIsNone(self.store.blocks["a3"]["analysis_mining_pool"])

    def test_summary_dry_run_and_idempotence(self):
        s = cr.reanalyze_datum_creators(self.store, dry_run=True)
        self.assertEqual((s["datum_blocks"], s["blocks_changed"], self.store.writes), (4, 2, []))
        self.assertEqual(s["after"], {"creator": 2, "gateway_default": 1, "none": 1})
        self.assertEqual(s["changes"][0], {"height": 2, "block_hash": "a2", "before": {},
                                           "after": {"datum_template_creator": "Datum Farm"}})
        cr.reanalyze_datum_creators(self.store)
        self.assertEqual(cr.reanalyze_datum_creators(self.store)["blocks_changed"], 0)

    def test_a_stale_analysis_copy_alone_is_rewritten(self):
        self.store.blocks["a1"]["analysis_mining_pool"] = pool()
        self.assertEqual(cr.reanalyze_datum_creators(self.store)["changes"][0]["block_hash"], "a1")
        self.assertEqual(self.store.blocks["a1"]["analysis_mining_pool"], pool(datum_template_creator="Farm One"))

    def test_height_bounds_are_refused(self):
        with self.assertRaises(SystemExit):
            cr.main(["--datum-creators", "--from", "1"], store=self.store)


if __name__ == "__main__":
    unittest.main()
