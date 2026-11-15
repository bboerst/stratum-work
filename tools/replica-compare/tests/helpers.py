"""Synthetic coinbases and templates. Every value here is made up."""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from replica_compare.analyze import Template

T0 = datetime(2030, 1, 1, tzinfo=timezone.utc)


def varint(n: int) -> bytes:
    return bytes([n]) if n < 0xFD else b"\xfd" + n.to_bytes(2, "little")


def p2wpkh(seed: str) -> bytes:
    return b"\x00\x14" + hashlib.sha256(seed.encode()).digest()[:20]


def commitment(seed: str) -> bytes:
    return b"\x6a\x24\xaa\x21\xa9\xed" + hashlib.sha256(seed.encode()).digest()


def split_coinbase(height: int, sig_pre: bytes, en_len: int, sig_post: bytes,
                   outputs: list[tuple[int, bytes]], locktime: int = 0,
                   en_in_sig: int | None = None) -> tuple[bytes, bytes]:
    """coinbase1 / coinbase2 around an extranonce of en_len bytes. en_in_sig < en_len: only that many extranonce
    bytes are in the scriptSig, the rest overlap the sequence (sig_post must then be empty)."""
    h = height.to_bytes(3, "little")
    script_pre = b"\x03" + h + sig_pre
    en_in_sig = en_len if en_in_sig is None else en_in_sig
    sig_len = len(script_pre) + en_in_sig + len(sig_post)
    cb1 = (b"\x01\x00\x00\x00" + b"\x01" + bytes(32) + b"\xff\xff\xff\xff" + varint(sig_len) + script_pre)
    outs = b"".join(v.to_bytes(8, "little") + varint(len(s)) + s for v, s in outputs)
    sequence = b"\xff\xff\xff\xff"[en_len - en_in_sig:]
    cb2 = sig_post + sequence + varint(len(outputs)) + outs + locktime.to_bytes(4, "little")
    return cb1, cb2


def template(replica: str, at_ms: float, *, prev: bytes = b"\x11" * 32, merkle: bytes = b"\x22" * 32,
             height: int = 900_000, ntime: int = 1_893_456_000, version: int = 0x20000000, nbits: int = 0x17030000,
             en1: bytes = b"\xaa\xbb\xcc\xdd", en2_len: int = 8, sig_pre: bytes = b"/tag/", sig_post: bytes = b"",
             outputs=None, job_id: str = "j", clean: bool = False, locktime: int = 0,
             en_in_sig: int | None = None) -> Template:
    outputs = outputs if outputs is not None else [(312_500_000, p2wpkh("payout")), (0, commitment(merkle.hex()))]
    cb1, cb2 = split_coinbase(height, sig_pre, len(en1) + en2_len, sig_post, outputs, locktime,
                              None if en_in_sig is None else en_in_sig)
    return Template(replica, T0 + timedelta(milliseconds=at_ms), height, job_id, prev, cb1, cb2, merkle, version,
                    nbits, ntime, clean, en1, en2_len)
