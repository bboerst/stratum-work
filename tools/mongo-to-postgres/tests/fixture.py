"""Synthetic MongoDB history for the end-to-end test (test-e2e.sh): everything the live data doesn't have.

    python tests/fixture.py load     # MONGO_URI, MONGO_DB: write the fixture into an EMPTY throwaway database
    python tests/fixture.py check verify.json   # PG* env: assert the migration handled every case

Two UTC days (2024-11-11/12), three sources, blocks 870,000-870,048 every 10 minutes from 2024-11-11 20:00, and:
  * naive-ISO timestamps (< 870,020), ISO with a -06:00 offset incl. one whose UTC day differs from its date prefix
    (870,020-870,030), hex ns (>= 870,031), BSON datetimes (870,044, PoolC)
  * a height recorded 6 h behind UTC (870,012) -> corrected, offset -21600, listed
  * stale templates replayed 12 h late (870,014) -> height_implausible, NOT a timezone correction
  * blocks 870,025/870,026 with header times 25/15 min after they arrived -> templates at 870,027 still Bitcoin
    (prev_hash evidence; header times alone would make them tip + 3)
  * an identical duplicate and a differing duplicate (PoolB, 870,035); a duplicate block document (870,010)
  * chain_family bch / unknown, an impossible height (6,976,415), a BIP34 parse failure, an upper-case hex document
  * a collection outage: no templates at 870,040-870,042 (declared as a known gap)
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[1])]
from helpers import coinbase1, doc, hex_ts, iso_naive   # noqa: E402

UTC = timezone.utc
H0, H1 = 870_000, 870_048
T0 = datetime(2024, 11, 11, 20, 0, tzinfo=UTC)
SOURCES = ("PoolA", "PoolB", "PoolC")
OFFSETS_S = (2, 60, 200, 400)
SHIFT_6H, STALE, DUP_H, BSON_H = 870_012, 870_014, 870_035, 870_044
LATE_HEADERS = {870_025: timedelta(minutes=25), 870_026: timedelta(minutes=15)}   # header time after arrival
LATE_TEST_H = 870_027   # header times alone put the tip at 870,024 when these arrive: tip + 3
GAP = range(870_040, 870_043)
MDT = timezone(timedelta(hours=-6))


def bhash(h: int) -> str:
    return "0000000000" + hashlib.sha256(str(h).encode()).hexdigest()[10:]


def stratum(hex_hash: str) -> str:
    w = [hex_hash[i:i + 8] for i in range(0, 64, 8)]
    return "".join(reversed(w))


def arrival(h: int) -> datetime:
    return T0 + timedelta(minutes=10 * (h - H0))


def header_time(h: int) -> datetime:
    return arrival(h) + LATE_HEADERS.get(h, timedelta(0))


def fmt_for(h: int, src: str, true: datetime):
    if h == SHIFT_6H:
        return iso_naive(true - timedelta(hours=6))         # local time stored without an offset
    if h < 870_020:
        return iso_naive(true)
    if h <= 870_030:
        return true.astimezone(MDT).isoformat()              # e.g. 2024-11-11T18:12:00-06:00 = 2024-11-12 UTC
    if h == BSON_H and src == "PoolC":
        return true.replace(tzinfo=None)                     # BSON datetime (ms precision)
    return hex_ts(true)


def build():
    blocks = []
    for h in range(H0, H1 + 1):
        blocks.append(dict(height=h, block_hash=bhash(h), timestamp=int(header_time(h).timestamp()),
                           coinbase_script_sig="03" + h.to_bytes(3, "little").hex() + "2f6d32702f",
                           mining_pool={"id": 7, "name": "Example", "slug": "example"},
                           analysis={"pool_identification": {"method": "tag"}, **({"note": "x"} if h % 7 == 0 else {})}))
    blocks.append(dict(blocks[10 - 0]))   # height 870,010 stored twice, as in production
    docs, n = [], 0

    def add(d):
        nonlocal n
        n += 1
        d["_id"] = f"fx-{n:05d}"
        docs.append(d)
        return d

    for h in range(H0 + 1, H1 + 1):
        if h in GAP:
            continue
        for src in SOURCES:
            for i, off in enumerate(OFFSETS_S):
                true = arrival(h - 1) + timedelta(seconds=off, microseconds=1000 * (SOURCES.index(src) + 1))
                if h == BSON_H and src == "PoolC":
                    true = true.replace(microsecond=(true.microsecond // 1000) * 1000)
                add(doc(None, fmt_for(h, src, true), height=h, source=src, job_id=f"{h}-{src}-{i}",
                        prev_hash=stratum(bhash(h - 1)), ntime=true - timedelta(seconds=3), lat_ms=12.5 + i))
    # stale replays, 12 h late (production saw +12 h / +94 h at single heights)
    for i in range(2):
        true = arrival(STALE - 1) + timedelta(hours=12, seconds=30 + i)
        add(doc(None, hex_ts(true), height=STALE, source="PoolA", job_id=f"stale-{i}",
                prev_hash=stratum(bhash(STALE - 1)), ntime=arrival(STALE - 1)))
    # duplicates: an identical copy, and a same-key copy with different content
    base = next(d for d in docs if d["height"] == DUP_H and d["pool_name"] == "PoolB")
    add(dict(base))
    add(dict(base, lat_ms=99.0))
    # other chains / bad heights / not convertible
    t = arrival(870_030) + timedelta(seconds=90)
    add(doc(None, hex_ts(t), height=925_000, coinbase1=coinbase1(925_000), source="PoolC", job_id="bch-1",
            prev_hash="22" * 32, chain_family="bch"))
    add(doc(None, hex_ts(t), height=925_001, coinbase1=coinbase1(925_001), source="PoolC", job_id="bch-2",
            prev_hash="22" * 32, chain_family="bch"))
    add(doc(None, hex_ts(t), height=870_031, source="PoolC", job_id="unk-1", prev_hash="33" * 32, chain_family="unknown"))
    add(doc(None, hex_ts(t), height=6_976_415, coinbase1=coinbase1(6_976_415), source="PoolA", job_id="imp-1",
            prev_hash="44" * 32))
    add(doc(None, hex_ts(t), height=0, coinbase1=coinbase1(raw_script=b"\x00\x00"), source="PoolB", job_id="pf-1",
            prev_hash="55" * 32))
    add(doc(None, hex_ts(t), height=870_031, source="PoolB", job_id="upper-1", prev_hash="AB" * 32))
    pools = [dict(id=7, name="Example", slug="example", link="https://example.invalid", tags=["/ex/"], addresses=["1Ex"]),
             dict(id=8, name="Other", addresses=[], tags=[], regexes=["x"])]
    return docs, blocks, pools


def load():
    from pymongo import MongoClient
    db = MongoClient(os.environ["MONGO_URI"])[os.environ.get("MONGO_DB", "stratum-logger")]
    if db.mining_notify.estimated_document_count():
        raise SystemExit("refusing to load the fixture into a non-empty database")
    docs, blocks, pools = build()
    db.mining_notify.insert_many(docs)
    db.blocks.insert_many(blocks)
    db.pools.insert_many(pools)
    print(f"fixture: {len(docs)} templates, {len(blocks)} block documents, {len(pools)} pools")


def check(verify_path: str):
    import psycopg
    checks = json.load(open(verify_path))["checks"]

    class _V(dict):
        def __missing__(self, prefix):
            return next(c for c in checks if c["name"].startswith(prefix))
    v = _V()
    pg = psycopg.connect(options="-c TimeZone=UTC")
    q = lambda sql, *a: pg.execute(sql, a).fetchall()
    docs, blocks, _ = build()
    ok = bad = 0

    def expect(name, cond, detail=""):
        nonlocal ok, bad
        print(f"  {'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  ' + str(detail)}")
        ok, bad = ok + bool(cond), bad + (not cond)

    n_regular = (H1 - H0 - len(GAP)) * len(SOURCES) * len(OFFSETS_S)
    got = q("SELECT count(*) FROM templates")[0][0]
    expect(f"every regular Bitcoin template is in templates ({n_regular})", got == n_regular, got)
    reasons = dict(q("SELECT reason, count(*) FROM templates_other GROUP BY 1"))
    expect("routing: bch 2, unknown_chain 1, height_parse_failed 1, height_implausible 3 (2 stale + 1 impossible)",
           reasons == {"bch": 2, "unknown_chain": 1, "height_parse_failed": 1, "height_implausible": 3}, reasons)
    expect("impossible height kept with its parsed value",
           q("SELECT height FROM templates_other WHERE job_id = 'imp-1'") == [(6_976_415,)])
    expect("parse failure stored as height 0", q("SELECT height FROM templates_other WHERE job_id = 'pf-1'") == [(0,)])
    expect("bch rows carry chain=bch", q("SELECT DISTINCT chain::text FROM templates_other WHERE reason = 'bch'") == [("bch",)])
    corr = q("SELECT height, offset_s, count, corrected FROM mongo_to_postgres.tz_findings ORDER BY height")
    expect("-6 h height detected and corrected (12 templates), nothing else", corr == [(SHIFT_6H, -21600, 12, True)], corr)
    rows = q("SELECT DISTINCT received_at_offset_s FROM templates WHERE height = %s", SHIFT_6H)
    expect("corrected rows carry received_at_offset_s = -21600", rows == [(-21600,)], rows)
    first = q("SELECT min(received_at) FROM templates WHERE height = %s", SHIFT_6H)[0][0]
    expect("corrected rows are back on true UTC", first == arrival(SHIFT_6H - 1) + timedelta(seconds=2, microseconds=1000), first)
    expect("other heights untouched", q("SELECT count(*) FROM templates WHERE received_at_offset_s <> 0 AND height <> %s",
                                        SHIFT_6H)[0][0] == 0)
    stale = q("SELECT reason, received_at_offset_s FROM templates_other WHERE job_id LIKE 'stale-%%'")
    expect("+12 h stale replays: height_implausible, not shifted", stale == [("height_implausible", 0)] * 2, stale)
    late = q("SELECT count(*) FROM templates WHERE height = %s", LATE_TEST_H)[0][0]
    expect("templates on a block with a late header time stay Bitcoin (prev_hash evidence)", late == 12, late)
    dups = q("SELECT sum(duplicates), sum((stats->>'duplicates_identical')::int), sum((stats->>'duplicates_differing')::int) "
             "FROM mongo_to_postgres.days")
    expect("duplicates: 2 dropped (1 identical, 1 differing)", dups == [(2, 1, 1)], dups)
    expect("duplicate key stored once", q("SELECT count(*) FROM templates WHERE job_id = %s",
                                          f"{DUP_H}-PoolB-0")[0][0] == 1)
    rej = q("SELECT reason, mongo_id FROM mongo_to_postgres.rejected")
    expect("upper-case hex document rejected and listed", [r[0] for r in rej] == ["non_lossless_hex"], rej)
    cross = q("SELECT count(*) FROM templates t WHERE height = 870025")[0][0]
    expect("ISO with offset across midnight: all of height 870,025 present", cross == 12, cross)
    bson = q("SELECT count(*) FROM templates t JOIN sources s ON s.id = t.source_id WHERE height = %s AND s.name = 'PoolC'", BSON_H)
    expect("BSON datetime templates loaded", bson == [(4,)], bson)
    expect("sources registered with site old-cluster",
           q("SELECT name, site FROM sources ORDER BY name") == [(s, "old-cluster") for s in SOURCES])
    expect("blocks de-duplicated on block_hash", q("SELECT count(*) FROM blocks")[0][0] == len(blocks) - 1)
    expect("pools keep the full definition", q("SELECT definition->'regexes' FROM pools WHERE id = 8") == [(["x"],)])
    days = q("SELECT day, mongo_docs FROM mongo_to_postgres.days WHERE mongo_docs > 0 ORDER BY day")
    expect("two days loaded", [str(d) for d, _ in days] == ["2024-11-11", "2024-11-12"], days)

    # verify's verdicts
    cnt = v["counts per"]
    expect("verify: counts exact; WARN only for the listed reject and differing duplicate",
           cnt["status"] == "WARN" and "mismatches" not in cnt and cnt["totals"]["rejected"] == 1
           and cnt["duplicates_differing"] == 1, cnt)
    rt = v["byte-exact round trip"]
    expect("verify: round trip PASS (reject and differing duplicate recognized)", rt["status"] == "PASS"
           and rt["by_table"].get("rejected_listed") == 1 and rt["by_table"].get("duplicate_differing_listed") == 1, rt)
    ts = v["timestamp sanity"]
    expect("verify: timestamp sanity PASS (the -6 h height corrected)", ts["status"] == "PASS"
           and ts["heights_tz_corrected"] == 1, ts)
    expect("verify: coverage PASS", v["coverage"]["status"] == "PASS", v["coverage"])
    gaps = v["missing heights"]
    expect("verify: outage 870,040-870,042 listed as a known gap, nothing unexpected",
           gaps["missing_known"] == ["870040-870042"] and gaps["missing_unexpected"] == [] and gaps["status"] == "PASS", gaps)
    expect("verify: blocks PASS with 1 duplicate", v["blocks"]["status"] == "PASS" and v["blocks"]["duplicates"] == 1, v["blocks"])
    expect("verify: pools PASS", v["pools"]["status"] == "PASS", v["pools"])
    expect("verify: routing lists the 2 stale replays, none recent",
           v["routing"]["implausible_building_on_known_block"]["total"] == 2
           and v["routing"]["implausible_building_on_known_block"]["within_1h_of_block"] == 0,
           v["routing"]["implausible_building_on_known_block"])
    print(f"fixture checks: {ok} passed, {bad} failed")
    return 1 if bad else 0


if __name__ == "__main__":
    if sys.argv[1] == "load":
        load()
    else:
        sys.exit(check(sys.argv[2]))
