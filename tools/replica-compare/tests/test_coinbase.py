import pytest

from helpers import commitment, p2wpkh, split_coinbase
from replica_compare.analyze import diff_runs
from replica_compare.coinbase import DecodeError, decode, script_kind


def test_decode_regions_and_outputs():
    outs = [(312_500_000, p2wpkh("x")), (0, commitment("y")), (0, b"\x6a\x04abcd")]
    cb1, cb2 = split_coinbase(900_000, b"/tag/", 12, b"/post", outs)
    cb = decode(cb1, b"\x01\x02\x03\x04", 8, cb2)
    assert cb.extranonce_in_scriptsig
    assert cb.extranonce_len == 12
    r = cb.region_bytes()
    assert r["sig_pre"] == b"\x03" + (900_000).to_bytes(3, "little") + b"/tag/"
    assert r["sig_post"] == b"/post"
    assert [o.value for o in cb.outputs] == [312_500_000, 0, 0]
    assert [o.kind for o in cb.outputs] == ["p2wpkh", "witness_commitment", "op_return"]
    assert cb.locktime == 0 and not cb.segwit


def test_decode_rejects_garbage():
    cb1, cb2 = split_coinbase(1, b"", 4, b"", [(1, p2wpkh("x"))])
    with pytest.raises(DecodeError):
        decode(cb1, b"\x00", 4, cb2 + b"\x00")          # wrong extranonce size: trailing bytes
    with pytest.raises(DecodeError):
        decode(b"\x01\x00\x00\x00\x01" + b"\x01" * 36, b"", 0, b"")   # not a coinbase prevout


@pytest.mark.parametrize("script,kind", [
    (b"\x76\xa9\x14" + bytes(20) + b"\x88\xac", "p2pkh"), (b"\xa9\x14" + bytes(20) + b"\x87", "p2sh"),
    (b"\x00\x20" + bytes(32), "p2wsh"), (b"\x51\x20" + bytes(32), "p2tr"), (b"\x01", "other")])
def test_script_kind(script, kind):
    assert script_kind(script) == kind


def test_diff_runs():
    assert diff_runs(b"abc", b"abc") == []
    assert diff_runs(b"abcdef", b"aXcdYZ") == [(1, 1), (4, 2)]
    assert diff_runs(b"abcdef", b"abXXXdef") == [(2, 3)]   # unequal lengths: one span


def test_extranonce_overlapping_the_sequence_is_masked():
    cb1, cb2 = split_coinbase(900_000, b"/tag/", 9, b"", [(1, p2wpkh("x"))], locktime=77, en_in_sig=5)
    cb = decode(cb1, b"\x01", 8, cb2)
    assert not cb.extranonce_in_scriptsig
    assert cb.extranonce_regions() == ["scriptSig", "sequence"]
    other = decode(cb1, b"\x02", 8, cb2)
    assert cb.region_bytes() == other.region_bytes()        # only the extranonce differs
    assert cb.region_bytes()["sequence"] == b""              # all four sequence bytes are extranonce
    assert cb.locktime == 77
