"""Two synthetic "sites" with the public API shapes of web/app/api, for the end-to-end test. Every value is made up.

    python tests/fakesite.py serve --port-a 18081 --port-b 18082     # serve until killed
    python tests/fakesite.py check report.json                         # assert the comparison found what was planted

What is planted (heights 1000–1005 on A, B's blocks from 1001, B's tip 1004; jobs every 30 s per pool):
  - pool-one:   B sees everything 15 ms after A. At 1001 A has one job twice (extra copy on A). At 1003 one job's
                ntime is 1 s later on B (a near miss on both sides).
  - pool-two:   B sees everything 5 ms before A. Missing on B at 1002 (collector down). At 1003 B's first three jobs
                are missing (connected late: before_other_first with --gap-s 25).
  - pool-three: only on A (hidden on B): pool_one_side_only.
  - pool-four:  only on B.
  - blocks:     at 1002 B identifies another pool; at 1004 B's analysis has an extra key.
  - pools list: B lacks "pool-three" and has an extra address for "pool-one".
  - B answers its first request for mining-notify at 1002 with 429 + Retry-After: 1.
"""
from __future__ import annotations

import hashlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HEIGHTS = range(1000, 1006)
TIP = {"a": 1005, "b": 1004}
LOWEST_BLOCK = {"a": 1000, "b": 1001}
T_BASE = 1_893_456_000      # 2030-01-01, seconds
JOBS = 6
STEP_S = 30
SHIFT_MS = {"pool-one": 15.0, "pool-two": -5.0, "pool-three": 0.0, "pool-four": 0.0}   # B minus A
POOL_MS = {"pool-one": 0, "pool-two": 100, "pool-three": 200, "pool-four": 300}        # each pool's own lag


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def block_hash(h: int) -> str:
    return "0000" + sha(f"block {h}")[4:]


def template(side: str, pool: str, h: int, i: int, ntime_shift: int = 0, extra_ms: float = 0.0) -> dict:
    start_s = T_BASE + (h - 1000) * 600
    t_ns = int((start_s + i * STEP_S) * 1e9 + (POOL_MS[pool] + (SHIFT_MS[pool] if side == "b" else 0)) * 1e6 + extra_ms * 1e6)
    en1 = sha(f"{side}{pool}")[:8]
    return {"id": f"{side}-{pool}-{h}-{i}-{extra_ms}", "height": h, "pool_name": pool, "chain_family": None,
            "coinbase1": "01000000" + sha(f"cb1 {pool} {h}")[:40], "coinbase2": sha(f"cb2 {pool}")[:32],
            "merkle_branches": [sha(f"m {pool} {h} {i} {k}") for k in range(3)],
            "version": "20000000", "prev_hash": sha(f"prev {h}"), "timestamp": format(t_ns, "x"),
            "nbits": "17031abc", "ntime": format(start_s + i * STEP_S + ntime_shift, "08x"),
            "clean_jobs": i == 0, "extranonce1": en1, "extranonce2_length": 8, "lat_ms": 1.5, "lat_m": "x"}


def templates(side: str, h: int) -> list[dict]:
    if h not in HEIGHTS or h > TIP[side] + 1:
        return []
    out = []
    pools = ["pool-one", "pool-two", "pool-three"] if side == "a" else ["pool-one", "pool-two", "pool-four"]
    for pool in pools:
        if side == "b" and pool == "pool-two" and h == 1002:
            continue
        for i in range(JOBS):
            if side == "b" and pool == "pool-two" and h == 1003 and i < 3:
                continue
            shift = 1 if (side == "b" and pool == "pool-one" and h == 1003 and i == 2) else 0
            out.append(template(side, pool, h, i, ntime_shift=shift))
            if side == "a" and pool == "pool-one" and h == 1001 and i == 4:
                out.append(template(side, pool, h, i, extra_ms=500))
    return sorted(out, key=lambda t: int(t["timestamp"], 16))


def first_seen(side: str, h: int) -> list[dict]:
    first = {}
    for t in templates(side, h):
        first.setdefault(t["pool_name"], t)
    prev = {t["pool_name"] for t in templates(side, h - 1)}
    items = sorted(first.values(), key=lambda t: int(t["timestamp"], 16))
    return [{"firstSeenTimestamp": t["timestamp"], "firstSeenLatencyMs": 1.5, "poolName": t["pool_name"],
             "reliable": t["pool_name"] in prev} for t in items]


def block(side: str, h: int) -> dict:
    pool = {"id": 7, "name": "Pool Seven", "slug": "pool-seven", "match_type": "tag", "identification_method": "tag"}
    if side == "b" and h == 1002:
        pool = {"id": 8, "name": "Pool Eight", "slug": "pool-eight", "match_type": "tag",
                "identification_method": "tag"}
    analysis = {"pool_identification": {"mining_pool": pool, "method": "tag"}}
    if side == "b" and h == 1004:
        analysis["fork"] = {"kind": "made-up"}
    b = {"block_hash": block_hash(h), "height": h, "coinbase_script_sig": "03" + format(h, "06x"),
         "timestamp": T_BASE + (h - 999) * 600, "mining_pool": pool, "analysis": analysis}
    if side == "a":
        b = {"_id": {"$oid": sha(f"oid {h}")[:24]}, **b, "id": "[object Object]"}
    else:
        b["id"] = b["block_hash"]
    return b


def blocks_route(side: str, q: dict) -> dict:
    n = int(q.get("n", ["20"])[0])
    have = [h for h in HEIGHTS if LOWEST_BLOCK[side] <= h <= TIP[side]]
    if "after" in q:
        after = int(q["after"][0])
        got = [block(side, h) for h in have if h > after and h >= 1][:n]
        return {"blocks": sorted(got, key=lambda b: -b["height"]), "has_more": len(got) == n, "next_height": None}
    got = [block(side, h) for h in sorted(have, reverse=True)][:n]
    return {"blocks": got, "has_more": False, "next_height": got[-1]["height"] if got else None}


def pools_route(side: str) -> list[dict]:
    names = ["pool-one", "pool-two", "pool-three", "pool-four"]
    out = []
    for i, name in enumerate(names):
        if side == "b" and name == "pool-three":
            continue
        addrs = [f"addr-{name}"] + (["addr-extra"] if side == "b" and name == "pool-one" else [])
        out.append({"id": sha(f"pid {i}")[:24] if side == "a" else str(i + 1), "name": name, "tag": None,
                    "addresses": addrs})
    return out


def interesting_route(side: str) -> dict:
    return {"items": [{"block_hash": block_hash(1003), "height": 1003,
                       "analysis": {"pool_identification": {"method": "tag"}, "fork": {"kind": "made-up"}}}]}


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.requests = {"a": 0, "b": 0}
        self.throttled = set()


def handler_for(side: str, state: State):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, status: int, body, headers=()):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            for k, v in headers:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            u = urlsplit(self.path)
            q = parse_qs(u.query)
            with state.lock:
                state.requests[side] += 1
                throttle = side == "b" and u.path == "/api/mining-notify" and q.get("height") == ["1002"] \
                    and "mn1002" not in state.throttled
                if throttle:
                    state.throttled.add("mn1002")
            if throttle:
                return self.send(429, {"error": "slow down"}, [("Retry-After", "1")])
            h = int(q["height"][0]) if "height" in q else None
            if u.path == "/api/blocks":
                return self.send(200, blocks_route(side, q))
            if u.path == "/api/mining-notify":
                return self.send(200, templates(side, h))
            if u.path == "/api/block-pool-first-seen":
                return self.send(200, first_seen(side, h))
            if u.path == "/api/pools":
                return self.send(200, pools_route(side))
            if u.path == "/api/analysis-data" and q.get("interesting") == ["true"]:
                return self.send(200, interesting_route(side))
            return self.send(404, {"error": "not found"})
    return H


def start(port_a: int = 0, port_b: int = 0):
    """Start both sites in background threads. Returns (url_a, url_b, state, stop)."""
    state = State()
    servers = [ThreadingHTTPServer(("127.0.0.1", p), handler_for(s, state)) for s, p in (("a", port_a), ("b", port_b))]
    for srv in servers:
        threading.Thread(target=srv.serve_forever, daemon=True).start()

    def stop():
        for srv in servers:
            srv.shutdown()
            srv.server_close()
    urls = [f"http://127.0.0.1:{srv.server_address[1]}" for srv in servers]
    return urls[0], urls[1], state, stop


def check(path: str) -> int:
    """Assert the planted differences were found; print PASS/FAIL lines. Exit status = failures."""
    r = json.load(open(path))
    pools = {p["pool"]: p for p in r["templates"]["pools"]}
    blocks = {(d["height"], d["kind"]) for d in r["blocks"]["differences"]}
    checks = [
        ("range is 1000–1004 (B's templates below its lowest block, up to the lower tip)",
         (r["meta"]["from"], r["meta"]["to"]) == (1000, 1004)),
        ("pool-one: extra copy on A at 1001", pools["pool-one"]["only_a"].get("extra_copy") == 1),
        ("pool-one: near miss in ntime on both sides",
         pools["pool-one"]["only_a"].get("near_miss:ntime") == 1 and pools["pool-one"]["only_b"].get("near_miss:ntime") == 1),
        ("pool-one: first-seen delta +15 ms", pools["pool-one"]["first_seen_delta_ms"]["p50"] == 15.0),
        ("pool-two: first-seen delta -5 ms, B first", pools["pool-two"]["first_seen_delta_ms"]["p50"] == -5.0
         and pools["pool-two"]["first_seen_delta_ms"]["b_earlier_share"] == 1.0),
        ("pool-two: missing on B at 1002", pools["pool-two"]["only_a"].get("pool_missing_at_height") == JOBS),
        ("pool-two: B connected late at 1003", pools["pool-two"]["only_a"].get("before_other_first") == 3),
        ("pool-three only on A", r["templates"]["pools_only_on_a"] == ["pool-three"]
         and pools["pool-three"]["only_a"].get("pool_one_side_only") == 5 * JOBS),
        ("pool-four only on B", r["templates"]["pools_only_on_b"] == ["pool-four"]),
        ("nothing unexplained", not r["templates"]["unexplained_examples"]),
        ("block 1002: pool identification differs", (1002, "fields differ (pool_identification)") in blocks),
        ("block 1004: analysis differs", (1004, "fields differ (analysis)") in blocks),
        ("block 1000: only on A", (1000, "block only on A") in blocks),
        ("blocks 1001 and 1003 identical", r["blocks"]["summary"].get("identical") == 2),
        ("pools list: pool-three only on A", r["pools_list"]["only_a"] == ["pool-three"]),
        ("pools list: pool-one addresses differ",
         [d["name"] for d in r["pools_list"]["field_differences"]] == ["pool-one"]),
        ("R4: pool sets differ on every height", r["first_seen"]["same_pool_set"] == 0),
        ("R4: the common pools' order is the same everywhere",
         r["first_seen"]["same_order_of_common_pools"] == r["first_seen"]["n"]),
        ("R4: pool-two's first seen is -5 ms", pools["pool-two"]["r4_first_seen_delta_ms"]["p50"] == -5.0),
        ("the 429 was retried", r["meta"]["requests"]["retries"] >= 1),
    ]
    bad = 0
    for name, ok in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
        bad += not ok
    return bad


if __name__ == "__main__":
    if sys.argv[1:2] == ["serve"]:
        import argparse
        p = argparse.ArgumentParser()
        p.add_argument("cmd")
        p.add_argument("--port-a", type=int, required=True)
        p.add_argument("--port-b", type=int, required=True)
        args = p.parse_args()
        start(args.port_a, args.port_b)
        threading.Event().wait()
    elif sys.argv[1:2] == ["check"]:
        sys.exit(check(sys.argv[2]))
    else:
        print(__doc__)
        sys.exit(2)
