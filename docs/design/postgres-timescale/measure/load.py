"""Section 3 measurement: convert a restored MongoDB sample into both schema candidates.

Prototype of the migration tool (design doc section 5): height re-derivation, routing, lossless conversion,
dedup, COPY, plus a byte-exact round-trip check. Prints JSON-ish stats for the design doc.
"""
import bisect, hashlib, json, random, re, sys, time
from collections import Counter
from datetime import datetime, timezone

import psycopg
from pymongo import MongoClient

sys.path.insert(0, "/work")
from coinbase import parse_bip34_height  # the fixed collector parser (#108)

HEX = re.compile(r"^(?:[0-9a-f]{2})*$")          # lowercase, even length
HEX_ANY = re.compile(r"^[0-9a-fA-F]*$")
mongo = MongoClient("mongodb://drill-mongo:27017")["stratum-logger"]
SITE = "old-cluster"
stats = Counter()

# ── Bitcoin tip at any moment, from blocks (header time; good enough for a tip-6..tip+2 window) ──
blocks = sorted((b["timestamp"], b["height"]) for b in mongo.blocks.find({}, {"timestamp": 1, "height": 1}))
b_times = [t for t, _ in blocks]
running_max, tip_by_idx = 0, []
for _, h in blocks:
    running_max = max(running_max, h); tip_by_idx.append(running_max)
def tip_at(ts_sec: float):
    i = bisect.bisect_right(b_times, ts_sec) - 1
    return tip_by_idx[i] if i >= 0 else None

# ── Read + check losslessness ──
t0 = time.time()
docs = list(mongo.mining_notify.find({}))
stats["mongo_docs"] = len(docs)
hex_fields = ["prev_hash", "coinbase1", "coinbase2", "extranonce1", "version", "nbits", "ntime"]
for d in docs:
    for f in hex_fields:
        v = d.get(f, "")
        if not HEX.match(v):
            stats[f"nonlossless_{f}"] += 1
            stats[f"nonlossless_{f}_{'case' if HEX_ANY.match(v) and len(v) % 2 == 0 else 'shape'}"] += 1
    for br in d.get("merkle_branches", []):
        if not HEX.match(br) or len(br) != 64:
            stats["nonlossless_merkle_branch"] += 1
    if len(d.get("prev_hash", "")) != 64: stats["prev_hash_not_32_bytes"] += 1
    for f in ("version", "nbits", "ntime"):
        if len(d.get(f, "")) != 8: stats[f"{f}_not_4_bytes"] += 1

# ── Convert + route ──
sources, rows_btc, rows_other, keys = {}, [], [], set()
branch_sets = {}   # digest -> (id, branches, first_ts, first_src)
reasons = Counter()
for d in docs:
    ns = int(d["timestamp"], 16)
    received = datetime.fromtimestamp(ns // 1000 / 1e6, tz=timezone.utc)   # µs precision
    src = sources.setdefault(d.get("pool_name") or "", len(sources) + 1)
    key = (src, ns // 1000, d["job_id"])
    if key in keys:
        stats["duplicates_dropped"] += 1; continue
    keys.add(key)
    height = parse_bip34_height(d["coinbase1"])
    tip = tip_at(ns / 1e9)
    if d.get("chain_family"):
        reason = d["chain_family"] if d["chain_family"] in ("bch",) else "unknown_chain"
    elif height is None:
        reason = "height_parse_failed"
    elif tip is not None and not (tip - 6 <= height <= tip + 2):
        reason = "height_implausible"
    else:
        reason = None
    branches = b"".join(bytes.fromhex(b) for b in d.get("merkle_branches", []))
    digest = hashlib.sha256(branches).digest()
    if digest not in branch_sets:
        branch_sets[digest] = (len(branch_sets) + 1, branches, received, src)
    row = dict(received_at=received, source_id=src, height=height or 0, job_id=d["job_id"],
               prev_hash=bytes.fromhex(d["prev_hash"]), coinbase1=bytes.fromhex(d["coinbase1"]),
               coinbase2=bytes.fromhex(d["coinbase2"]), merkle_branches=branches,
               merkle_set_id=branch_sets[digest][0], version=int(d["version"], 16), nbits=int(d["nbits"], 16),
               ntime=int(d["ntime"], 16), clean_jobs=bool(d["clean_jobs"]), extranonce1=bytes.fromhex(d["extranonce1"]),
               extranonce2_length=int(d["extranonce2_length"]), latency_ms=d.get("lat_ms"), latency_method=d.get("lat_m"),
               _orig=d)
    if reason:
        reasons[reason] += 1; row["chain"] = "bch" if reason == "bch" else "unknown"; row["reason"] = reason
        rows_other.append(row)
    else:
        rows_btc.append(row)
stats["templates_btc"] = len(rows_btc); stats["templates_other"] = len(rows_other)
stats["distinct_merkle_branch_sets"] = len(branch_sets); stats["sources"] = len(sources)
stats["convert_seconds"] = round(time.time() - t0, 1)
btc_times = sorted(r["received_at"] for r in rows_btc)
span_days = (btc_times[-1] - btc_times[0]).total_seconds() / 86400
heights = Counter(r["height"] for r in rows_btc)

COLS = ["received_at", "source_id", "height", "job_id", "prev_hash", "coinbase1", "coinbase2", "{merkle}", "version",
        "nbits", "ntime", "clean_jobs", "extranonce1", "extranonce2_length", "latency_ms", "latency_method"]

def load(dsn, merkle_col):
    cols = [c.replace("{merkle}", merkle_col) for c in COLS]
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute("SET timescaledb.enable_chunk_skipping = on")
        with c.cursor() as cur:
            with cur.copy("COPY sources (name, site) FROM STDIN") as cp:
                for name, _ in sorted(sources.items(), key=lambda kv: kv[1]): cp.write_row((name, SITE))
            if merkle_col == "merkle_set_id":
                with cur.copy("COPY merkle_branch_sets (digest, branches, first_seen_at, first_source_id) FROM STDIN") as cp:
                    for digest, (i, br, ts, s) in sorted(branch_sets.items(), key=lambda kv: kv[1][0]): cp.write_row((digest, br, ts, s))
            t = time.time()
            for table, rows, extra in (("templates", rows_btc, []), ("templates_other", rows_other, ["chain", "reason"])):
                with cur.copy(f"COPY {table} ({', '.join(cols + extra)}) FROM STDIN") as cp:
                    for r in sorted(rows, key=lambda r: r["received_at"]):
                        cp.write_row([r[k] for k in cols + extra])   # rows carry both merkle representations
            copy_s = time.time() - t
        return round(copy_s, 2)

res = {}
for name, dsn, col in (("A", "postgresql://postgres:test@s3-pg-a/postgres", "merkle_branches"),
                       ("B", "postgresql://postgres:test@s3-pg-b/postgres", "merkle_set_id")):
    res[name] = {"copy_seconds": load(dsn, col)}
    res[name]["copy_rows_per_s"] = int((len(rows_btc) + len(rows_other)) / max(res[name]["copy_seconds"], 0.001))

# ── Byte-exact round trip on 10,000 random BTC templates (candidate A) ──
sample = random.Random(42).sample(rows_btc, min(10000, len(rows_btc)))
mismatch = Counter()
src_names = {v: k for k, v in sources.items()}
with psycopg.connect("postgresql://postgres:test@s3-pg-a/postgres") as c:
    for r in sample:
        o = r["_orig"]
        row = c.execute("""SELECT encode(prev_hash,'hex'), encode(coinbase1,'hex'), encode(coinbase2,'hex'), encode(merkle_branches,'hex'),
                                  lpad(to_hex(version),8,'0'), lpad(to_hex(nbits),8,'0'), lpad(to_hex(ntime),8,'0'), clean_jobs,
                                  encode(extranonce1,'hex'), extranonce2_length, job_id, latency_ms, latency_method::text, s.name
                           FROM templates t JOIN sources s ON s.id = t.source_id
                           WHERE t.source_id=%s AND t.received_at=%s AND t.job_id=%s""",
                        (r["source_id"], r["received_at"], r["job_id"])).fetchone()
        if row is None: mismatch["missing"] += 1; continue
        expect = (o["prev_hash"], o["coinbase1"], o["coinbase2"], "".join(o.get("merkle_branches", [])), o["version"], o["nbits"],
                  o["ntime"], bool(o["clean_jobs"]), o["extranonce1"], int(o["extranonce2_length"]), o["job_id"],
                  o.get("lat_ms"), o.get("lat_m"), o.get("pool_name") or "")
        for i, (a, b) in enumerate(zip(row, expect)):
            if (a != b) and not (isinstance(b, float) and a is not None and abs(a - b) < 1e-3 * max(1, abs(b))):
                mismatch[f"field_{i}"] += 1

out = dict(stats=dict(stats), routing=dict(reasons), btc_span_days=round(span_days, 3), btc_heights=len(heights),
           templates_per_height_median=sorted(heights.values())[len(heights) // 2], load=res,
           roundtrip_checked=len(sample), roundtrip_mismatches=dict(mismatch),
           sample_height=sorted(heights)[len(heights) // 2])
print(json.dumps(out, indent=1, default=str))
