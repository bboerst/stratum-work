"""Parse fields out of a Stratum ``mining.notify`` coinbase.

``coinbase1`` is the start of the coinbase transaction (non-witness serialization) up to the extranonce:

    version (4) | [segwit marker 00 01] | input count (varint, = 1) | prevout (32 x 00 + ffffffff)
    | scriptSig length (varint) | scriptSig ...      <- the BIP34 height push is the first scriptSig item

so the block height can be read from ``coinbase1`` alone, without assembling the full transaction.
"""

from __future__ import annotations

_NULL_PREVOUT = b"\x00" * 32 + b"\xff\xff\xff\xff"


def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    """Bitcoin CompactSize. Returns (value, new position); raises IndexError if truncated."""
    first = data[pos]
    if first < 0xFD:
        return first, pos + 1
    size = {0xFD: 2, 0xFE: 4, 0xFF: 8}[first]
    if pos + 1 + size > len(data):
        raise IndexError("truncated varint")
    return int.from_bytes(data[pos + 1 : pos + 1 + size], "little"), pos + 1 + size


def parse_bip34_height(coinbase1_hex: str) -> int | None:
    """Block height from the coinbase scriptSig (BIP34), or ``None`` if it can't be determined.

    Handles every minimal encoding of the height:
      * a direct push of 1-8 bytes: little-endian, sign bit in the last byte (a CScriptNum)
      * OP_1 .. OP_16 for heights 1-16

    The previous implementation read a fixed ``script[1:4]`` (3 bytes) and ignored the push length. That is
    right for Bitcoin heights up to 8,388,607 but produces garbage for any other push size (e.g. other chains'
    templates on the same endpoint), see #98.

    Returns ``None`` (never a guess) for: invalid hex, a transaction that isn't a coinbase (non-null prevout),
    a truncated push, a negative number, or a scriptSig that doesn't start with a height.
    """
    try:
        data = bytes.fromhex(coinbase1_hex)
    except (TypeError, ValueError):
        return None

    try:
        pos = 4  # version
        if data[pos] == 0x00 and data[pos + 1] == 0x01:  # segwit marker + flag (not expected in stratum, harmless)
            pos += 2
        n_inputs, pos = _read_varint(data, pos)
        if n_inputs != 1 or data[pos : pos + 36] != _NULL_PREVOUT:
            return None
        pos += 36
        script_len, pos = _read_varint(data, pos)
        if script_len == 0:
            return None
        op = data[pos]
    except (IndexError, KeyError):
        return None

    if 0x01 <= op <= 0x08:
        push = data[pos + 1 : pos + 1 + op]
        if len(push) != op or op > script_len - 1:
            return None
        if push[-1] & 0x80:  # negative CScriptNum: never a valid height
            return None
        return int.from_bytes(push, "little")
    if 0x51 <= op <= 0x60:  # OP_1 .. OP_16
        return op - 0x50
    return None
