from typing import Any, Dict, List, Optional
from io import BytesIO


def reconstruct_coinbase_raw(coinbase1: str, extranonce1: str, extranonce2_length: int, coinbase2: str) -> str:
    try:
        return f"{coinbase1}{extranonce1}{'00' * int(extranonce2_length)}{coinbase2}"
    except Exception:
        return f"{coinbase1}{extranonce1}{coinbase2}"


def parse_tx_total_output_value_sats(coinbase_raw_hex: str):
    try:
        from bitcoin.core import CTransaction  # local import to avoid hard dep at import-time
    except Exception:
        CTransaction = None
    if not CTransaction:
        return 0
    try:
        stream = BytesIO(bytes.fromhex(coinbase_raw_hex))
        tx = CTransaction.stream_deserialize(stream)
        total = 0
        for vout in tx.vout:
            try:
                total += int(vout.nValue)
            except Exception:
                continue
        return total
    except Exception:
        return 0


def get_block_subsidy_sats(height: int) -> int:
    halvings = height // 210000
    if halvings >= 64:
        return 0
    base = 50 * 100_000_000
    return base >> halvings


def analyze_invalid_coinbase_without_merkle(templates: List[Dict[str, Any]], height: int, logger) -> Optional[Dict[str, Any]]:
    subsidy = get_block_subsidy_sats(height)
    offenders: List[Dict[str, Any]] = []
    for t in templates:
        merkle_branches = t.get("merkle_branches") or []
        if isinstance(merkle_branches, list) and len(merkle_branches) == 0:
            coinbase1 = str(t.get("coinbase1", ""))
            coinbase2 = str(t.get("coinbase2", ""))
            extranonce1 = str(t.get("extranonce1", ""))
            extranonce2_length = int(t.get("extranonce2_length", 0) or 0)
            raw = reconstruct_coinbase_raw(coinbase1, extranonce1, extranonce2_length, coinbase2)
            total = parse_tx_total_output_value_sats(raw)
            if total > subsidy:
                offenders.append(
                    {
                        "pool_name": t.get("pool_name", "unknown"),
                        "total_sats": total,
                        "subsidy_sats": subsidy,
                    }
                )
    if not offenders:
        return None
    logger.warning(
        "Analysis(invalid_coinbase_without_merkle): %d offending templates found at height %d (subsidy=%d)",
        len(offenders),
        height,
        subsidy,
    )
    return {"key": "invalid_coinbase_no_merkle", "icon": "error", "details": {"offenders": offenders}}


