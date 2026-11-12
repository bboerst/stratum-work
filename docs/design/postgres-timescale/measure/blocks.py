import json, psycopg
from datetime import datetime, timezone
from pymongo import MongoClient
m = MongoClient("mongodb://drill-mongo:27017")["stratum-logger"]
with psycopg.connect("postgresql://postgres:test@s3-pg-a/postgres", autocommit=True) as c, c.cursor() as cur:
    with cur.copy("COPY blocks (block_hash, height, block_time, coinbase_script_sig, pool_id, mining_pool, analysis) FROM STDIN") as cp:
        n = 0; seen = set(); dups = 0
        for b in m.blocks.find({}).sort("_id", -1):   # newest document per hash wins
            if b["block_hash"] in seen: dups += 1; continue
            seen.add(b["block_hash"])
            mp = b.get("mining_pool") or {}
            pid = mp.get("id"); pid = int(pid) if isinstance(pid, (int, float)) or (isinstance(pid, str) and pid.isdigit()) else None
            cp.write_row((bytes.fromhex(b["block_hash"]), b["height"], datetime.fromtimestamp(b["timestamp"], tz=timezone.utc),
                          bytes.fromhex(b.get("coinbase_script_sig") or ""), pid, json.dumps(mp, default=str),
                          json.dumps(b.get("analysis") or {}, default=str)))
            n += 1
    cur.execute("ANALYZE"); print("blocks loaded:", n, "duplicates skipped:", dups)
