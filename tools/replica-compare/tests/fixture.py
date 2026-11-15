"""Synthetic database fixture for test-e2e.sh.

    python tests/fixture.py load            # insert sources + templates (libpq env, as the owner)
    python tests/fixture.py check out.json  # the tool's JSON output matches what was loaded
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))   # the replica_compare package
from helpers import T0, template  # noqa: E402

POOL1, POOL2 = "pool-one", "pool-two"


def rows():
    """pool-one: replicas a and b, 30 jobs 10 s apart, b 7 ms behind, a 2-byte per-session tag in the scriptSig;
    b misses job 12. One extra template is a non-Bitcoin one (templates_other). pool-two: replica a only."""
    out = []
    for i in range(30):
        merkle = bytes([i]) * 32
        for r, en1, dt, tag in (("a", b"\x01\x02\x03\x04", 0, b"\x10\x01"), ("b", b"\x05\x06\x07\x08", 7, b"\x20\x02")):
            if r == "b" and i == 12:
                continue
            out.append((POOL1, "btc", template(r, i * 10_000 + dt, merkle=merkle, en1=en1, sig_pre=b"/p/" + tag,
                                               job_id=f"{r}{i}", ntime=1_893_456_000 + i * 10)))
    out.append((POOL1, "bch", template("a", 5_000, prev=b"\x44" * 32, height=6_000_000)))
    for i in range(5):
        out.append((POOL2, "btc", template("a", i * 10_000, merkle=bytes([i]) * 32)))
    return out


def load():
    import psycopg
    with psycopg.connect() as c:
        ids = {}
        for pool, _, t in rows():
            if (pool, t.replica) not in ids:
                ids[(pool, t.replica)] = c.execute(
                    "INSERT INTO sources (name, site, replica) VALUES (%s, 'test', %s) RETURNING id",
                    (pool, t.replica)).fetchone()[0]
        for pool, chain, t in rows():
            cols = ("received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, "
                    "version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length")
            vals = [t.received_at, ids[(pool, t.replica)], t.height, t.job_id, t.prev_hash, t.coinbase1, t.coinbase2,
                    t.merkle_branches, t.version, t.nbits, t.ntime, t.clean_jobs, t.extranonce1, t.extranonce2_length]
            if chain == "btc":
                c.execute(f"INSERT INTO templates ({cols}) VALUES ({', '.join(['%s'] * 14)})", vals)
            else:
                c.execute(f"INSERT INTO templates_other ({cols}, chain, reason) VALUES "
                          f"({', '.join(['%s'] * 14)}, %s, 'bch')", vals + [chain])
    print(f"loaded {len(rows())} templates")


def check(path: str) -> int:
    res = json.load(open(path))["pools"]
    p1, p2 = res[POOL1], res[POOL2]
    k1 = p1["job_keys"]["prev_hash+merkle+version+nbits"]
    tag = p1["coinbase"]["fields"][0]
    checks = {
        "pool-two skipped (one replica)": "skipped" in p2,
        "pool-one counts": p1["templates"] == {"a": 31, "b": 29} and p1["chains"] == {"btc": 59, "bch": 1},
        "pool-one pairs": p1["pairs"] == 29,
        "job key matches all but one": (k1["matched"], k1["only_a"], k1["only_b"]) == (29, 2, 0),
        "a always first by 7 ms": k1["a_first"] == 29 and abs(k1["offset_ms"]["p50"] - 7) < 0.01,
        "outputs identical": p1["coinbase"]["outputs_identical"] == 29,
        "tag located": (tag["region"], tag["from_start"], tag["length"]) == ("sig_pre", 7, 2),
        "tag classified": tag["classification"]["label"].startswith("per-session constant"),
        "window respected": T0.isoformat()[:10] in json.load(open(path))["meta"]["since"],
    }
    for name, ok in checks.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    return 0 if all(checks.values()) else 1


if __name__ == "__main__":
    if sys.argv[1] == "load":
        load()
    else:
        sys.exit(check(sys.argv[2]))
