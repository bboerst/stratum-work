"""Decode a stratum coinbase transaction into its parts.

A mining.notify carries the coinbase transaction split around the extranonce:

    coinbase1 | extranonce1 | extranonce2 | coinbase2

The tool rebuilds it with extranonce2 = zeros and parses the (non-witness) serialization:

    version (4) | [00 01 marker] | inputs (varint, = 1) | prevout (36) | scriptSig (varint + bytes) | sequence (4)
    | outputs (varint) | per output: value (8, LE) + scriptPubKey (varint + bytes) | [witness] | locktime (4)

Every position is an offset into that rebuilt transaction, so diffs can be attributed to a region.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


class DecodeError(ValueError):
    pass


def _varint(data: bytes, pos: int) -> tuple[int, int]:
    if pos >= len(data):
        raise DecodeError("truncated varint")
    first = data[pos]
    if first < 0xFD:
        return first, pos + 1
    width = {0xFD: 2, 0xFE: 4, 0xFF: 8}[first]
    if pos + 1 + width > len(data):
        raise DecodeError("truncated varint")
    return int.from_bytes(data[pos + 1:pos + 1 + width], "little"), pos + 1 + width


@dataclass
class Output:
    value: int            # satoshis
    script: bytes
    start: int            # offset of the scriptPubKey in the transaction

    @property
    def kind(self) -> str:
        return script_kind(self.script)


@dataclass
class Coinbase:
    raw: bytes
    scriptsig_start: int
    scriptsig_len: int
    extranonce_start: int          # offset of extranonce1 in the transaction
    extranonce_len: int            # len(extranonce1) + extranonce2_length
    outputs: list[Output] = field(default_factory=list)
    locktime: int = 0
    segwit: bool = False
    _regions: Optional[dict] = field(default=None, repr=False, compare=False)

    @property
    def scriptsig(self) -> bytes:
        return self.raw[self.scriptsig_start:self.scriptsig_start + self.scriptsig_len]

    @property
    def extranonce_in_scriptsig(self) -> bool:
        return (self.scriptsig_start <= self.extranonce_start and
                self.extranonce_start + self.extranonce_len <= self.scriptsig_start + self.scriptsig_len)

    def spans(self) -> list[tuple[str, int, int]]:
        """(region, start, end) over the whole transaction. The scriptSig is split where the extranonce starts:
        `sig_pre` (from coinbase1) and `sig_post` (from coinbase2)."""
        ss, se = self.scriptsig_start, self.scriptsig_start + self.scriptsig_len
        es = self.extranonce_start
        out = [("header", 0, ss)]
        if ss <= es <= se:
            out += [("sig_pre", ss, es), ("sig_post", es, se)]
        else:
            out += [("sig_pre", ss, se), ("sig_post", se, se)]
        out.append(("sequence", se, se + 4))
        for i, o in enumerate(self.outputs):
            vs = o.start - 8 - (len(_enc_varint(len(o.script))))
            out += [(f"out{i}.value", vs, vs + 8), (f"out{i}.script", o.start, o.start + len(o.script))]
        out.append(("locktime", len(self.raw) - 4, len(self.raw)))
        return out

    def extranonce_regions(self) -> list[str]:
        """Regions the extranonce (extranonce1 + extranonce2) overlaps (the scriptSig counted once)."""
        es, ee = self.extranonce_start, self.extranonce_start + self.extranonce_len
        out = []
        for n, a, b in self.spans():
            n = "scriptSig" if n.startswith("sig_") else n
            if a < ee and es < b and n not in out:
                out.append(n)
        return out

    def region_bytes(self) -> dict[str, bytes]:
        """The transaction split into named regions, with the extranonce bytes left out wherever they sit (they
        differ per connection by design). Varint length prefixes between outputs are not compared. Cached."""
        if self._regions is None:
            es, ee = self.extranonce_start, self.extranonce_start + self.extranonce_len
            r = self.raw
            self._regions = {n: r[a:max(a, min(b, es))] + r[max(a, min(b, ee)):b] for n, a, b in self.spans()}
        return self._regions


def _enc_varint(n: int) -> bytes:
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xfd" + n.to_bytes(2, "little")
    if n <= 0xFFFFFFFF:
        return b"\xfe" + n.to_bytes(4, "little")
    return b"\xff" + n.to_bytes(8, "little")


def build(coinbase1: bytes, extranonce1: bytes, extranonce2_length: int, coinbase2: bytes) -> bytes:
    return coinbase1 + extranonce1 + bytes(extranonce2_length) + coinbase2


def decode(coinbase1: bytes, extranonce1: bytes, extranonce2_length: int, coinbase2: bytes) -> Coinbase:
    raw = build(coinbase1, extranonce1, extranonce2_length, coinbase2)
    pos = 4
    segwit = False
    if len(raw) > pos + 1 and raw[pos] == 0 and raw[pos + 1] == 1:
        segwit, pos = True, pos + 2
    n_in, pos = _varint(raw, pos)
    if n_in != 1:
        raise DecodeError("coinbase must have exactly one input")
    if raw[pos:pos + 36] != bytes(32) + b"\xff\xff\xff\xff":
        raise DecodeError("not a coinbase prevout")
    pos += 36
    sig_len, pos = _varint(raw, pos)
    sig_start = pos
    pos += sig_len + 4  # scriptSig + sequence
    if pos > len(raw):
        raise DecodeError("truncated scriptSig")
    n_out, pos = _varint(raw, pos)
    if n_out > 10_000:
        raise DecodeError("implausible output count")
    outputs = []
    for _ in range(n_out):
        if pos + 8 > len(raw):
            raise DecodeError("truncated output")
        value = int.from_bytes(raw[pos:pos + 8], "little")
        slen, pos = _varint(raw, pos + 8)
        if pos + slen > len(raw):
            raise DecodeError("truncated scriptPubKey")
        outputs.append(Output(value, raw[pos:pos + slen], pos))
        pos += slen
    if segwit:  # one witness stack for the single input
        n_items, pos = _varint(raw, pos)
        for _ in range(n_items):
            ilen, pos = _varint(raw, pos)
            pos += ilen
    if pos + 4 != len(raw):
        raise DecodeError(f"{len(raw) - pos} bytes where a 4-byte locktime should end the transaction")
    return Coinbase(raw, sig_start, sig_len, len(coinbase1), len(extranonce1) + extranonce2_length, outputs,
                    int.from_bytes(raw[pos:], "little"), segwit)


def script_kind(s: bytes) -> str:
    n = len(s)
    if n >= 6 and s[0] == 0x6A and s[1] == 0x24 and s[2:6] == bytes.fromhex("aa21a9ed"):
        return "witness_commitment"
    if n >= 1 and s[0] == 0x6A:
        return "op_return"
    if n == 25 and s[:3] == b"\x76\xa9\x14" and s[23:] == b"\x88\xac":
        return "p2pkh"
    if n == 23 and s[:2] == b"\xa9\x14" and s[22] == 0x87:
        return "p2sh"
    if n == 22 and s[:2] == b"\x00\x14":
        return "p2wpkh"
    if n == 34 and s[:2] == b"\x00\x20":
        return "p2wsh"
    if n == 34 and s[:2] == b"\x51\x20":
        return "p2tr"
    if n in (35, 67) and s[-1] == 0xAC:
        return "p2pk"
    return "other"


def try_decode(coinbase1: bytes, extranonce1: bytes, extranonce2_length: int,
               coinbase2: bytes) -> Optional[Coinbase]:
    try:
        return decode(coinbase1, extranonce1, extranonce2_length, coinbase2)
    except (DecodeError, KeyError, IndexError):
        return None
