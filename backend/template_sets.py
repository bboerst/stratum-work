"""Transaction-set facts per height (template_set_heights, template_set_feeds, template_set_pairs;
db/migrations/20261120000002_template_sets.sql), from which the web derives template providers at read time
(/api/template-providers, docs/methodology.md "Template providers").

Per height h, over the non-empty templates of h received inside h's window (template_height_windows) on the Bitcoin
block at h - 1 we know (bitcoin_parents):
  node    = (feed, pool paid): sources.name, and the pool the template's coinbase pays or names, identified like a
            block's (pool_identification.identify_pool_from_data: output addresses sorted by value against the pools'
            addresses, else the scriptSig against their tags). The coinbase is reassembled with the extranonce2
            repair of analytics/invalid_coinbase_no_merkle.py; one that doesn't parse is unidentified (pool NULL).
  set     = the template's merkle branches, exact bytes (compared as their sha256, computed in the read so only 32
            bytes per template travel; a collision would need a sha256 collision).
  stored  = per node: distinct sets, templates, first / last receive time; per pair of nodes: the sets both received.
            Nothing else: which nodes share a template provider is judged when the web reads these counts.

A height is filled once its window has closed (2 hours after the block at h arrived, height_window()), so no template
for it can still arrive. Every fill recomputes its heights whole (delete + insert): idempotent.

The backend fills, after each new block, every height of the last LOOKBACK below the tip whose window has closed and
that isn't filled yet (so an outage up to LOOKBACK blocks heals itself). Anything older (a fresh table, a longer
outage, or a re-count after the pool list changed) is the backfill's:

    python -m template_sets --backfill [--from-height 846720] [--to-height 976000] [--chunk 144]

walks [from, to] (default: the lowest stored block to the highest height whose window has closed) in height chunks,
logging each, and prints a JSON summary. Connects like the backend (PG_HOST, PG_PORT, PG_DATABASE, PG_USER,
PG_PASSWORD, PG_SSLMODE, PG_SSLROOTCERT), as a user in the stratum_backend role.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import itertools
import json
import logging
import pathlib
import sys
import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

LOOKBACK = 1008        # heights below the tip checked after each block (a week)
CHUNK = 144            # heights per read (backfill)
FILLER_CHUNK = 24      # heights per read in the backend (a deploy's first run counts up to LOOKBACK in these)

logger = logging.getLogger("backend.template_sets")


# --- addresses ------------------------------------------------------------------------------------------------------
# The address Bitcoin Core's getblock gives an output (scriptPubKey.address), which is what a block's pool is matched
# on: P2PKH, P2SH, and witness programs (v0 bech32; v1+ bech32m). Bare pubkeys, multisig and OP_RETURN have none.
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _base58check(payload: bytes) -> str:
    data = payload + hashlib.sha256(hashlib.sha256(payload).digest()).digest()[:4]
    n, out = int.from_bytes(data, "big"), ""
    while n:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def _polymod(values: Iterable[int]) -> int:
    gen = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if (b >> i) & 1 else 0
    return chk


def _segwit_address(version: int, program: bytes, hrp: str = "bc") -> str:
    acc, bits, data = 0, 0, [version]
    for b in program:                      # 8-bit to 5-bit groups
        acc, bits = (acc << 8) | b, bits + 8
        while bits >= 5:
            bits -= 5
            data.append((acc >> bits) & 31)
    if bits:
        data.append((acc << (5 - bits)) & 31)
    const = 1 if version == 0 else 0x2BC830A3   # bech32 (BIP173) for v0, bech32m (BIP350) after
    hrp_exp = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    pm = _polymod(hrp_exp + data + [0] * 6) ^ const
    return hrp + "1" + "".join(_B32[d] for d in data + [(pm >> 5 * (5 - i)) & 31 for i in range(6)])


def script_address(script: bytes) -> Optional[str]:
    """The mainnet address of an output script, as Bitcoin Core names it, or None when it has none."""
    s = bytes(script)
    if len(s) == 25 and s[:3] == b"\x76\xa9\x14" and s[23:] == b"\x88\xac":
        return _base58check(b"\x00" + s[3:23])
    if len(s) == 23 and s[:2] == b"\xa9\x14" and s[22] == 0x87:
        return _base58check(b"\x05" + s[2:22])
    if 4 <= len(s) <= 42 and (s[0] == 0 or 0x51 <= s[0] <= 0x60) and s[1] == len(s) - 2:
        version = 0 if s[0] == 0 else s[0] - 0x50
        program = s[2:]
        if version == 0 and len(program) not in (20, 32):
            return None
        return _segwit_address(version, program)
    return None


# --- the pool a template pays ---------------------------------------------------------------------------------------
_modules: Dict[str, Any] = {}


def _analytics(name: str) -> Any:
    """backend/analytics/<name>.py, loaded by path: the same code the block path runs, without importing the analytics
    package (whose plug-ins main.py wires up)."""
    if name not in _modules:
        path = pathlib.Path(__file__).resolve().parent / "analytics" / f"{name}.py"
        spec = importlib.util.spec_from_file_location(f"template_sets_{name}", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _modules[name] = module
    return _modules[name]


def coinbase_payer(coinbase1: str, extranonce1: str, extranonce2_length: int, coinbase2: str
                   ) -> Optional[Tuple[str, List[str]]]:
    """(scriptSig hex, output addresses by value, highest first) of a template's coinbase, as a block's are given to
    the pool identification (bitcoin_utils.extract_coinbase_data), or None when the coinbase doesn't parse."""
    tx, _ = _analytics("invalid_coinbase_no_merkle").reassemble_coinbase(coinbase1, extranonce1, extranonce2_length,
                                                                          coinbase2)
    if tx is None:
        return None
    addresses, value = [], {}
    for out in tx.vout:
        a = script_address(bytes(out.scriptPubKey))
        if a is not None:
            addresses.append(a)
            value[a] = value.get(a, 0) + int(out.nValue)
    addresses.sort(key=lambda a: value[a], reverse=True)
    return bytes(tx.vin[0].scriptSig).hex(), addresses


class PoolIdentifier:
    """pool_id for a template's coinbase, by the block rule (identify_pool_from_data) over the stored pool list. The
    rule tries the addresses first and the scriptSig's tags only when no address matches, so results are cached per
    address list (few: a pool's payout outputs) and, for the rest, per scriptSig (one per template, mostly: it
    carries the height and extranonce1), each cache cleared when it reaches CACHE_MAX entries."""
    CACHE_MAX = 50_000

    def __init__(self, pool_definitions: Sequence[Dict[str, Any]]):
        self.pools = {p.get("id"): p for p in pool_definitions if p.get("id") is not None}
        self._by_addresses: Dict[Tuple[str, ...], Optional[int]] = {}
        self._by_script_sig: Dict[str, Optional[int]] = {}

    @staticmethod
    def _id(found: Optional[Dict[str, Any]]) -> Optional[int]:
        pid = found.get("id") if found else None
        return int(pid) if pid is not None else None

    def __call__(self, coinbase1: str, extranonce1: str, extranonce2_length: int, coinbase2: str) -> Optional[int]:
        payer = coinbase_payer(coinbase1, extranonce1, extranonce2_length, coinbase2)
        if payer is None:
            return None
        script_sig, addresses = payer
        rule = _analytics("pool_identification")
        key = tuple(addresses)
        if key not in self._by_addresses:
            if len(self._by_addresses) >= self.CACHE_MAX:
                self._by_addresses.clear()
            self._by_addresses[key] = self._id(rule.identify_by_address(self.pools, addresses))
        if self._by_addresses[key] is not None:
            return self._by_addresses[key]
        if script_sig not in self._by_script_sig:
            if len(self._by_script_sig) >= self.CACHE_MAX:
                self._by_script_sig.clear()
            # no address matched: what identify_pool_from_data does next (the tags)
            self._by_script_sig[script_sig] = self._id(rule.identify_pool_from_data(self.pools, script_sig, []))
        return self._by_script_sig[script_sig]


# --- counting -------------------------------------------------------------------------------------------------------
Node = Tuple[str, Optional[int]]


def node_order(n: Node) -> Tuple[str, int]:
    """(feed, pool) order of the stored pairs: unidentified (NULL) first."""
    return n[0], -1 if n[1] is None else n[1]


def count_heights(rows: Iterable[Tuple[Any, ...]], identify: Callable[..., Optional[int]]
                  ) -> Tuple[Dict[int, int], List[Tuple[Any, ...]], List[Tuple[Any, ...]]]:
    """From template rows (height, feed, set_hash, coinbase1 hex, extranonce1 hex, extranonce2_length, coinbase2 hex,
    received_at), all non-empty: ({height: templates}, feed rows, pair rows) in the tables' column order."""
    per: Dict[int, Dict[Node, Dict[str, Any]]] = {}
    templates: Dict[int, int] = {}
    for height, feed, set_hash, cb1, en1, en2len, cb2, received_at in rows:
        node = (feed, identify(cb1, en1, en2len, cb2))
        templates[height] = templates.get(height, 0) + 1
        n = per.setdefault(height, {}).setdefault(node, {"sets": set(), "templates": 0, "first": received_at,
                                                         "last": received_at})
        n["sets"].add(bytes(set_hash))
        n["templates"] += 1
        n["first"], n["last"] = min(n["first"], received_at), max(n["last"], received_at)
    feeds, pairs = [], []
    for height in sorted(per):
        nodes = per[height]
        by_set: Dict[bytes, List[Node]] = {}
        for node in sorted(nodes, key=node_order):
            d = nodes[node]
            feeds.append((height, node[0], node[1], len(d["sets"]), d["templates"], d["first"], d["last"]))
            for s in d["sets"]:
                by_set.setdefault(s, []).append(node)
        shared: Dict[Tuple[Node, Node], int] = {}
        for holders in by_set.values():
            for a, b in itertools.combinations(holders, 2):     # holders are in node order: a < b
                shared[(a, b)] = shared.get((a, b), 0) + 1
        for (a, b), k in sorted(shared.items(), key=lambda kv: (node_order(kv[0][0]), node_order(kv[0][1]))):
            pairs.append((height, a[0], a[1], b[0], b[1], k))
    return templates, feeds, pairs


def fill(store: Any, h_from: int, h_to: int, identify: Callable[..., Optional[int]]) -> Dict[str, Any]:
    """Count heights [h_from, h_to] and replace their rows. Returns {heights, templates, feeds, pairs, read_s,
    write_s}."""
    t0 = time.monotonic()
    rows = store.template_set_rows(h_from, h_to)
    t1 = time.monotonic()
    templates, feeds, pairs = count_heights(rows, identify)
    # a height whose block at h - 1 isn't stored (yet) can't be counted: it stays uncounted, due again once it is
    parents = store.template_set_parent_heights(h_from, h_to)
    heights = [(h, templates.get(h, 0)) for h in range(h_from, h_to + 1) if h in parents]
    t2 = time.monotonic()
    store.replace_template_sets(h_from, h_to, heights, feeds, pairs)
    return {"heights": len(heights), "templates": sum(templates.values()), "feeds": len(feeds), "pairs": len(pairs),
            "read_s": round(t1 - t0, 2), "count_s": round(t2 - t1, 2), "write_s": round(time.monotonic() - t2, 2)}


def chunks(h_from: int, h_to: int, chunk: int = CHUNK) -> List[Tuple[int, int]]:
    """[h_from, h_to] as consecutive closed height ranges of at most `chunk`, lowest first."""
    if chunk <= 0:
        raise ValueError("chunk must be positive")
    return [(a, min(a + chunk - 1, h_to)) for a in range(h_from, h_to + 1, chunk)]


def runs(heights: Iterable[int], chunk: int = CHUNK) -> List[Tuple[int, int]]:
    """Sorted heights as closed ranges of consecutive heights, each at most `chunk` long."""
    out: List[Tuple[int, int]] = []
    for h in sorted(set(heights)):
        if out and out[-1][1] == h - 1 and h - out[-1][0] < chunk:
            out[-1] = (out[-1][0], h)
        else:
            out.append((h, h))
    return out


def backfill(store: Any, h_from: int, h_to: int, identify: Callable[..., Optional[int]], chunk: int = CHUNK,
             log: logging.Logger = logger, clock: Callable[[], float] = time.monotonic) -> Dict[str, Any]:
    """fill() over [h_from, h_to], chunk by chunk."""
    cs = chunks(h_from, h_to, chunk)
    started, total = clock(), {"templates": 0, "feeds": 0, "pairs": 0}
    for i, (a, b) in enumerate(cs, 1):
        t0 = clock()
        s = fill(store, a, b, identify)
        for k in total:
            total[k] += s[k]
        log.info("Template sets backfill %d/%d heights %d-%d: %d templates, %d feed rows, %d pair rows "
                 "(read %.1f s, count %.1f s, write %.1f s), %.1f s", i, len(cs), a, b, s["templates"], s["feeds"],
                 s["pairs"], s["read_s"], s["count_s"], s["write_s"], clock() - t0)
    summary = {"from_height": h_from, "to_height": h_to, "chunk": chunk, "chunks": len(cs),
               "templates": total["templates"], "feed_rows": total["feeds"], "pair_rows": total["pairs"],
               "seconds": round(clock() - started, 1)}
    log.info("Template sets backfill done: %s", summary)
    return summary


class TemplateSetsFiller:
    """The backend's schedule: after each new block (request()) and once at start, every height of the last
    `lookback` below the tip whose window has closed and that isn't filled. Its own thread and store (connection),
    never the block processor's. The pool list is re-read from the store on every run."""

    def __init__(self, store: Any, lookback: int = LOOKBACK, chunk: int = FILLER_CHUNK, log: logging.Logger = logger):
        self.store, self.lookback, self.chunk, self.log = store, lookback, chunk, log
        self._wake = threading.Event()

    def request(self) -> None:
        self._wake.set()

    def run_once(self) -> Dict[str, Any]:
        due = self.store.template_set_heights_due(self.lookback)
        if not due:
            return {"heights": 0, "templates": 0}
        identify = PoolIdentifier(self.store.load_pools())
        t0, n, templates = time.monotonic(), 0, 0
        for a, b in runs(due, self.chunk):
            s = fill(self.store, a, b, identify)
            n, templates = n + s["heights"], templates + s["templates"]
        self.log.info("Template sets filled %d heights (%d-%d): %d templates, %.1f s", n, due[0], due[-1], templates,
                      time.monotonic() - t0)
        return {"heights": n, "templates": templates}

    def run_forever(self) -> None:
        while True:
            try:
                self.run_once()
            except Exception as e:
                self.log.error("Template sets fill failed (retried on the next block): %s", e)
            self._wake.wait()
            self._wake.clear()


# --- CLI -----------------------------------------------------------------------------------------------------------
def _postgres_store() -> Any:
    # integrations/__init__.py connects to the configured store and to RabbitMQ at import; this needs neither.
    path = pathlib.Path(__file__).resolve().parent / "integrations" / "store.py"
    spec = importlib.util.spec_from_file_location("template_sets_store", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PostgresStore.from_env()


def main(argv: Optional[List[str]] = None, store: Any = None) -> int:
    p = argparse.ArgumentParser(prog="python -m template_sets", description=__doc__.split("\n\n")[0])
    p.add_argument("--backfill", action="store_true", help="count heights [--from-height, --to-height]")
    p.add_argument("--from-height", type=int, help="first height (default: the lowest stored block)")
    p.add_argument("--to-height", type=int, help="last height (default: the highest whose window has closed)")
    p.add_argument("--chunk", type=int, default=CHUNK, help=f"heights per read (default {CHUNK})")
    args = p.parse_args(argv)
    if not args.backfill or args.chunk <= 0:
        p.print_help(sys.stderr)
        return 2
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr)
    store = store or _postgres_store()
    lo, hi = store.template_set_height_bounds()
    h_from = args.from_height if args.from_height is not None else lo
    h_to = args.to_height if args.to_height is not None else hi
    if h_from is None or h_to is None or h_to < h_from:
        print(json.dumps({"chunks": 0, "note": "nothing to count", "from_height": h_from, "to_height": h_to}))
        return 0
    if hi is None or h_to > hi:
        print(f"--to-height {h_to} is above the highest closed height ({hi}): its templates may still arrive",
              file=sys.stderr)
        return 2
    identify = PoolIdentifier(store.load_pools())
    print(json.dumps(backfill(store, h_from, h_to, identify, args.chunk), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
