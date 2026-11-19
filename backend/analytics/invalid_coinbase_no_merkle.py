from typing import Any, Dict, List, Optional
from io import BytesIO


def reconstruct_coinbase_raw(coinbase1: str, extranonce1: str, extranonce2_length: int, coinbase2: str) -> str:
    try:
        return f"{coinbase1}{extranonce1}{'00' * int(extranonce2_length)}{coinbase2}"
    except Exception:
        return f"{coinbase1}{extranonce1}{coinbase2}"


def parse_tx_total_output_value_sats(coinbase_raw_hex: str) -> Optional[int]:
    """Sum of the outputs of the reassembled coinbase, or None if it isn't a well-formed transaction (parse error, or
    bytes left over / missing because the declared lengths don't match what was reassembled)."""
    try:
        from bitcoin.core import CTransaction  # local import to avoid hard dep at import-time
    except Exception:
        return None
    try:
        stream = BytesIO(bytes.fromhex(coinbase_raw_hex))
        tx = CTransaction.stream_deserialize(stream)
        if stream.read():  # trailing bytes: the declared lengths didn't line up
            return None
        return sum(int(vout.nValue) for vout in tx.vout)
    except Exception:
        return None


def _read_varint(b: bytes, i: int):
    v = b[i]
    if v < 0xFD:
        return v, i + 1
    if v == 0xFD:
        return int.from_bytes(b[i + 1:i + 3], "little"), i + 3
    if v == 0xFE:
        return int.from_bytes(b[i + 1:i + 5], "little"), i + 5
    return int.from_bytes(b[i + 1:i + 9], "little"), i + 9


def parse_outputs_total_from_coinbase2(coinbase2_hex: str) -> Optional[int]:
    """Fallback when the coinbase doesn't reassemble: some pools declare a scriptSig longer than coinbase1 +
    extranonce1 + extranonce2 actually supply, so the reassembled transaction is malformed. The outputs always sit at
    the end of coinbase2, so parse them from there: an output count either at the very start of coinbase2 (input
    sequence inside coinbase1) or right after a 4-byte input sequence, followed by outputs that end exactly at the
    4-byte locktime. Returns the total, or None if no position parses."""
    try:
        b = bytes.fromhex(coinbase2_hex)
    except ValueError:
        return None
    starts = [0] + [i + 4 for i in range(len(b) - 3) if b[i:i + 4] in (b"\xff\xff\xff\xff", b"\xfe\xff\xff\xff", b"\x00\x00\x00\x00")]
    for p in starts:
        try:
            n, i = _read_varint(b, p)
            if n == 0 or n > 256:
                continue
            total = 0
            for _ in range(n):
                total += int.from_bytes(b[i:i + 8], "little")
                i += 8
                script_len, i = _read_varint(b, i)
                i += script_len
            if i + 4 == len(b):
                return total
        except IndexError:
            continue
    return None


def coinbase_total_output_sats(coinbase1: str, extranonce1: str, extranonce2_length: int, coinbase2: str) -> Optional[int]:
    """Total paid by a template's coinbase: the reassembled transaction if it parses, else the outputs read from
    coinbase2 alone. None if neither works."""
    total = parse_tx_total_output_value_sats(reconstruct_coinbase_raw(coinbase1, extranonce1, extranonce2_length, coinbase2))
    if total is None:
        total = parse_outputs_total_from_coinbase2(coinbase2)
    return total


def get_block_subsidy_sats(height: int) -> int:
    halvings = height // 210000
    if halvings >= 64:
        return 0
    base = 50 * 100_000_000
    return base >> halvings


def _template_key(t: Dict[str, Any]):
    """The exact-template key of the history views (templates_copies): same pool, prev_hash, merkle_branches, version,
    nbits and ntime. Per-connection fields (job_id, extranonce1, coinbase) may differ between collectors."""
    return (t.get("pool_name"), str(t.get("prev_hash", "")).lower(), tuple(t.get("merkle_branches") or []),
            t.get("version"), t.get("nbits"), t.get("ntime"))


def analyze_invalid_coinbase_without_merkle(templates: List[Dict[str, Any]], height: int, logger) -> Optional[Dict[str, Any]]:
    """One offender per offending template the pool sent. The input has every collector's rows (several collectors
    per pool see the same template), so exact copies are paired one-to-one per collector (site, replica) like the
    history views: a key counts as many times as the collector that saw it most often, so a pool's own identical
    re-sends still count, a copy from another collector doesn't, and a template only one collector got is kept."""
    subsidy = get_block_subsidy_sats(height)
    # key -> {collector: [offender, ...]} in input order
    by_key: Dict[Any, Dict[Any, List[Dict[str, Any]]]] = {}
    unparsed = 0
    for t in templates:
        merkle_branches = t.get("merkle_branches") or []
        if isinstance(merkle_branches, list) and len(merkle_branches) == 0:
            coinbase1 = str(t.get("coinbase1", ""))
            coinbase2 = str(t.get("coinbase2", ""))
            extranonce1 = str(t.get("extranonce1", ""))
            extranonce2_length = int(t.get("extranonce2_length", 0) or 0)
            total = coinbase_total_output_sats(coinbase1, extranonce1, extranonce2_length, coinbase2)
            if total is None:
                unparsed += 1
                continue
            if total > subsidy:
                collector = (t.get("site"), t.get("replica"))
                by_key.setdefault(_template_key(t), {}).setdefault(collector, []).append(
                    {
                        "pool_name": t.get("pool_name", "unknown"),
                        "total_sats": total,
                        "subsidy_sats": subsidy,
                    }
                )
    if unparsed:
        logger.warning("Analysis(invalid_coinbase_without_merkle): %d empty templates at height %d have a coinbase that "
                       "could not be parsed; they were not checked", unparsed, height)
    offenders: List[Dict[str, Any]] = []
    for per_collector in by_key.values():
        offenders.extend(max(per_collector.values(), key=len))
    if not offenders:
        return None
    logger.warning(
        "Analysis(invalid_coinbase_without_merkle): %d offending templates found at height %d (subsidy=%d)",
        len(offenders),
        height,
        subsidy,
    )
    return {"key": "invalid_coinbase_no_merkle", "icon": "error", "details": {"offenders": offenders}}
