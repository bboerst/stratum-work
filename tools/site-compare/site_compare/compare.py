"""Pure comparison logic (no I/O): templates by job key, blocks, first-seen per block, pools.

Templates. The two sites run different collectors at different locations, so template ids and receive times differ
by design. A template is identified by its job key:

    (pool, height, prev_hash, merkle_branches, version, nbits, ntime)

Per key, each side's templates are paired one to one, closest in time first (a pool may send the same key several
times). A matched pair's first-seen difference is B minus A. Templates left over are classified, first rule that
applies:

    extra_copy           the other side has the same job key, fewer times
    near_miss:<fields>   the other side has the same job (pool, height, prev_hash, merkle_branches) with other
                         ntime / version / nbits only; <fields> names what differs from the closest one in time
    pool_one_side_only   the other side has no template from this pool anywhere in the compared range
    pool_missing_at_height  the other side has the pool elsewhere in the range, but nothing at this height
    other_prev_hash      the other side has the pool at this height, but never with this prev_hash
    other_source_missing the other side's template ids name its sources (collector connections), and the source
                         whose templates match this side most often in the range shows nothing at this height (that
                         collector was down, or reconnected to another job stream); the other side's rows here come
                         from another connection
    before_other_first   received more than gap_s before the other side's first template of the pool at this height
                         (the other side's collector wasn't connected yet, or got the height later)
    after_other_last     more than gap_s after the other side's last one (disconnected, or a stale cached response)
    other_side_gap       inside the other side's span, but the other side has nothing from the pool within gap_s
    multi_source         this side shows rows from several sources of the pool at this height: a second
                         connection's own job stream (some pools hand different connections different jobs), shown
                         because it isn't a copy of the primary's
    unexplained          none of the above

Nothing is merged by tolerance: a template is matched only on an identical job key.
"""
from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone

SIDES = ("a", "b")
OTHER = {"a": "b", "b": "a"}
CLASS_ORDER = ("extra_copy", "near_miss", "pool_one_side_only", "pool_missing_at_height", "before_other_started",
               "other_prev_hash",
               "other_source_missing", "before_other_first", "after_other_last", "other_side_gap", "multi_source",
               "unexplained")


# ── templates ─────────────────────────────────────────────────────────────────────────────────────────────────────

def _h(v) -> str:
    return str(v).lower()


def job(t: dict) -> tuple:
    """The job without the fields a pool rolls on re-sends: (pool, height, prev_hash, merkle_branches)."""
    return (t["pool_name"], int(t["height"]), _h(t["prev_hash"]), tuple(_h(b) for b in t.get("merkle_branches") or ()))


def job_key(t: dict) -> tuple:
    return job(t) + (_h(t["version"]), _h(t["nbits"]), _h(t["ntime"]))


def ts_ns(t: dict) -> int:
    """Receive time in ns. The collectors store hex nanoseconds; old history used naive ISO-8601 (UTC)."""
    v = t.get("timestamp")
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v)
    try:
        return int(s, 16)
    except ValueError:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1_000_000) * 1000


_SOURCE_ID = re.compile(r"^(\d+)-(\d{13,17})-")   # µs since the epoch: 16 digits; a UUID has 4 there


def source_of(t: dict) -> str | None:
    """The collector connection a template came from, when the site's template id names it (Postgres ids are
    `<source_id>-<µs>-<job_id>`, see web/lib/db/pg-mapping.ts). None for opaque ids (MongoDB UUIDs)."""
    m = _SOURCE_ID.match(str(t.get("id") or ""))
    return m.group(1) if m else None


@dataclass
class Unmatched:
    side: str
    template: dict
    cls: str = ""
    detail: str = ""


@dataclass
class HeightMatch:
    height: int
    counts: dict                                 # side -> {pool: n}
    pairs: dict = field(default_factory=dict)    # pool -> [(t_a, t_b)]
    unmatched: list = field(default_factory=list)


def pair_closest(la: list[dict], lb: list[dict]) -> tuple[list[tuple[dict, dict]], list[dict], list[dict]]:
    """One-to-one pairs of templates with the same job key, closest in time first. Returns (pairs, A's rest, B's
    rest). A key a pool re-sends (same ntime) can appear several times on a side; pairing by order instead would
    pair a re-send on one side with the original on the other."""
    if len(la) == 1 and len(lb) == 1:
        return [(la[0], lb[0])], [], []
    cand = sorted(((abs(ts_ns(b) - ts_ns(a)), i, j) for i, a in enumerate(la) for j, b in enumerate(lb)))
    used_a, used_b, pairs = set(), set(), []
    for _, i, j in cand:
        if i not in used_a and j not in used_b:
            used_a.add(i)
            used_b.add(j)
            pairs.append((la[i], lb[j]))
    return (sorted(pairs, key=lambda p: ts_ns(p[0])), [a for i, a in enumerate(la) if i not in used_a],
            [b for j, b in enumerate(lb) if j not in used_b])


def match_height(height: int, a: list[dict], b: list[dict]) -> HeightMatch:
    """Pair A's and B's templates at one height by job key (one to one, closest in time first per key)."""
    groups: dict[tuple, dict[str, list]] = defaultdict(lambda: {"a": [], "b": []})
    for side, ts in (("a", a), ("b", b)):
        for t in ts:
            groups[job_key(t)][side].append(t)
    hm = HeightMatch(height, {s: dict(Counter(t["pool_name"] for t in ts)) for s, ts in (("a", a), ("b", b))})
    for key in sorted(groups, key=lambda k: (k[0], min(ts_ns(t) for s in SIDES for t in groups[k][s]))):
        g = groups[key]
        la, lb = sorted(g["a"], key=ts_ns), sorted(g["b"], key=ts_ns)
        pairs, rest_a, rest_b = pair_closest(la, lb) if la and lb else ([], la, lb)
        hm.pairs.setdefault(key[0], []).extend(pairs)
        both = bool(la) and bool(lb)
        for side, rest in (("a", rest_a), ("b", rest_b)):
            for t in rest:
                hm.unmatched.append(Unmatched(side, t, "extra_copy" if both else ""))
    return hm


def classify(hm: HeightMatch, by_side_pool: dict, pools_anywhere: dict, gap_s: float,
             main_source: dict | None = None, first_ns: dict | None = None) -> None:
    """Fill in the class of every unmatched template of a height (see the module docstring).
    by_side_pool[side][pool] = that side's templates of the pool at this height; pools_anywhere[side] = pools seen
    on that side anywhere in the range; main_source[side][pool] = that side's source (source_of) whose templates
    matched the other side most often in the range (absent when the side's ids don't name sources);
    first_ns[side][pool] = that side's earliest template of the pool in the range."""
    gap_ns = gap_s * 1e9
    main_source = main_source or {"a": {}, "b": {}}
    for u in hm.unmatched:
        if u.cls:
            continue
        t, side, other = u.template, u.side, OTHER[u.side]
        pool = t["pool_name"]
        theirs = by_side_pool[other].get(pool, [])
        mine = by_side_pool[side].get(pool, [])
        tns = ts_ns(t)
        same_job = [o for o in theirs if job(o) == job(t)]
        their_main = main_source[other].get(pool)
        their_sources_here = {source_of(o) for o in theirs} - {None}
        my_sources_here = {source_of(o) for o in mine} - {None}
        if same_job:
            closest = min(same_job, key=lambda o: abs(ts_ns(o) - tns))
            fields = [f for f in ("version", "nbits", "ntime") if _h(closest[f]) != _h(t[f])]
            u.cls = "near_miss:" + "+".join(fields)
            if "ntime" in fields:
                try:
                    u.detail = f"ntime {int(t['ntime'], 16) - int(closest['ntime'], 16):+d} s"
                except ValueError:
                    pass
            continue
        if pool not in pools_anywhere[other]:
            u.cls = "pool_one_side_only"
            continue
        if not theirs:
            u.cls = "pool_missing_at_height"
            continue
        if first_ns and tns < first_ns[other].get(pool, -1):
            u.cls = "before_other_started"
            continue
        if all(_h(o["prev_hash"]) != _h(t["prev_hash"]) for o in theirs):
            u.cls = "other_prev_hash"
            continue
        if their_main is not None and their_sources_here and their_main not in their_sources_here:
            u.cls = "other_source_missing"
            u.detail = f"{other}'s source {their_main} shows nothing here; it shows {sorted(their_sources_here)}"
            continue
        times = sorted(ts_ns(o) for o in theirs)
        nearest = min(abs(x - tns) for x in times)
        u.detail = f"nearest on {other}: {nearest / 1e9:.1f} s"
        if tns < times[0] - gap_ns:
            u.cls = "before_other_first"
        elif tns > times[-1] + gap_ns:
            u.cls = "after_other_last"
        elif nearest > gap_ns:
            u.cls = "other_side_gap"
        elif len(my_sources_here) > 1:
            u.cls = "multi_source"
            u.detail += f"; {side} shows {len(my_sources_here)} sources here"
        else:
            u.cls = "unexplained"


def class_family(cls: str) -> str:
    return cls.split(":", 1)[0]


def percentile(xs: list[float], p: float) -> float | None:
    """Nearest-rank percentile (p in 0..100) of a non-empty list; None for an empty one."""
    if not xs:
        return None
    s = sorted(xs)
    k = max(0, min(len(s) - 1, math.ceil(p / 100 * len(s)) - 1))
    return s[k]


def delta_stats(deltas_ms: list[float]) -> dict:
    if not deltas_ms:
        return {"n": 0}
    return {"n": len(deltas_ms), "min": round(min(deltas_ms), 3), "p5": round(percentile(deltas_ms, 5), 3),
            "p50": round(percentile(deltas_ms, 50), 3), "p95": round(percentile(deltas_ms, 95), 3),
            "max": round(max(deltas_ms), 3),
            "b_earlier_share": round(sum(1 for d in deltas_ms if d < 0) / len(deltas_ms), 4)}


@dataclass
class PoolTotals:
    templates: dict = field(default_factory=lambda: {"a": 0, "b": 0})
    heights: dict = field(default_factory=lambda: {"a": set(), "b": set()})
    matched: int = 0
    only: dict = field(default_factory=lambda: {"a": Counter(), "b": Counter()})
    deltas_ms: list = field(default_factory=list)
    clean_jobs_differ: int = 0
    en2_len_differ: int = 0
    en1_len_differ: int = 0
    coinbase_identical: int = 0
    first_seen_deltas_ms: list = field(default_factory=list)
    sources: dict = field(default_factory=lambda: {"a": 0, "b": 0})   # 0: the side's ids don't name sources


def _coinbase(t: dict) -> tuple:
    return (_h(t.get("coinbase1", "")), _h(t.get("coinbase2", "")))


def compare_templates(per_height: dict[int, tuple[list, list]], gap_s: float = 60.0) -> dict:
    """per_height: {height: (A's templates, B's templates)}. Returns per-pool totals, per-height rows and examples."""
    pools_anywhere = {s: set() for s in SIDES}
    sources_anywhere = {s: defaultdict(set) for s in SIDES}
    first_ns: dict = {s: {} for s in SIDES}
    for a, b in per_height.values():
        for side, ts in (("a", a), ("b", b)):
            for t in ts:
                pools_anywhere[side].add(t["pool_name"])
                p, n = t["pool_name"], ts_ns(t)
                if n < first_ns[side].get(p, n + 1):
                    first_ns[side][p] = n
                src = source_of(t)
                if src is not None:
                    sources_anywhere[side][t["pool_name"]].add(src)
    totals: dict[str, PoolTotals] = defaultdict(PoolTotals)
    rows, examples = [], []
    matches = {h: match_height(h, *per_height[h]) for h in sorted(per_height)}
    pair_sources = {s: defaultdict(Counter) for s in SIDES}
    for hm in matches.values():
        for pool, pairs in hm.pairs.items():
            for ta, tb in pairs:
                for side, t in (("a", ta), ("b", tb)):
                    if (src := source_of(t)) is not None:
                        pair_sources[side][pool][src] += 1
    main_source = {s: {pool: c.most_common(1)[0][0] for pool, c in pair_sources[s].items()} for s in SIDES}
    for h in sorted(per_height):
        a, b = per_height[h]
        hm = matches[h]
        by_side_pool = {s: defaultdict(list) for s in SIDES}
        for side, ts in (("a", a), ("b", b)):
            for t in ts:
                by_side_pool[side][t["pool_name"]].append(t)
                totals[t["pool_name"]].templates[side] += 1
                totals[t["pool_name"]].heights[side].add(h)
        classify(hm, by_side_pool, pools_anywhere, gap_s, main_source, first_ns)
        matched = 0
        for pool, pairs in hm.pairs.items():
            pt = totals[pool]
            pt.matched += len(pairs)
            matched += len(pairs)
            for ta, tb in pairs:
                pt.deltas_ms.append((ts_ns(tb) - ts_ns(ta)) / 1e6)
                pt.clean_jobs_differ += bool(ta.get("clean_jobs")) != bool(tb.get("clean_jobs"))
                pt.en2_len_differ += ta.get("extranonce2_length") != tb.get("extranonce2_length")
                pt.en1_len_differ += len(str(ta.get("extranonce1") or "")) != len(str(tb.get("extranonce1") or ""))
                pt.coinbase_identical += _coinbase(ta) == _coinbase(tb)
        only = {s: Counter() for s in SIDES}
        for u in hm.unmatched:
            totals[u.template["pool_name"]].only[u.side][u.cls] += 1
            only[u.side][class_family(u.cls)] += 1
            if class_family(u.cls) == "unexplained" and len(examples) < 50:
                examples.append({"height": h, "side": u.side, "pool": u.template["pool_name"],
                                 "timestamp": u.template.get("timestamp"), "detail": u.detail})
        rows.append({"height": h, "a": len(a), "b": len(b), "matched": matched,
                     "only_a": sum(only["a"].values()), "only_b": sum(only["b"].values()),
                     "only_a_classes": dict(only["a"]), "only_b_classes": dict(only["b"]),
                     "pools_a": len(hm.counts["a"]), "pools_b": len(hm.counts["b"])})
    for side in SIDES:
        for pool, srcs in sources_anywhere[side].items():
            totals[pool].sources[side] = len(srcs)
    return {"pools": totals, "heights": rows, "unexplained_examples": examples, "pools_anywhere": pools_anywhere}


# ── first seen per block (R4) ─────────────────────────────────────────────────────────────────────────────────────

def kendall_discordant(order_a: list[str], order_b: list[str]) -> tuple[int, int]:
    """(discordant pairs, comparable pairs) over the pools both orders contain."""
    common = [p for p in order_a if p in set(order_b)]
    pos_b = {p: i for i, p in enumerate(order_b)}
    disc = sum(1 for i in range(len(common)) for j in range(i + 1, len(common)) if pos_b[common[i]] > pos_b[common[j]])
    n = len(common)
    return disc, n * (n - 1) // 2


def compare_first_seen(per_height: dict[int, tuple[list, list]], totals: dict | None = None) -> dict:
    """per_height: {height: (A's R4 items, B's R4 items)}. Adds per-pool first-seen deltas to `totals` if given."""
    rows, only = [], {"a": Counter(), "b": Counter()}
    same_set = same_order = disc_total = pairs_total = reliable_differ = 0
    for h in sorted(per_height):
        a, b = per_height[h]
        na, nb = [x["poolName"] for x in a], [x["poolName"] for x in b]
        sa, sb = set(na), set(nb)
        for p in sa - sb:
            only["a"][p] += 1
        for p in sb - sa:
            only["b"][p] += 1
        common_a = [p for p in na if p in sb]
        common_b = [p for p in nb if p in sa]
        disc, pairs = kendall_discordant(na, nb)
        disc_total += disc
        pairs_total += pairs
        same_set += sa == sb
        same_order += common_a == common_b
        ia, ib = {x["poolName"]: x for x in a}, {x["poolName"]: x for x in b}
        rel = 0
        for p in sa & sb:
            if ia[p].get("reliable") != ib[p].get("reliable"):
                rel += 1
            if totals is not None:
                d = (ts_ns({"timestamp": ib[p]["firstSeenTimestamp"]}) -
                     ts_ns({"timestamp": ia[p]["firstSeenTimestamp"]})) / 1e6
                totals[p].first_seen_deltas_ms.append(d)
        reliable_differ += rel
        rows.append({"height": h, "pools_a": len(sa), "pools_b": len(sb), "only_a": sorted(sa - sb),
                     "only_b": sorted(sb - sa), "same_order": common_a == common_b, "discordant_pairs": disc,
                     "pairs": pairs, "reliable_differs": rel})
    n = len(per_height)
    return {"heights": rows, "n": n, "same_pool_set": same_set, "same_order_of_common_pools": same_order,
            "discordant_pairs": disc_total, "pairs": pairs_total,
            "kendall_tau": round(1 - 2 * disc_total / pairs_total, 4) if pairs_total else None,
            "reliable_flag_differs": reliable_differ,
            "pool_only_on_a_heights": dict(only["a"]), "pool_only_on_b_heights": dict(only["b"])}


# ── blocks ────────────────────────────────────────────────────────────────────────────────────────────────────────

IGNORED_BLOCK_KEYS = {"_id", "id"}      # MongoDB ObjectId vs block hash: different by design


def canonical(v):
    if isinstance(v, dict):
        return {k: canonical(v[k]) for k in sorted(v)}
    if isinstance(v, list):
        return [canonical(x) for x in v]
    return v


def diff_paths(a, b, path="$", out=None, limit=20) -> list[str]:
    """Paths where a and b differ, object keys compared order-insensitively. At most `limit`."""
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}.length {len(a)} vs {len(b)}")
        for i in range(min(len(a), len(b))):
            diff_paths(a[i], b[i], f"{path}[{i}]", out, limit)
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                out.append(f"{path}.{k}: only on B") if len(out) < limit else None
            elif k not in b:
                out.append(f"{path}.{k}: only on A") if len(out) < limit else None
            else:
                diff_paths(a[k], b[k], f"{path}.{k}", out, limit)
        return out
    if a != b and len(out) < limit:
        out.append(f"{path}: {json.dumps(a)[:80]} vs {json.dumps(b)[:80]}")
    return out


def _pool_id(block: dict) -> dict:
    mp = block.get("mining_pool") or {}
    pi = ((block.get("analysis") or {}).get("pool_identification") or {})
    return {"name": mp.get("name"), "id": mp.get("id"), "identification_method": mp.get("identification_method"),
            "analysis_method": pi.get("method")}


def block_category(path: str) -> str:
    if path.startswith("$.mining_pool") or path.startswith("$.analysis.pool_identification"):
        return "pool_identification"
    if path.startswith("$.analysis"):
        return "analysis"
    if path.startswith("$.coinbase_script_sig"):
        return "coinbase"
    return "other_fields"


def compare_blocks(a: dict[int, list[dict]], b: dict[int, list[dict]], heights: list[int]) -> dict:
    """a/b: {height: [block, …]}. Per height: hashes, then (for a common hash) every field but the ids."""
    summary = Counter()
    diffs = []
    for h in heights:
        la, lb = a.get(h, []), b.get(h, [])
        ha = {x["block_hash"]: x for x in la}
        hb = {x["block_hash"]: x for x in lb}
        if not la and not lb:
            summary["missing_both"] += 1
            continue
        if not lb:
            summary["only_a"] += 1
            diffs.append({"height": h, "kind": "block only on A", "details": sorted(ha)})
            continue
        if not la:
            summary["only_b"] += 1
            diffs.append({"height": h, "kind": "block only on B", "details": sorted(hb)})
            continue
        if set(ha) != set(hb):
            summary["hash_differs"] += 1
            diffs.append({"height": h, "kind": "block hash differs",
                          "details": [f"A {sorted(ha)}", f"B {sorted(hb)}"]})
        if len(ha) > 1 or len(hb) > 1:
            summary["fork_heights"] += 1
        same = sorted(set(ha) & set(hb))
        height_ok = set(ha) == set(hb)
        for bh in same:
            xa = {k: v for k, v in ha[bh].items() if k not in IGNORED_BLOCK_KEYS}
            xb = {k: v for k, v in hb[bh].items() if k not in IGNORED_BLOCK_KEYS}
            paths = diff_paths(canonical(xa), canonical(xb))
            if paths:
                height_ok = False
                cats = sorted({block_category(p) for p in paths})
                for c in cats:
                    summary[f"differs:{c}"] += 1
                pa, pb = _pool_id(ha[bh]), _pool_id(hb[bh])
                diffs.append({"height": h, "kind": "fields differ (" + ", ".join(cats) + ")", "hash": bh,
                              "details": paths, "pool_a": pa, "pool_b": pb})
        summary["identical" if height_ok else "different"] += 1
    return {"summary": dict(summary), "differences": diffs}


# ── pools list (R7), interesting blocks (R3) ──────────────────────────────────────────────────────────────────────

def compare_pools(a: list[dict], b: list[dict]) -> dict:
    """By name: present on one side only, tag / address differences. Ids and order differ by design (MongoDB
    ObjectId and natural order vs the mining-pools id)."""
    ca, cb = Counter(p.get("name") for p in a), Counter(p.get("name") for p in b)
    ia, ib = {p.get("name"): p for p in a}, {p.get("name"): p for p in b}
    differ = []
    for name in sorted(set(ia) & set(ib), key=str):
        pa, pb = ia[name], ib[name]
        what = []
        if pa.get("tag") != pb.get("tag"):
            what.append("tag")
        if set(pa.get("addresses") or []) != set(pb.get("addresses") or []):
            what.append(f"addresses (A {len(pa.get('addresses') or [])}, B {len(pb.get('addresses') or [])})")
        if what:
            differ.append({"name": name, "differs": what})
    na, nb = [p.get("name") for p in a], [p.get("name") for p in b]
    return {"count_a": len(a), "count_b": len(b), "only_a": sorted(set(ca) - set(cb), key=str),
            "only_b": sorted(set(cb) - set(ca), key=str),
            "duplicates_a": sorted((n for n, c in ca.items() if c > 1), key=str),
            "duplicates_b": sorted((n for n, c in cb.items() if c > 1), key=str),
            "field_differences": differ, "same_order": na == nb,
            "same_order_sorted_by_name": sorted(na, key=str) == sorted(nb, key=str)}


def compare_interesting(a: list[dict], b: list[dict], start: int, end: int) -> dict:
    """R3 items within [start, end]. Each list is the newest 200, so only heights both lists can cover count."""
    def window(xs):
        return min((x["height"] for x in xs), default=None) if len(xs) >= 200 else None
    lo = max([start] + [w for w in (window(a), window(b)) if w is not None])
    ia = {(x["height"], x["block_hash"]): x for x in a if lo <= x["height"] <= end}
    ib = {(x["height"], x["block_hash"]): x for x in b if lo <= x["height"] <= end}
    differ = []
    for k in sorted(set(ia) & set(ib)):
        paths = diff_paths(canonical(ia[k]), canonical(ib[k]))
        if paths:
            differ.append({"height": k[0], "details": paths})
    return {"from": lo, "to": end, "count_a": len(ia), "count_b": len(ib),
            "only_a": sorted(h for h, _ in set(ia) - set(ib)), "only_b": sorted(h for h, _ in set(ib) - set(ia)),
            "differ": differ}
