"""Re-run the coinbase analysis (analytics/invalid_coinbase_no_merkle.py) over stored blocks.

The backend analyzes a height once, when it stores the block. Blocks stored before an analyzer change, and the history
converted from the earlier database (which never ran it), keep what they had. This brings them up to date: for every
stored height in [--from, --to], it reads the height's templates, runs analyze_coinbases, and sets the result on every
block row at that height (the invalid_coinbase_no_merkle flag and `coinbase_parse`; nothing else in `analysis` is
touched). Idempotent: a height whose result hasn't changed isn't written.

    python -m coinbase_reanalysis [--from HEIGHT] [--to HEIGHT] [--dry-run]

Prints a JSON summary: heights read, blocks changed, flags added / removed / changed (with heights and pools), and the
repaired / unparsed template counts per pool. Runs as the backend role (UPDATE on blocks).
"""
import argparse
import importlib.util
import json
import logging
import pathlib
import sys
import time
from typing import Any, Dict, List, Optional

from analytics.invalid_coinbase_no_merkle import analyze_coinbases

logger = logging.getLogger("backend.coinbase_reanalysis")
PROGRESS_EVERY = 500


def _pools(flag: Optional[Dict[str, Any]]) -> List[str]:
    offenders = ((flag or {}).get("details") or {}).get("offenders") or []
    return sorted({str(o.get("pool_name")) for o in offenders})


def reanalyze(store: Any, heights: List[int], dry_run: bool = False) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "dry_run": dry_run, "heights": len(heights), "heights_with_templates": 0, "blocks_changed": 0,
        "flags_added": [], "flags_removed": [], "flags_changed": [],
        "repaired_templates": {}, "unparsed_templates": {}, "seconds": 0.0,
    }
    started = time.monotonic()
    for i, height in enumerate(heights, 1):
        templates = store.templates_at_height(height)
        if templates:
            summary["heights_with_templates"] += 1
        flag, report = analyze_coinbases(templates, height, logger) if templates else (None, None)
        for kind in ("repaired", "unparsed"):
            for r in (report or {}).get(kind, []):
                totals = summary[f"{kind}_templates"]
                totals[r["pool_name"]] = totals.get(r["pool_name"], 0) + r["templates"]
        changed = store.update_coinbase_analysis(height, flag, report, dry_run=dry_run)
        summary["blocks_changed"] += len(changed)
        for ch in changed:
            before, after = ch["before_flag"], ch["after_flag"]
            entry = {"height": height, "block_hash": ch["block_hash"]}
            if before is None and after is not None:
                summary["flags_added"].append({**entry, "pools": _pools(after)})
            elif before is not None and after is None:
                summary["flags_removed"].append({**entry, "pools": _pools(before)})
            elif before != after:
                summary["flags_changed"].append({**entry, "pools_before": _pools(before), "pools_after": _pools(after)})
        if i % PROGRESS_EVERY == 0:
            logger.info("%d/%d heights (at %d), %d blocks changed, %.0f s", i, len(heights), height,
                        summary["blocks_changed"], time.monotonic() - started)
    summary["seconds"] = round(time.monotonic() - started, 1)
    return summary


def _postgres_store() -> Any:
    # integrations/__init__.py connects to the configured store and to RabbitMQ at import; this needs neither, so
    # load the store module on its own.
    path = pathlib.Path(__file__).resolve().parent / "integrations" / "store.py"
    spec = importlib.util.spec_from_file_location("coinbase_reanalysis_store", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PostgresStore.from_env()


def main(argv: Optional[List[str]] = None, store: Any = None) -> int:
    p = argparse.ArgumentParser(prog="python -m coinbase_reanalysis", description=__doc__.split("\n\n")[0])
    p.add_argument("--from", dest="h_from", type=int, help="first height (default: the lowest stored block)")
    p.add_argument("--to", dest="h_to", type=int, help="last height (default: the highest stored block)")
    p.add_argument("--dry-run", action="store_true", help="compute and report, write nothing")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr)
    store = store or _postgres_store()
    low, high = store.block_height_range()
    if low is None:
        print(json.dumps({"heights": 0, "note": "no blocks"}))
        return 0
    h_from = args.h_from if args.h_from is not None else low
    h_to = args.h_to if args.h_to is not None else high
    heights = sorted(store.block_heights_between(h_from, h_to + 1))
    print(json.dumps(reanalyze(store, heights, dry_run=args.dry_run), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
