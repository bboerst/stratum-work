from typing import Any, Dict, List, Optional


def analyze_prev_hash_divergence(templates: List[Dict[str, Any]], logger) -> Optional[Dict[str, Any]]:
    prev_to_pools: Dict[str, List[str]] = {}
    for t in templates:
        prev = str(t.get("prev_hash", "")).lower()
        pool = str(t.get("pool_name", "unknown"))
        if not prev:
            continue
        prev_to_pools.setdefault(prev, []).append(pool)
    if len(prev_to_pools) <= 1:
        return None
    logger.info("Analysis(prev_hash_divergence): %d distinct prev_hash values found", len(prev_to_pools))
    return {
        "key": "prev_hash_fork",
        "icon": "fork",
        "details": {
            "groups": [
                {"prev_hash": k, "pools": sorted(list(set(v)))} for k, v in prev_to_pools.items()
            ]
        },
    }


