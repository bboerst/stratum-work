import unittest

try:
    from collector.coinbase import parse_bip34_height
except ImportError:  # pragma: no cover - when run from inside collector/
    from coinbase import parse_bip34_height  # type: ignore

PREFIX = "01000000" + "01" + "00" * 32 + "ffffffff"  # version 1, one input, null prevout


def cb1(script_hex: str, script_len: int | None = None, version: str = "01000000") -> str:
    """coinbase1 with the given scriptSig start; scriptSig length defaults to the bytes given (+10 for extranonce)."""
    n = script_len if script_len is not None else len(script_hex) // 2 + 10
    return version + "01" + "00" * 32 + "ffffffff" + f"{n:02x}" + script_hex


class ParseBip34HeightTests(unittest.TestCase):
    def test_real_mainnet_coinbase1_prefixes(self):
        # Real coinbase1 prefixes collected for height 975507 (0x0ee293), from several pools' templates
        for coinbase1 in (
            PREFIX + "560393e20e194d696e6564206279",  # 3-byte push, then a tag
            PREFIX + "640393e20e2cfabe6d6dc5a4e656",  # 3-byte push, then merge-mining data
            "02000000" + "01" + "00" * 32 + "ffffffff" + "4c0393e20e01000c",  # version 2
        ):
            self.assertEqual(parse_bip34_height(coinbase1), 975507)

    def test_honors_push_length_instead_of_assuming_three_bytes(self):
        # 2-byte push: height 0x1234; the old script[1:4] parser also read the next byte (0xaa) -> 0xaa3412
        self.assertEqual(parse_bip34_height(cb1("023412aa")), 0x1234)
        # 4-byte push (heights >= 2^23): 0x00a3c2b1 -> the old parser dropped the top byte
        self.assertEqual(parse_bip34_height(cb1("04b1c2a300")), 0x00A3C2B1)
        # 1-byte push
        self.assertEqual(parse_bip34_height(cb1("0111")), 0x11)

    def test_minimal_encoding_extra_zero_byte(self):
        # 128 needs a 0x00 byte so the sign bit is clear: push 2 bytes 80 00
        self.assertEqual(parse_bip34_height(cb1("028000")), 128)

    def test_op_n_small_heights(self):
        self.assertEqual(parse_bip34_height(cb1("51")), 1)
        self.assertEqual(parse_bip34_height(cb1("60")), 16)

    def test_returns_none_instead_of_guessing(self):
        cases = {
            "not hex": "zz" * 50,
            "empty": "",
            "truncated before prevout": "0100000001" + "00" * 10,
            "not a coinbase (non-null prevout)": "01000000" + "01" + "11" * 32 + "ffffffff" + "0a0393e20e",
            "two inputs": "01000000" + "02" + "00" * 32 + "ffffffff" + "0a0393e20e",
            "empty scriptSig": cb1("", script_len=0),
            "truncated push": cb1("0393e2", script_len=10),
            "push longer than scriptSig": cb1("0393e20e", script_len=2),
            "negative number": cb1("0393e28e"),
            "starts with a non-push opcode": cb1("6a0393e20e"),
            "OP_0": cb1("00"),
        }
        for name, coinbase1 in cases.items():
            with self.subTest(name):
                self.assertIsNone(parse_bip34_height(coinbase1))

    def test_varint_script_length(self):
        # scriptSig length >= 0xfd is encoded as fd + 2 bytes
        coinbase1 = "01000000" + "01" + "00" * 32 + "ffffffff" + "fd0001" + "0393e20e"
        self.assertEqual(parse_bip34_height(coinbase1), 975507)


if __name__ == "__main__":
    unittest.main()
