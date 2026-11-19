"""Coinbase value parsing for the invalid-coinbase analyzer, on synthetic stratum coinbases (no real pool data)."""
import logging
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from analytics import invalid_coinbase_no_merkle as icm  # noqa: E402

LOG = logging.getLogger("test")
H = 900_000
SUBSIDY = icm.get_block_subsidy_sats(H)  # 3.125 BTC at this height


def output(sats: int, script_hex: str) -> str:
    script = bytes.fromhex(script_hex)
    return sats.to_bytes(8, "little").hex() + bytes([len(script)]).hex() + script.hex()


P2SH = "a914" + "11" * 20 + "87"
OP_RETURN = "6a24aa21a9ed" + "22" * 32


def split_coinbase(outputs, en1_len=4, en2_len=4, script_prefix="03a0bb0d", script_suffix="2f74657374", declared_extra=0,
                   zero_sequence=False):
    """A stratum coinbase split into (coinbase1, extranonce1, extranonce2_length, coinbase2).
    declared_extra > 0 makes the scriptSig length byte claim more bytes than coinbase1 + extranonces + suffix supply
    (the malformed case). zero_sequence uses an all-zero input sequence instead of ffffffff."""
    script_len = len(script_prefix) // 2 + en1_len + en2_len + len(script_suffix) // 2 + declared_extra
    cb1 = "01000000" + "01" + "00" * 32 + "ffffffff" + bytes([script_len]).hex() + script_prefix
    outs = bytes([len(outputs)]).hex() + "".join(outputs) + "00000000"
    cb2 = script_suffix + ("00000000" if zero_sequence else "ffffffff") + outs
    return cb1, "ab" * en1_len, en2_len, cb2


def tpl(parts, branches=(), pool="PoolA"):
    cb1, en1, en2_len, cb2 = parts
    return {"pool_name": pool, "height": H, "prev_hash": "11" * 32, "merkle_branches": list(branches), "version": "20000000",
            "nbits": "17034219", "ntime": "66000000", "coinbase1": cb1, "coinbase2": cb2, "extranonce1": en1,
            "extranonce2_length": en2_len, "site": "s1", "replica": "a"}


class CoinbaseValueTests(unittest.TestCase):
    def test_well_formed_coinbase_parses_with_its_stored_length(self):
        parts = split_coinbase([output(546, P2SH), output(SUBSIDY - 546, P2SH), output(0, OP_RETURN)])
        self.assertEqual(icm.coinbase_total_output_sats(*parts), (SUBSIDY, 4))

    def test_stored_length_short_is_repaired_by_the_one_length_that_parses(self):
        # The collector kept a previous connection's extranonce2 length: 4 stored, 8 used by the pool.
        parts = split_coinbase([output(546, P2SH), output(SUBSIDY + 1_000_000, P2SH)], declared_extra=4)
        raw = icm.reconstruct_coinbase_raw(*parts)
        self.assertIsNone(icm.parse_tx_total_output_value_sats(raw))  # the stored length doesn't reassemble
        self.assertEqual(icm.coinbase_total_output_sats(*parts), (SUBSIDY + 546 + 1_000_000, 8))

    def test_stored_length_long_is_repaired(self):
        cb1, en1, _, cb2 = split_coinbase([output(SUBSIDY + 5, P2SH)], en2_len=4)
        self.assertEqual(icm.coinbase_total_output_sats(cb1, en1, 8, cb2), (SUBSIDY + 5, 4))

    def test_zero_sequence_repaired(self):
        parts = split_coinbase([output(SUBSIDY + 5, P2SH)], declared_extra=4, zero_sequence=True)
        self.assertEqual(icm.coinbase_total_output_sats(*parts), (SUBSIDY + 5, 8))

    def test_trailing_bytes_are_not_a_transaction(self):
        cb1, en1, en2, cb2 = split_coinbase([output(1, P2SH)])
        self.assertIsNone(icm.parse_tx_total_output_value_sats(icm.reconstruct_coinbase_raw(cb1, en1, en2, cb2 + "00")))

    def test_garbage_is_none(self):
        self.assertEqual(icm.coinbase_total_output_sats("01", "00", 4, "02"), (None, None))
        self.assertEqual(icm.coinbase_total_output_sats("zz", "", 4, ""), (None, None))

    def test_ambiguous_lengths_are_not_guessed(self):
        # Make two extranonce2 lengths parse: patch the strict parser to accept lengths 5 and 6 only.
        orig = icm.parse_tx_total_output_value_sats
        try:
            icm.parse_tx_total_output_value_sats = lambda raw: 1 if len(raw) in (2 * 5 + 6, 2 * 6 + 6) else None
            self.assertEqual(icm.coinbase_total_output_sats("aa", "bb", 4, "cc"), (None, None))
            icm.parse_tx_total_output_value_sats = lambda raw: 1 if len(raw) == 2 * 6 + 6 else None
            self.assertEqual(icm.coinbase_total_output_sats("aa", "bb", 4, "cc"), (1, 6))
        finally:
            icm.parse_tx_total_output_value_sats = orig


class AnalyzerTests(unittest.TestCase):
    def test_over_subsidy_empty_job_is_flagged_even_when_the_stored_length_is_wrong(self):
        bad = split_coinbase([output(546, P2SH), output(SUBSIDY + 1_000_000, P2SH)], declared_extra=4)
        flag, report = icm.analyze_coinbases([tpl(bad)], H, LOG)
        self.assertEqual(flag["details"]["offenders"][0]["total_sats"], SUBSIDY + 546 + 1_000_000)
        self.assertEqual(report, {"repaired": [{"pool_name": "PoolA", "stored_extranonce2_length": 4,
                                                "extranonce2_length": 8, "templates": 1}], "unparsed": []})

    def test_valid_empty_job_is_not_flagged_but_the_repair_is_reported(self):
        ok = split_coinbase([output(546, P2SH), output(SUBSIDY - 546, P2SH)], declared_extra=4)
        flag, report = icm.analyze_coinbases([tpl(ok), tpl(ok)], H, LOG)
        self.assertIsNone(flag)
        self.assertEqual(report["repaired"][0]["templates"], 2)

    def test_well_formed_templates_report_nothing(self):
        ok = split_coinbase([output(SUBSIDY, P2SH)])
        self.assertEqual(icm.analyze_coinbases([tpl(ok), tpl(ok, branches=["33" * 32])], H, LOG), (None, None))

    def test_full_template_is_not_checked_against_the_subsidy(self):
        full = split_coinbase([output(SUBSIDY + 50_000_000, P2SH)])
        self.assertEqual(icm.analyze_coinbases([tpl(full, branches=["33" * 32])], H, LOG), (None, None))

    def test_unparseable_coinbases_are_recorded_per_pool_and_logged(self):
        bad = dict(tpl(("01", "00", 4, "02")), job_id="j1")
        other = dict(tpl(("01", "00", 4, "02"), pool="PoolB"), job_id="j9")
        with self.assertLogs(LOG, level="WARNING") as cm:
            flag, report = icm.analyze_coinbases([bad, dict(bad, job_id="j2"), other], H, LOG)
        self.assertIsNone(flag)
        self.assertEqual(report["unparsed"], [
            {"pool_name": "PoolA", "extranonce2_length": 4, "templates": 2, "sample_job_id": "j1"},
            {"pool_name": "PoolB", "extranonce2_length": 4, "templates": 1, "sample_job_id": "j9"},
        ])
        self.assertIn("doesn't parse", cm.output[0])

    def test_flag_only_wrapper(self):
        bad = split_coinbase([output(SUBSIDY + 1, P2SH)])
        self.assertIsNotNone(icm.analyze_invalid_coinbase_without_merkle([tpl(bad)], H, LOG))


if __name__ == "__main__":
    unittest.main()
