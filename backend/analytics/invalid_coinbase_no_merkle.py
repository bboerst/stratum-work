"""Coinbase checks on a height's templates.

1. Every template's coinbase must reassemble into a well-formed transaction:
   coinbase1 + extranonce1 + (extranonce2_length zero bytes) + coinbase2, parsed strictly (no bytes missing or left over).
   When it doesn't, the stored extranonce2_length may be wrong: the collector before January 2025 could keep a
   previous connection's extranonce values after a reconnect (docs/methodology.md, "Older history"). So the strict
   parse is retried with every other extranonce2 length in EXTRANONCE2_LENGTHS, and the coinbase counts as REPAIRED
   only when exactly one length parses. Otherwise it is UNPARSED. Nothing is guessed: no scanning of coinbase2 for
   where the outputs might start.
   Both outcomes are recorded per pool in the block's analysis (`coinbase_parse`), so they can be counted and
   diagnosed later rather than disappearing into a log.

2. invalid_coinbase_no_merkle: an empty template (no merkle branches, so the coinbase is the only transaction) can't
   pay more than the block subsidy. Checked with the total from (1); an unparsed coinbase isn't checked.
"""
from io import BytesIO
from typing import Any, Dict, List, Optional, Tuple

# Extranonce2 lengths tried when the stored one doesn't reassemble. Stratum pools use 2-8 bytes; 0-16 covers any.
EXTRANONCE2_LENGTHS = range(0, 17)


def reconstruct_coinbase_raw(coinbase1: str, extranonce1: str, extranonce2_length: int, coinbase2: str) -> str:
    try:
        return f"{coinbase1}{extranonce1}{'00' * int(extranonce2_length)}{coinbase2}"
    except Exception:
        return f"{coinbase1}{extranonce1}{coinbase2}"


def parse_tx_total_output_value_sats(coinbase_raw_hex: str) -> Optional[int]:
    """Sum of the outputs of a reassembled coinbase, or None if it isn't a well-formed coinbase transaction (parse
    error; bytes left over / missing because the declared lengths don't match what was reassembled; not exactly one
    null-prevout input; no outputs)."""
    try:
        from bitcoin.core import CTransaction  # local import to avoid hard dep at import-time
    except Exception:
        return None
    try:
        stream = BytesIO(bytes.fromhex(coinbase_raw_hex))
        tx = CTransaction.stream_deserialize(stream)
        if stream.read():  # trailing bytes: the declared lengths didn't line up
            return None
        # A coinbase: exactly one input, spending nothing (null prevout), and at least one output. Without this, a
        # misaligned reassembly can still deserialize (e.g. as zero inputs and zero outputs).
        if len(tx.vin) != 1 or not tx.vin[0].prevout.is_null() or not tx.vout:
            return None
        return sum(int(vout.nValue) for vout in tx.vout)
    except Exception:
        return None


def coinbase_total_output_sats(coinbase1: str, extranonce1: str, extranonce2_length: int,
                               coinbase2: str) -> Tuple[Optional[int], Optional[int]]:
    """(total paid, extranonce2 length that reassembles) for a template's coinbase.

    The stored length first; if that doesn't parse strictly, every other length in EXTRANONCE2_LENGTHS, accepted only
    when exactly one of them parses. (None, None) when none does, or when more than one does (ambiguous)."""
    stored = int(extranonce2_length or 0)
    total = parse_tx_total_output_value_sats(reconstruct_coinbase_raw(coinbase1, extranonce1, stored, coinbase2))
    if total is not None:
        return total, stored
    found = {}
    for n in EXTRANONCE2_LENGTHS:
        if n == stored:
            continue
        t = parse_tx_total_output_value_sats(reconstruct_coinbase_raw(coinbase1, extranonce1, n, coinbase2))
        if t is not None:
            found[n] = t
    if len(found) == 1:
        n, t = next(iter(found.items()))
        return t, n
    return None, None


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


def analyze_coinbases(templates: List[Dict[str, Any]], height: int,
                      logger) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """(invalid_coinbase_no_merkle flag or None, coinbase_parse report or None) for a height's templates.

    The flag: one offender per offending template the pool sent. The input has every collector's rows (several
    collectors per pool see the same template), so exact copies are paired one-to-one per collector (site, replica)
    like the history views: a key counts as many times as the collector that saw it most often, so a pool's own
    identical re-sends still count, a copy from another collector doesn't, and a template only one collector got is
    kept.

    The report, per pool (every collector's rows, so counts are rows, not distinct templates):
      repaired: [{pool_name, stored_extranonce2_length, extranonce2_length, templates}]
      unparsed: [{pool_name, extranonce2_length, templates, sample_job_id}]
    None when every coinbase parsed with its stored length."""
    subsidy = get_block_subsidy_sats(height)
    # key -> {collector: [offender, ...]} in input order
    by_key: Dict[Any, Dict[Any, List[Dict[str, Any]]]] = {}
    repaired: Dict[Tuple[str, int, int], int] = {}
    unparsed: Dict[Tuple[str, int], List[Any]] = {}   # (pool, stored length) -> [count, sample job_id]
    cache: Dict[Tuple[str, str, int, str], Tuple[Optional[int], Optional[int]]] = {}
    for t in templates:
        pool = t.get("pool_name", "unknown")
        coinbase1 = str(t.get("coinbase1", ""))
        coinbase2 = str(t.get("coinbase2", ""))
        extranonce1 = str(t.get("extranonce1", ""))
        stored = int(t.get("extranonce2_length", 0) or 0)
        ck = (coinbase1, extranonce1, stored, coinbase2)
        if ck not in cache:
            cache[ck] = coinbase_total_output_sats(coinbase1, extranonce1, stored, coinbase2)
        total, used = cache[ck]
        if total is None:
            entry = unparsed.setdefault((pool, stored), [0, t.get("job_id")])
            entry[0] += 1
            continue
        if used != stored:
            repaired[(pool, stored, used)] = repaired.get((pool, stored, used), 0) + 1
        merkle_branches = t.get("merkle_branches") or []
        if isinstance(merkle_branches, list) and len(merkle_branches) == 0 and total > subsidy:
            collector = (t.get("site"), t.get("replica"))
            by_key.setdefault(_template_key(t), {}).setdefault(collector, []).append(
                {"pool_name": pool, "total_sats": total, "subsidy_sats": subsidy})

    report = None
    if repaired or unparsed:
        report = {
            "repaired": [{"pool_name": p, "stored_extranonce2_length": s, "extranonce2_length": u, "templates": n}
                         for (p, s, u), n in sorted(repaired.items(), key=lambda kv: (str(kv[0][0]), kv[0][1], kv[0][2]))],
            "unparsed": [{"pool_name": p, "extranonce2_length": s, "templates": n, "sample_job_id": job}
                         for (p, s), (n, job) in sorted(unparsed.items(), key=lambda kv: (str(kv[0][0]), kv[0][1]))],
        }
        if unparsed:
            logger.warning("Analysis(coinbase_parse): %d templates at height %d have a coinbase that doesn't parse with "
                           "any extranonce2 length (not checked): %s", sum(n for n, _ in unparsed.values()), height,
                           ", ".join(sorted({str(p) for p, _ in unparsed})))
        if repaired:
            logger.info("Analysis(coinbase_parse): %d templates at height %d parsed only with another extranonce2 length",
                        sum(repaired.values()), height)

    offenders: List[Dict[str, Any]] = []
    for per_collector in by_key.values():
        offenders.extend(max(per_collector.values(), key=len))
    flag = None
    if offenders:
        logger.warning("Analysis(invalid_coinbase_without_merkle): %d offending templates found at height %d (subsidy=%d)",
                       len(offenders), height, subsidy)
        flag = {"key": "invalid_coinbase_no_merkle", "icon": "error", "details": {"offenders": offenders}}
    return flag, report


def analyze_invalid_coinbase_without_merkle(templates: List[Dict[str, Any]], height: int,
                                            logger) -> Optional[Dict[str, Any]]:
    """The invalid_coinbase_no_merkle flag alone (see analyze_coinbases)."""
    return analyze_coinbases(templates, height, logger)[0]
