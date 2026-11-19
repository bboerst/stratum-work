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
    def test_well_formed_coinbase_parses(self):
        parts = split_coinbase([output(546, P2SH), output(SUBSIDY - 546, P2SH), output(0, OP_RETURN)])
        self.assertEqual(icm.coinbase_total_output_sats(*parts), SUBSIDY)

    def test_declared_scriptsig_longer_than_supplied_falls_back_to_coinbase2(self):
        parts = split_coinbase([output(546, P2SH), output(SUBSIDY + 1_000_000, P2SH)], declared_extra=4)
        raw = icm.reconstruct_coinbase_raw(*parts)
        self.assertIsNone(icm.parse_tx_total_output_value_sats(raw))  # the reassembled tx is malformed
        self.assertEqual(icm.coinbase_total_output_sats(*parts), SUBSIDY + 546 + 1_000_000)

    def test_fallback_with_zero_sequence(self):
        parts = split_coinbase([output(SUBSIDY + 5, P2SH)], declared_extra=4, zero_sequence=True)
        self.assertEqual(icm.coinbase_total_output_sats(*parts), SUBSIDY + 5)

    def test_coinbase2_starting_with_the_output_count(self):
        outs = "02" + output(1, P2SH) + output(SUBSIDY + 7, P2SH) + "00000000"
        self.assertEqual(icm.parse_outputs_total_from_coinbase2(outs), SUBSIDY + 8)

    def test_garbage_is_none(self):
        self.assertIsNone(icm.parse_outputs_total_from_coinbase2("zz"))
        self.assertIsNone(icm.parse_outputs_total_from_coinbase2("0102030405"))
        self.assertIsNone(icm.coinbase_total_output_sats("01", "00", 4, "02"))


class AnalyzerTests(unittest.TestCase):
    def test_over_subsidy_empty_job_is_flagged_even_when_it_does_not_reassemble(self):
        bad = split_coinbase([output(546, P2SH), output(SUBSIDY + 1_000_000, P2SH)], declared_extra=4)
        flag = icm.analyze_invalid_coinbase_without_merkle([tpl(bad)], H, LOG)
        self.assertIsNotNone(flag)
        self.assertEqual(flag["details"]["offenders"][0]["total_sats"], SUBSIDY + 546 + 1_000_000)

    def test_valid_empty_job_is_not_flagged(self):
        ok = split_coinbase([output(546, P2SH), output(SUBSIDY - 546, P2SH)], declared_extra=4)
        self.assertIsNone(icm.analyze_invalid_coinbase_without_merkle([tpl(ok)], H, LOG))

    def test_full_template_is_not_checked(self):
        full = split_coinbase([output(SUBSIDY + 50_000_000, P2SH)])
        self.assertIsNone(icm.analyze_invalid_coinbase_without_merkle([tpl(full, branches=["33" * 32])], H, LOG))

    def test_unparseable_coinbase_is_skipped_and_logged(self):
        with self.assertLogs(LOG, level="WARNING") as cm:
            self.assertIsNone(icm.analyze_invalid_coinbase_without_merkle([tpl(("01", "00", 4, "02"))], H, LOG))
        self.assertIn("could not be parsed", cm.output[0])


if __name__ == "__main__":
    unittest.main()
