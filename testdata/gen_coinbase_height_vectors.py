"""Writes coinbase-height-vectors.json: BIP34 height cases for coinbase1, shared by the collector (collector-go
coinbase.go parseBIP34Height, which writes templates.height) and the web (web/utils/coinbaseParser.ts). Both must give
`height` for every case (as a decimal string; null = no height, stored as 0); where the web differs on purpose it says
so in `web` with the reason. Synthetic bytes only, no real pool data.

    python3 testdata/gen_coinbase_height_vectors.py > testdata/coinbase-height-vectors.json
"""
import json

NULL_PREVOUT = "00" * 32 + "ffffffff"


def cb1(script_head: str, *, version="01000000", segwit=False, inputs="01", prevout=NULL_PREVOUT, sig_len=None):
    """coinbase1 up to the extranonce: the scriptSig length covers the head plus 8 extranonce bytes, as pools send."""
    n = len(script_head) // 2 + 8 if sig_len is None else sig_len
    return version + ("0001" if segwit else "") + inputs + prevout + f"{n:02x}" + script_head


def push(value: int, size: int) -> str:
    return f"{size:02x}" + value.to_bytes(size, "little").hex()


cases = []
def case(name, coinbase1, height, web=None):
    c = {"name": name, "coinbase1": coinbase1, "height": None if height is None else str(height)}
    if web is not None:
        c["web"] = web
    cases.append(c)

tag = "2f706f6f6c2f"  # "/pool/"
case("3-byte push (today's Bitcoin heights)", cb1(push(977300, 3) + tag), 977300)
case("segwit marker before the input count", cb1(push(977300, 3) + tag, segwit=True), 977300)
case("1-byte push", cb1(push(5, 1)), 5)
case("2-byte push", cb1(push(300, 2)), 300)
case("3-byte push past 1,000,000", cb1(push(1_000_000, 3) + tag), 1_000_000)
case("3-byte push at its limit (sign bit clear)", cb1(push(8_388_607, 3) + tag), 8_388_607)
case("4-byte push just past the 3-byte limit", cb1(push(8_388_608, 4) + tag), 8_388_608)
case("11-byte push: a tag, not a height", cb1("0b" + "2f746573742d706f6f6c2f"), None)
case("4-byte push (another chain's larger height)", cb1(push(6976415, 4)), 6976415)
case("6-byte push", cb1(push(2**40 + 7, 6)), 2**40 + 7)
case("7-byte push", cb1(push(2**50 + 3, 7)), 2**50 + 3)
case("8-byte push, small value", cb1(push(1, 8)), 1)
case("8-byte push past 2^53", cb1(push(2**60 + 1, 8)), 2**60 + 1,
     web={"height": None, "why": "not exact as a JavaScript number; the web shows no height rather than a wrong one"})
case("OP_1 (height 1)", cb1("51" + tag), 1)
case("OP_16 (height 16)", cb1("60" + tag), 16)
case("OP_0 is not a height", cb1("00" + tag), None)
case("sign bit set: negative, never a height", cb1("03" + "0000" + "80" + tag), None)
case("9-byte push is too long", cb1(push(1, 9)), None)
case("a non-push first opcode", cb1("6a" + tag), None)
case("push truncated by the end of coinbase1", cb1("03a0e4"), None)
case("push longer than the scriptSig length", cb1(push(977300, 3), sig_len=3), None)
case("empty scriptSig", cb1("", sig_len=0), None)
case("two inputs: not a coinbase", cb1(push(977300, 3), inputs="02"), None)
case("prevout not null: not a coinbase input", cb1(push(977300, 3), prevout="11" * 32 + "ffffffff"), None)
case("prevout index not ffffffff", cb1(push(977300, 3), prevout="00" * 32 + "00000000"), None)
case("truncated before the prevout ends", cb1(push(977300, 3))[:40], None)
case("version only", "01000000", None)
case("not hex", "zz" + cb1(push(977300, 3))[2:], None)
case("odd number of hex digits", cb1(push(977300, 3)) + "a", None)
case("empty", "", None)

print(json.dumps({"version": 1, "about": __doc__.strip().splitlines()[0], "cases": cases}, indent=1))
