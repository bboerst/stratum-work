"""Compare the templates two replicas (connections) of one pool received in the same window.

Pure functions over `Template` rows, so they're testable without a database. Nothing here returns coinbase,
extranonce or job id *values*: only counts, shares, positions and lengths.
"""
from __future__ import annotations

import bisect
import hashlib
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Iterable, Optional

from .coinbase import Coinbase, try_decode

FIELDS = ("height", "prev_hash", "version", "nbits", "ntime", "clean_jobs", "merkle_branches", "job_id",
          "extranonce1", "extranonce2_length", "coinbase1", "coinbase2")


@dataclass
class Template:
    replica: str
    received_at: datetime
    height: int
    job_id: str
    prev_hash: bytes
    coinbase1: bytes
    coinbase2: bytes
    merkle_branches: bytes
    version: int
    nbits: int
    ntime: int
    clean_jobs: bool
    extranonce1: bytes
    extranonce2_length: int
    chain: str = "btc"   # 'btc' (templates) or the templates_other classification

    _cb: Optional[Coinbase] = field(default=None, repr=False, compare=False)
    _cb_done: bool = field(default=False, repr=False, compare=False)

    @property
    def coinbase(self) -> Optional[Coinbase]:
        if not self._cb_done:
            self._cb = try_decode(self.coinbase1, self.extranonce1, self.extranonce2_length, self.coinbase2)
            self._cb_done = True
        return self._cb

    def outputs_digest(self) -> Optional[bytes]:
        cb = self.coinbase
        if cb is None:
            return None
        h = hashlib.sha256()
        for o in cb.outputs:
            h.update(o.value.to_bytes(8, "little") + len(o.script).to_bytes(4, "little") + o.script)
        return h.digest()


def percentile(values: list[float], p: float) -> Optional[float]:
    """Nearest-rank percentile (p in 0..100); None for no values."""
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round(p / 100 * len(s) + 0.5)) - 1))
    return s[k]


def dist(values: list[float]) -> dict:
    return {"n": len(values), "p50": percentile(values, 50), "p95": percentile(values, 95),
            "max": max(values) if values else None}


# ---------------------------------------------------------------------------------------------------- pairing

def pair_templates(a: list[Template], b: list[Template], max_offset_s: float) -> list[tuple[Template, Template]]:
    """One-to-one pairs of a and b templates with the same prev_hash, closest receive times first, at most
    max_offset_s apart. Greedy on the global offset order, so every pair is the nearest still available."""
    by_prev: dict[bytes, list[Template]] = defaultdict(list)
    for t in b:
        by_prev[t.prev_hash].append(t)
    for lst in by_prev.values():
        lst.sort(key=lambda t: t.received_at)
    cands = []
    for i, ta in enumerate(a):
        lst = by_prev.get(ta.prev_hash)
        if not lst:
            continue
        times = [t.received_at.timestamp() for t in lst]  # small lists per prev_hash
        x = ta.received_at.timestamp()
        lo, hi = bisect.bisect_left(times, x - max_offset_s), bisect.bisect_right(times, x + max_offset_s)
        for j in range(lo, hi):
            cands.append((abs(times[j] - x), i, id(lst[j]), lst[j]))
    cands.sort(key=lambda c: (c[0], c[1]))
    used_a, used_b, pairs = set(), set(), []
    for _, i, jb, tb in cands:
        if i in used_a or jb in used_b:
            continue
        used_a.add(i)
        used_b.add(jb)
        pairs.append((a[i], tb))
    pairs.sort(key=lambda p: p[0].received_at)
    return pairs


def field_equality(pairs: list[tuple[Template, Template]]) -> dict[str, float]:
    out = {}
    for f in FIELDS:
        eq = sum(getattr(x, f) == getattr(y, f) for x, y in pairs)
        out[f] = eq / len(pairs) if pairs else None
    eq = sum(x.coinbase is not None and y.coinbase is not None and x.outputs_digest() == y.outputs_digest()
             for x, y in pairs)
    out["coinbase_outputs"] = eq / len(pairs) if pairs else None
    eq = sum(len(x.coinbase1) == len(y.coinbase1) and len(x.coinbase2) == len(y.coinbase2) for x, y in pairs)
    out["coinbase_lengths"] = eq / len(pairs) if pairs else None
    return out


# ---------------------------------------------------------------------------------------------------- coinbase diff

def diff_runs(x: bytes, y: bytes) -> list[tuple[int, int]]:
    """Differing byte runs (offset, length). Equal lengths: every maximal run of differing bytes. Different
    lengths: one span between the common prefix and the common suffix (offset in x, length = the longer span)."""
    if x == y:
        return []
    if len(x) == len(y):
        runs, start = [], None
        for i, (p, q) in enumerate(zip(x, y)):
            if p != q and start is None:
                start = i
            elif p == q and start is not None:
                runs.append((start, i - start))
                start = None
        if start is not None:
            runs.append((start, len(x) - start))
        return runs
    pre = 0
    while pre < min(len(x), len(y)) and x[pre] == y[pre]:
        pre += 1
    suf = 0
    while suf < min(len(x), len(y)) - pre and x[-1 - suf] == y[-1 - suf]:
        suf += 1
    return [(pre, max(len(x), len(y)) - pre - suf)]


def _anchor(region: str, same_length: bool) -> str:
    """scriptSig tails (`sig_post`) and regions whose length differs are anchored at their end: that's the stable
    reference when the bytes before them vary in length. Everything else is anchored at its start."""
    return "end" if region == "sig_post" or not same_length else "start"


def _diff_positions(vx: bytes, vy: bytes, anchor: str) -> list[int]:
    out = []
    for off, ln in diff_runs(vx, vy):
        for i in range(off, off + ln):
            out.append(i if anchor == "start" else i - len(vx))
    return out


def coinbase_diff(pairs: list[tuple[Template, Template]], min_share: float = 0.02, limit: int = 10) -> dict:
    """Where the coinbases of paired templates differ, by region, with the extranonce itself masked. Differing
    byte positions are counted per (region, anchor); `fields` are runs of adjacent positions that differ in at least
    min_share of the decoded pairs."""
    decoded = [(x.coinbase, y.coinbase) for x, y in pairs]
    ok = [(cx, cy) for cx, cy in decoded if cx is not None and cy is not None]
    res = {"pairs": len(pairs), "decoded": len(ok), "identical_outside_extranonce": 0,
           "outputs_identical": 0, "output_count_differs": 0, "output_values_differ": 0, "output_scripts_differ": 0,
           "differing_output_kinds": Counter(), "scriptsig_differs": 0, "scriptsig_length_differs": 0,
           "regions": Counter(), "region_length_differs": Counter(), "extranonce_regions": Counter(),
           "same_job_id": 0, "same_job_id_identical": 0}
    hist: dict[tuple[str, str], Counter] = defaultdict(Counter)
    per_pair: list[set] = []
    ok_pairs = [(x, y) for x, y in pairs if x.coinbase is not None and y.coinbase is not None]
    for (tx, ty), (cx, cy) in zip(ok_pairs, ok):
        res["extranonce_regions"]["+".join(cx.extranonce_regions())] += 1
        rx, ry = cx.region_bytes(), cy.region_bytes()
        same_outputs = len(cx.outputs) == len(cy.outputs) and all(
            o.value == p.value and o.script == p.script for o, p in zip(cx.outputs, cy.outputs))
        res["outputs_identical"] += same_outputs
        if len(cx.outputs) != len(cy.outputs):
            res["output_count_differs"] += 1
        else:
            if any(o.value != p.value for o, p in zip(cx.outputs, cy.outputs)):
                res["output_values_differ"] += 1
            if any(o.script != p.script for o, p in zip(cx.outputs, cy.outputs)):
                res["output_scripts_differ"] += 1
            for o, p in zip(cx.outputs, cy.outputs):
                if o.value != p.value or o.script != p.script:
                    res["differing_output_kinds"][o.kind if o.kind == p.kind else f"{o.kind}/{p.kind}"] += 1
        if cx.scriptsig_len != cy.scriptsig_len:
            res["scriptsig_length_differs"] += 1
        res["scriptsig_differs"] += rx["sig_pre"] != ry["sig_pre"] or rx["sig_post"] != ry["sig_post"]
        mine = set()
        for name in sorted(rx.keys() | ry.keys()):
            vx, vy = rx.get(name, b""), ry.get(name, b"")
            if vx == vy:
                continue
            res["regions"][name] += 1
            same = len(vx) == len(vy)
            if not same:
                res["region_length_differs"][name] += 1
            anchor = _anchor(name, same)
            for pos in _diff_positions(vx, vy, anchor):
                hist[(name, anchor)][pos] += 1
                mine.add((name, anchor, pos))
        per_pair.append(mine)
        res["identical_outside_extranonce"] += not mine
        if tx.job_id == ty.job_id:
            res["same_job_id"] += 1
            res["same_job_id_identical"] += not mine
    total = len(ok)
    fields = []
    for (name, anchor), h in hist.items():
        hot = sorted(pos for pos, n in h.items() if total and n / total >= min_share)
        runs: list[list[int]] = []
        for pos in hot:
            if runs and pos == runs[-1][-1] + 1:
                runs[-1].append(pos)
            else:
                runs.append([pos])
        for run in runs:
            span = {(name, anchor, pos) for pos in run}
            n = sum(bool(span & m) for m in per_pair)
            lens = Counter(len(cx.region_bytes()[name]) for cx, _ in ok if name in cx.region_bytes())
            rlen = lens.most_common(1)[0][0] if lens else None
            fields.append({"region": name, "anchor": anchor, "offset": run[0], "length": len(run), "pairs": n,
                           "share": round(n / total, 3), "region_length": rlen,
                           "from_start": run[0] if anchor == "start" else (rlen + run[0] if rlen else None),
                           "from_end": run[0] - rlen if anchor == "start" and rlen else run[0]})
    fields.sort(key=lambda f: -f["pairs"])
    res["fields"] = fields[:limit]
    return res


# ---------------------------------------------------------------------------------------------------- classification

def _slice(t: Template, region: str, anchor: tuple[str, int], length: int) -> Optional[bytes]:
    cb = t.coinbase
    if cb is None:
        return None
    r = cb.region_bytes().get(region)
    if r is None:
        return None
    kind, off = anchor
    start = off if kind == "start" else len(r) + off
    if start < 0 or start + length > len(r):
        return None
    return r[start:start + length]


def _monotonic_share(vals: list[int]) -> tuple[float, list[int]]:
    steps = [b - a for a, b in zip(vals, vals[1:])]
    if not steps:
        return 0.0, []
    return sum(s >= 0 for s in steps) / len(steps), steps


TIME_SCALES = {"s": 1, "ms": 1e3, "us": 1e6, "ns": 1e9}


def _time_unit(region: bytes, start: int, length: int, ref: float) -> Optional[str]:
    """If some 4..8-byte window containing [start, start+length) reads as a Unix time within a day of ref (in s, ms,
    µs or ns, little- or big-endian), its unit. Differing bytes are often the low bytes of a longer timestamp."""
    if length > 8:
        return None
    for width in range(max(4, length), 9):
        for ws in range(max(0, start + length - width), min(start, len(region) - width) + 1):
            w = region[ws:ws + width]
            for order in ("little", "big"):
                n = int.from_bytes(w, order)
                for unit, k in TIME_SCALES.items():
                    if abs(n / k - ref) < 86400:
                        return unit
    return None


def _clock_rate(sessions: dict, region: str, start_of, length: int) -> Optional[float]:
    """Ticks per second if some 4..8-byte window containing the field behaves like a clock in every session:
    increasing with receive time (>= 95 % of steps) at a steady rate (p90/p10 of the per-step rates < 1.5)."""
    if length > 8:
        return None
    probe = next(iter(sessions.values()))[0][2]
    rlen = len(probe.coinbase.region_bytes()[region])
    start = start_of(rlen)
    for width in range(max(4, length), 9):
        for ws in range(max(0, start + length - width), min(start, rlen - width) + 1):
            for order in ("big", "little"):
                rates, ups, steps = [], 0, 0
                for rows in sessions.values():
                    prev = None
                    for ts, _, t in rows:
                        r = t.coinbase.region_bytes()[region]
                        if len(r) != rlen:
                            continue
                        v = int.from_bytes(r[ws:ws + width], order)
                        if prev is not None:
                            dt = (ts - prev[0]).total_seconds()
                            if dt > 0.5:
                                steps += 1
                                ups += v > prev[1]
                                if v > prev[1]:
                                    rates.append((v - prev[1]) / dt)
                        prev = (ts, v)
                if steps >= 5 and ups >= 0.95 * steps and len(rates) >= 5:
                    lo, hi = percentile(rates, 10), percentile(rates, 90)
                    if lo > 0 and hi / lo < 1.5:
                        return percentile(rates, 50)
    return None


def classify_location(templates: Iterable[Template], region: str, anchor: tuple[str, int], length: int,
                      pair_share: float = 1.0, job_key: Optional[Callable[[Template], tuple]] = None) -> dict:
    """How the bytes at one differing location behave within each connection session (one extranonce1 of one
    replica, in receive order). pair_share = share of paired templates in which the location differs across the
    replicas. Returns a label and the evidence, never the bytes."""
    job_key = job_key or (lambda t: (t.prev_hash, t.merkle_branches, t.version, t.nbits))
    sessions: dict[tuple[str, bytes], list[tuple[datetime, bytes, Template]]] = defaultdict(list)
    for t in templates:
        v = _slice(t, region, anchor, length)
        if v is not None:
            sessions[(t.replica, t.extranonce1)].append((t.received_at, v, t))
    if not sessions:
        return {"label": "not located", "sessions": 0}
    small = length <= 8
    constant_sessions, n_templates, distinct_ratio = 0, 0, []
    mono, steps_all = [], []
    near_time, en1_copy = 0, 0
    units: Counter = Counter()
    session_values = []
    val_changes = job_changes = both_change = at_new_block = 0
    for key, rows in sessions.items():
        rows.sort(key=lambda r: r[0])
        vals = [v for _, v, _ in rows]
        n_templates += len(vals)
        distinct = len(set(vals))
        constant_sessions += distinct == 1
        distinct_ratio.append(distinct / len(vals))
        session_values.append(vals[0])
        en1 = key[1]
        if len(en1) >= 2 and len(vals[0]) >= 2 and (vals[0] in en1 or en1 in vals[0]):
            en1_copy += 1
        for (_, v0, t0), (_, v1, t1) in zip(rows, rows[1:]):
            vc, jc = v0 != v1, job_key(t0) != job_key(t1)
            val_changes += vc
            job_changes += jc
            both_change += vc and jc
            at_new_block += vc and t0.prev_hash != t1.prev_hash
        if small:
            for _, v, t in rows:
                region_b = t.coinbase.region_bytes()[region]
                start = anchor[1] if anchor[0] == "start" else len(region_b) + anchor[1]
                unit = _time_unit(region_b, start, length, t.received_at.timestamp())
                if unit:
                    near_time += 1
                    units[unit] += 1
            if distinct > 1:
                best = max((_monotonic_share([int.from_bytes(v, o) for v in vals]) for o in ("little", "big")),
                           key=lambda m: m[0])
                mono.append(best[0])
                steps_all.extend(best[1])
    n_sessions = len(sessions)
    ev = {"pair_share": round(pair_share, 3), "sessions": n_sessions, "templates": n_templates,
          "constant_sessions": constant_sessions, "distinct_session_values": len(set(session_values)),
          "mean_distinct_ratio": round(sum(distinct_ratio) / len(distinct_ratio), 3)}
    if en1_copy:
        ev["overlaps_extranonce1"] = en1_copy
    if val_changes or job_changes:
        ev["value_changes"], ev["job_changes"], ev["changed_together"] = val_changes, job_changes, both_change
        ev["changed_at_new_block"] = at_new_block
    if small:
        ev["reads_as_unix_time"] = round(near_time / n_templates, 3)
        if units:
            ev["time_unit"] = units.most_common(1)[0][0]
    pos_steps = [x for x in steps_all if x > 0]
    rate = None
    n_steps = n_templates - n_sessions
    changing = n_steps > 0 and val_changes >= 0.5 * n_steps   # the field's own bytes change with most templates
    if small and changing:
        rate = _clock_rate(sessions, region,
                           (lambda rl: anchor[1]) if anchor[0] == "start" else (lambda rl: rl + anchor[1]), length)
        if rate:
            ev["clock_ticks_per_s"] = float(f"{rate:.2g}")
    if mono:
        ev["monotonic_share"] = round(sum(mono) / len(mono), 3)
        ev["median_step"] = percentile(pos_steps, 50) if pos_steps else None
    follows_job = (val_changes and job_changes and both_change >= 0.95 * val_changes
                   and both_change >= 0.95 * job_changes)
    if pair_share < 0.5:
        label = "usually equal across replicas (job updates seen at different moments)"
    elif constant_sessions == n_sessions:
        label = "per-session constant"
        if en1_copy == n_sessions:
            label += " (extranonce1 bytes)"
        elif len(set(session_values)) < n_sessions:
            label += " (repeats across sessions)"
    elif n_steps and val_changes < 0.2 * n_steps:
        label = "mostly constant per session (changes occasionally)"
    elif small and ev.get("reads_as_unix_time", 0) > 0.9:
        label = f"timestamp ({ev['time_unit']}, low bytes)" if length < 8 else f"timestamp ({ev['time_unit']})"
    elif rate:
        label = f"clock-like (~{ev['clock_ticks_per_s']:g} ticks/s, low bytes)"
    elif ev.get("monotonic_share", 0) > 0.95 and pos_steps and percentile(pos_steps, 50) < 2 ** 16:
        label = "per-session counter"
    elif follows_job:
        label = "per connection, new value with each job"
    elif ev["mean_distinct_ratio"] > 0.9:
        label = "random (new value per template)"
    elif ev["mean_distinct_ratio"] < 0.5:
        label = "changes occasionally"
    else:
        label = "varies within a session"
    ev["label"] = label
    return ev


# ---------------------------------------------------------------------------------------------------- job keys

KEYS: dict[str, Callable[[Template], tuple]] = {
    "prev_hash+merkle+version+nbits": lambda t: (t.prev_hash, t.merkle_branches, t.version, t.nbits),
    "prev_hash+merkle+version+nbits+ntime": lambda t: (t.prev_hash, t.merkle_branches, t.version, t.nbits, t.ntime),
    "prev_hash+merkle": lambda t: (t.prev_hash, t.merkle_branches),
    "prev_hash+merkle+version+nbits+outputs": lambda t: (t.prev_hash, t.merkle_branches, t.version, t.nbits,
                                                         t.outputs_digest()),
}


def job_key_stats(a: list[Template], b: list[Template], key: Callable[[Template], tuple],
                  tie_ms: float = 0.0) -> dict:
    """Jobs under one candidate key: which replicas saw them, and when each first did."""
    first: dict[str, dict] = {"a": {}, "b": {}}
    count: dict[str, Counter] = {"a": Counter(), "b": Counter()}
    outputs: dict[tuple, set] = defaultdict(set)
    for side, rows in (("a", a), ("b", b)):
        for t in rows:
            k = key(t)
            count[side][k] += 1
            outputs[k].add(t.outputs_digest())
            if k not in first[side] or t.received_at < first[side][k]:
                first[side][k] = t.received_at
    ka, kb = set(first["a"]), set(first["b"])
    both = ka & kb
    offsets_ms, a_first, b_first, ties = [], 0, 0, 0
    for k in both:
        d = (first["b"][k] - first["a"][k]).total_seconds() * 1000
        offsets_ms.append(abs(d))
        if abs(d) <= tie_ms:
            ties += 1
        elif d > 0:
            a_first += 1
        else:
            b_first += 1
    union = ka | kb
    return {"jobs_a": len(ka), "jobs_b": len(kb), "matched": len(both), "only_a": len(ka - kb),
            "only_b": len(kb - ka), "match_rate": len(both) / len(union) if union else None,
            "templates_per_job_a": round(sum(count["a"].values()) / len(ka), 2) if ka else None,
            "templates_per_job_b": round(sum(count["b"].values()) / len(kb), 2) if kb else None,
            "jobs_with_several_output_sets": sum(len(v) > 1 for v in outputs.values()),
            "offset_ms": dist(offsets_ms), "a_first": a_first, "b_first": b_first, "ties": ties}


def only_one_side_detail(a: list[Template], b: list[Template], key: Callable[[Template], tuple]) -> dict:
    """For jobs only one replica saw: how long after the replica's previous job (ms), i.e. were they short-lived
    updates superseded before the other connection got them?"""
    ka, kb = {key(t) for t in a}, {key(t) for t in b}
    out = {}
    for side, rows, other in (("a", a, kb), ("b", b, ka)):
        rows = sorted(rows, key=lambda t: t.received_at)
        seen, lifetimes, clean, n = set(), [], 0, 0
        for i, t in enumerate(rows):
            k = key(t)
            if k in seen:
                continue
            seen.add(k)
            if k in other:
                continue
            n += 1
            nxt = next((u for u in rows[i + 1:] if key(u) != k), None)
            if nxt is not None:
                lifetimes.append((nxt.received_at - t.received_at).total_seconds() * 1000)
            clean += t.clean_jobs
        out[side] = {"jobs": n,
                     "clean_jobs": clean, "lifetime_ms": dist(lifetimes)}
    return out


# ---------------------------------------------------------------------------------------------------- per pool

def analyze_pool(rows: list[Template], replicas: tuple[str, str] = ("a", "b"), max_offset_s: float = 2.0,
                 tie_ms: float = 0.0) -> dict:
    ra, rb = replicas
    a = [t for t in rows if t.replica == ra]
    b = [t for t in rows if t.replica == rb]
    res: dict = {"templates": {ra: len(a), rb: len(b)},
                 "sessions": {ra: len({t.extranonce1 for t in a}), rb: len({t.extranonce1 for t in b})},
                 "chains": dict(Counter(t.chain for t in rows)),
                 "undecodable_coinbases": sum(t.coinbase is None for t in rows)}
    if not a or not b:
        res["skipped"] = f"needs templates from both replicas {ra!r} and {rb!r}"
        return res
    pairs = pair_templates(a, b, max_offset_s)
    res["pairs"] = len(pairs)
    res["unpaired"] = {ra: len(a) - len(pairs), rb: len(b) - len(pairs)}
    res["pair_offset_ms"] = dist([abs((y.received_at - x.received_at).total_seconds()) * 1000 for x, y in pairs])
    res["field_equal_share"] = field_equality(pairs)
    cd = coinbase_diff(pairs)
    cd_out = {k: (dict(v.most_common()) if isinstance(v, Counter) else v) for k, v in cd.items()}
    for f in cd_out["fields"]:
        f["classification"] = classify_location(a + b, f["region"], (f["anchor"], f["offset"]), f["length"],
                                                f["share"])
    res["coinbase"] = cd_out
    res["job_keys"] = {name: job_key_stats(a, b, fn, tie_ms) for name, fn in KEYS.items()}
    res["unmatched_jobs"] = only_one_side_detail(a, b, KEYS["prev_hash+merkle+version+nbits"])
    return res
