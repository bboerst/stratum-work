"""site-compare: does site B show the same data as site A? Read-only, through the public HTTP APIs only.

    python -m site_compare --a https://site-a.example --b https://site-b.example --cache ./cache \
        --out report.md --json report.json

Compares, for every height from the first one B has data for up to the lower of the two tips: blocks (hash, pool
identification, analysis, coinbase), templates per pool and height matched by job key (with first-seen deltas and a
classification of everything found on one side only), first seen per block, the pools list and the interesting
blocks. Requests are rate limited (default 2/s), retried with backoff (Retry-After honored), cached on disk under
--cache (reruns resume) and capped by --max-requests.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone

from .api import Site
from .compare import compare_blocks, compare_first_seen, compare_interesting, compare_pools, compare_templates
from .fetch import Fetcher, FetchError, MaxRequestsExceeded, RateLimiter
from .report import render, to_json


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="site_compare", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--a", required=True, help="base URL of site A (the reference), e.g. https://site-a.example")
    p.add_argument("--b", required=True, help="base URL of site B (the one being checked)")
    p.add_argument("--from", dest="start", type=int,
                   help="first height (default: the first height B has blocks or templates for)")
    p.add_argument("--to", dest="end", type=int, help="last height (default and maximum: the lower of the two tips)")
    p.add_argument("--probe-down", type=int, default=10,
                   help="default start: also look up to this many heights below B's lowest block for templates "
                        "(default: 10)")
    p.add_argument("--gap-s", type=float, default=60.0,
                   help="seconds without a template from a pool that count as a time gap (default: 60)")
    p.add_argument("--rate", type=float, default=2.0, help="requests per second, both sites together (default: 2)")
    p.add_argument("--burst", type=int, default=1, help="requests allowed at once after idling (default: 1)")
    p.add_argument("--max-requests", type=int, default=2000,
                   help="stop after this many network requests, retries included (default: 2000)")
    p.add_argument("--retries", type=int, default=6, help="retries per request on 429/5xx/network errors (default: 6)")
    p.add_argument("--timeout", type=float, default=90.0, help="seconds per request (default: 90)")
    p.add_argument("--cache", help="directory for cached responses (heights at or below both tips): reruns resume")
    p.add_argument("--refresh", action="store_true", help="refetch even what is in the cache (and update it)")
    p.add_argument("--out", help="write the Markdown report here (default: stdout)")
    p.add_argument("--json", dest="json_out", help="write the full result as JSON here")
    p.add_argument("--quiet", action="store_true", help="no progress on stderr")
    return p


def log(quiet: bool, msg: str) -> None:
    if not quiet:
        print(msg, file=sys.stderr, flush=True)


def first_height(b: Site, probe_down: int, quiet: bool) -> tuple[int | None, str]:
    low = b.lowest_block()
    if low is None:
        return None, "B has no blocks"
    start, reason = low, "B's lowest block"
    for h in range(low - 1, max(0, low - probe_down) - 1, -1):
        if not b.templates(h, cacheable=False):
            break
        start, reason = h, "B's lowest template height (below its lowest block)"
    log(quiet, f"B's data starts at {start} ({reason})")
    return start, reason


def run(a: Site, b: Site, args, fetcher: Fetcher) -> dict:
    t0 = time.monotonic()
    tip_a, tip_b = a.tip(), b.tip()
    if tip_a is None or tip_b is None:
        raise SystemExit(f"no tip: A {tip_a}, B {tip_b}")
    tip = min(tip_a, tip_b)
    if args.start is not None:
        start, reason = args.start, "--from"
    else:
        start, reason = first_height(b, args.probe_down, args.quiet)
        if start is None:
            raise SystemExit(reason)
    end = min(args.end, tip) if args.end is not None else tip
    if args.end is not None and args.end > tip:
        log(args.quiet, f"--to {args.end} is above the lower tip {tip}; stopping at {tip}")
    reason += f", up to {'--to' if end == args.end else 'the lower tip'}"
    heights = list(range(start, end + 1))
    log(args.quiet, f"tips A {tip_a}, B {tip_b}; comparing {start}–{end} ({len(heights)} heights)")

    blocks = {"a": a.blocks(start, end, tip), "b": b.blocks(start, end, tip)}
    templates, first_seen = {}, {}
    for i, h in enumerate(heights):
        templates[h] = (a.templates(h, True), b.templates(h, True))
        first_seen[h] = (a.first_seen(h, True), b.first_seen(h, True))
        log(args.quiet, f"  {h}: templates A {len(templates[h][0])}, B {len(templates[h][1])} "
                        f"[{i + 1}/{len(heights)}, {fetcher.stats.network} requests]")
    pools = (a.pools(), b.pools())
    interesting = (a.interesting(), b.interesting())

    tpl = compare_templates(templates, gap_s=args.gap_s)
    result = {
        "meta": {"a": a.base, "b": b.base, "tip_a": tip_a, "tip_b": tip_b, "from": start, "to": end,
                 "heights": len(heights), "range_reason": reason, "gap_s": args.gap_s, "rate": args.rate,
                 "generated": datetime.now(timezone.utc).isoformat(timespec="seconds")},
        "blocks": compare_blocks(blocks["a"], blocks["b"], heights),
        "templates": tpl,
        "first_seen": compare_first_seen(first_seen, tpl["pools"]),
        "pools_list": compare_pools(*pools),
        "interesting": compare_interesting(*interesting, start, end),
    }
    result["meta"]["run_time_s"] = round(time.monotonic() - t0, 1)
    result["meta"]["requests"] = fetcher.stats.as_dict()
    return result


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    if args.rate > 5:
        print("--rate above 5/s exceeds the sites' per-client limit", file=sys.stderr)
        return 2
    fetcher = Fetcher(RateLimiter(args.rate, args.burst), cache_dir=args.cache, max_requests=args.max_requests,
                      retries=args.retries, timeout=args.timeout, refresh=args.refresh)
    try:
        a, b = Site("a", args.a, fetcher), Site("b", args.b, fetcher)
        result = run(a, b, args, fetcher)
    except ValueError as e:
        print(e, file=sys.stderr)
        return 2
    except MaxRequestsExceeded as e:
        print(f"stopped: {e}; {fetcher.stats.as_dict()}", file=sys.stderr)
        return 3
    except FetchError as e:
        print(f"request failed: {e}", file=sys.stderr)
        return 4
    md = render(result)
    if args.out:
        with open(args.out, "w") as f:
            f.write(md + "\n")
    else:
        print(md)
    if args.json_out:
        with open(args.json_out, "w") as f:
            json.dump(to_json(result), f, indent=1, default=sorted)
    log(args.quiet, f"done: {result['meta']['requests']['network_requests']} requests, "
                    f"{result['meta']['run_time_s']} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
