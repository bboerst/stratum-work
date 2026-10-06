"""Generate identity parity fixtures for web/lib/templates/identify.ts.

Usage (from repo root): python backend/tests/gen_identity_fixtures.py > web/lib/templates/__tests__/fixtures/identity-fixtures.json
Uses a small, fixed pool list so the fixture is deterministic and offline.
"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from analytics.pool_identification import identify_pool_from_data  # noqa: E402

POOLS = [
    {"id": 1, "name": "AntPool", "addresses": ["1AntAddr"], "tags": ["/AntPool/"], "regexes": [], "link": "https://antpool.com", "slug": "antpool"},
    {"id": 2, "name": "F2Pool", "addresses": [], "tags": ["/F2Pool/"], "regexes": ["f2pool"], "link": "https://f2pool.com"},
    {"id": 3, "name": "OCEAN", "addresses": ["bc1qocean"], "tags": ["OCEAN.XYZ"], "regexes": [], "link": "https://ocean.xyz", "slug": "ocean"},
    {"id": 4, "name": "Foundry USA", "addresses": ["bc1qfoundry"], "tags": ["Foundry USA Pool"], "regexes": [], "link": ""},
]

def h(s: str) -> str:
    return s.encode("latin-1").hex()

def datum_script(names):
    tag = "\x0f".join(names)
    return "03" + "a0cd0c" + format(len(tag), "02x") + h(tag) + "08" + "00" * 8

CASES = [
    ("address wins over tag", h("\x03abc/F2Pool/"), ["1AntAddr"]),
    ("tag match", "03a0cd0c" + h("/AntPool/xyz"), []),
    ("regex match, case-insensitive", "03a0cd0c" + h("mined by F2POOL"), []),
    ("no match", "03a0cd0c" + h("hello"), ["bc1qnobody"]),
    ("empty inputs", "", []),
    ("ocean by address with datum creator", datum_script(["OCEAN.XYZ", "SomeMiner"]), ["bc1qocean"]),
    ("ocean by tag, datum names only markers", datum_script(["OCEAN.XYZ", "DATUM Gateway"]), []),
    ("ocean datum strips non-alnum", datum_script(["OCEAN.XYZ", "Mi-ner_42!"]), []),
    ("invalid hex", "zz", []),
]

pools = {p["id"]: p for p in POOLS}
out = {"pools": POOLS, "cases": []}
for name, script, addrs in CASES:
    res = identify_pool_from_data({k: dict(v) for k, v in pools.items()}, script, addrs)
    out["cases"].append({"name": name, "scriptHex": script, "addresses": addrs, "expected": res})
json.dump(out, sys.stdout, indent=2, sort_keys=True)
print()
