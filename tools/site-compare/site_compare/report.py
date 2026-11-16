"""Markdown and JSON rendering of a comparison result."""
from __future__ import annotations

from .compare import CLASS_ORDER, class_family, delta_stats

CLASS_HELP = {
    "extra_copy": "same job key on both sides, more copies on this side",
    "near_miss": "same job on the other side, differs only in the named fields",
    "pool_one_side_only": "the other side has no template from this pool in the whole range",
    "pool_missing_at_height": "the other side has the pool elsewhere, but nothing at this height",
    "before_other_started": "before the other side's first template of the pool in the whole range (collection "
                            "started later there)",
    "other_prev_hash": "the other side has the pool at this height, never with this prev_hash",
    "other_source_missing": "the other side's source that usually matches this side shows nothing at this height "
                            "(its rows here come from another connection)",
    "before_other_first": "earlier than the other side's first template of the pool at this height (beyond the gap)",
    "after_other_last": "later than the other side's last template of the pool at this height (beyond the gap)",
    "other_side_gap": "inside the other side's span, but nothing from the pool there within the gap",
    "multi_source": "this side shows several sources of the pool at this height: a second connection's own jobs",
    "unexplained": "none of the above",
}


def pool_json(name: str, pt) -> dict:
    return {"pool": name, "templates_a": pt.templates["a"], "templates_b": pt.templates["b"],
            "sources_a": pt.sources["a"], "sources_b": pt.sources["b"],
            "heights_a": len(pt.heights["a"]), "heights_b": len(pt.heights["b"]), "matched": pt.matched,
            "only_a": dict(sorted(pt.only["a"].items())), "only_b": dict(sorted(pt.only["b"].items())),
            "first_seen_delta_ms": delta_stats(pt.deltas_ms),
            "r4_first_seen_delta_ms": delta_stats(pt.first_seen_deltas_ms),
            "matched_clean_jobs_differ": pt.clean_jobs_differ, "matched_extranonce2_length_differ": pt.en2_len_differ,
            "matched_extranonce1_length_differ": pt.en1_len_differ, "matched_coinbase_identical": pt.coinbase_identical}


def to_json(result: dict) -> dict:
    t = result["templates"]
    out = dict(result)
    out["templates"] = {"pools": [pool_json(n, pt) for n, pt in sorted(t["pools"].items())],
                        "heights": t["heights"], "unexplained_examples": t["unexplained_examples"],
                        "pools_only_on_a": sorted(t["pools_anywhere"]["a"] - t["pools_anywhere"]["b"]),
                        "pools_only_on_b": sorted(t["pools_anywhere"]["b"] - t["pools_anywhere"]["a"])}
    return out


def _f(v, digits=1):
    return "–" if v is None else f"{v:.{digits}f}"


def _classes(c: dict) -> str:
    fam = {}
    for k, v in c.items():
        fam.setdefault(class_family(k), []).append((k, v))
    parts = []
    for f in CLASS_ORDER:
        for k, v in sorted(fam.get(f, [])):
            parts.append(f"{k} {v}")
    return ", ".join(parts) or "–"


def render(result: dict) -> str:
    j = to_json(result)
    m, t, b, fs = j["meta"], j["templates"], j["blocks"], j["first_seen"]
    pools = t["pools"]
    tot = lambda k: sum(p[k] for p in pools)  # noqa: E731
    only_a = sum(sum(p["only_a"].values()) for p in pools)
    only_b = sum(sum(p["only_b"].values()) for p in pools)
    L = [f"# Site comparison: A vs B, heights {m['from']}–{m['to']}", "",
         f"- **A:** {m['a']}  (tip {m['tip_a']})", f"- **B:** {m['b']}  (tip {m['tip_b']})",
         f"- Range: {m['from']}–{m['to']} ({m['heights']} heights; {m['range_reason']})",
         f"- Generated {m['generated']}; run time {m['run_time_s']} s; requests: {m['requests']['network_requests']} "
         f"network ({m['requests']['retries']} retries, {m['requests']['bytes'] / 1e6:.1f} MB), "
         f"{m['requests']['cache_hits']} from cache; rate limit {m['rate']}/s",
         f"- Time gap for the classification: {m['gap_s']} s. Deltas are B minus A (negative: B saw it first).", ""]

    L += ["## Summary", "", "| Check | Result |", "|---|---|"]
    bs = b["summary"]
    L.append(f"| Blocks | {bs.get('identical', 0)} identical, {bs.get('different', 0)} different "
             f"(hash differs {bs.get('hash_differs', 0)}, only A {bs.get('only_a', 0)}, only B {bs.get('only_b', 0)}, "
             f"field differences: " + (", ".join(f"{k.split(':', 1)[1]} {v}" for k, v in sorted(bs.items())
                                                 if k.startswith('differs:')) or "none") + ") |")
    pct = 100 * tot("matched") / max(1, min(tot("templates_a"), tot("templates_b")))
    L.append(f"| Templates | A {tot('templates_a')}, B {tot('templates_b')}, matched {tot('matched')} "
             f"({pct:.1f} % of the smaller side), only A {only_a}, only B {only_b} |")
    cls = {"a": {}, "b": {}}
    for p in pools:
        for s in "ab":
            for k, v in p[f"only_{s}"].items():
                cls[s][class_family(k)] = cls[s].get(class_family(k), 0) + v
    L.append(f"| Only on A, by class | {_classes(cls['a'])} |")
    L.append(f"| Only on B, by class | {_classes(cls['b'])} |")
    L.append(f"| Pools with templates on one side only | A: {', '.join(t['pools_only_on_a']) or 'none'}; "
             f"B: {', '.join(t['pools_only_on_b']) or 'none'} |")
    L.append(f"| First seen per block (R4) | {fs['n']} heights; same pool set {fs['same_pool_set']}, same order of "
             f"common pools {fs['same_order_of_common_pools']}, Kendall tau {_f(fs['kendall_tau'], 3)}, "
             f"reliable flag differs {fs['reliable_flag_differs']} times |")
    pl = j["pools_list"]
    L.append(f"| Pools list (R7) | A {pl['count_a']}, B {pl['count_b']}; only A: {', '.join(pl['only_a']) or 'none'}; "
             f"only B: {', '.join(pl['only_b']) or 'none'}; field differences {len(pl['field_differences'])}; "
             f"same order: {'yes' if pl['same_order'] else 'no'} |")
    it = j.get("interesting")
    if it:
        L.append(f"| Interesting blocks (R3), heights {it['from']}–{it['to']} | A {it['count_a']}, B {it['count_b']}; "
                 f"only A {it['only_a'] or 'none'}, only B {it['only_b'] or 'none'}, differ {len(it['differ'])} |")
    L.append("")

    L += ["## Per pool", "",
          "Templates matched by job key. Δ = first-seen B minus A of matched templates (ms); R4 Δ = the pool's "
          "first template per height (ms). Sources: distinct collector connections with shown rows, named by the "
          "template ids (? when a site's ids don't name them; a second collector's exact copies are hidden by the "
          "read path, so a pool whose connections get identical jobs shows one).", "",
          "| Pool | Sources A/B | Heights A/B | Templates A/B | Matched | Only A | Only B | Δ p50 | Δ p95 | Δ min / max | "
          "B first | R4 Δ p50 | Coinbase identical |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for p in pools:
        d, r4 = p["first_seen_delta_ms"], p["r4_first_seen_delta_ms"]
        share = f"{100 * d['b_earlier_share']:.0f} %" if d["n"] else "–"
        cb = f"{100 * p['matched_coinbase_identical'] / p['matched']:.0f} %" if p["matched"] else "–"
        src = "/".join(str(p[f"sources_{x}"] or "?") for x in "ab")
        L.append(f"| {p['pool']} | {src} | {p['heights_a']}/{p['heights_b']} | {p['templates_a']}/{p['templates_b']} | "
                 f"{p['matched']} | {_classes(p['only_a'])} | {_classes(p['only_b'])} | {_f(d.get('p50'))} | "
                 f"{_f(d.get('p95'))} | {_f(d.get('min'))} / {_f(d.get('max'))} | {share} | {_f(r4.get('p50'))} | {cb} |")
    odd = [p for p in pools if p["matched_clean_jobs_differ"] or p["matched_extranonce2_length_differ"]
           or p["matched_extranonce1_length_differ"]]
    if odd:
        L += ["", "Matched templates whose per-template fields differ (job key equal):", ""]
        for p in odd:
            L.append(f"- {p['pool']}: clean_jobs {p['matched_clean_jobs_differ']}, extranonce2_length "
                     f"{p['matched_extranonce2_length_differ']}, extranonce1 length {p['matched_extranonce1_length_differ']}")
    L += ["", "Classes of templates found on one side only:", ""]
    L += [f"- `{k}`: {v}" for k, v in CLASS_HELP.items()]
    L.append("")

    L += ["## Per height", "", "| Height | Templates A/B | Matched | Only A | Only B | Pools A/B | R4 pools A/B | "
          "R4 same order |", "|---|---|---|---|---|---|---|---|"]
    r4 = {r["height"]: r for r in fs["heights"]}
    for r in t["heights"]:
        f = r4.get(r["height"], {})
        L.append(f"| {r['height']} | {r['a']}/{r['b']} | {r['matched']} | {r['only_a']} | {r['only_b']} | "
                 f"{r['pools_a']}/{r['pools_b']} | {f.get('pools_a', '–')}/{f.get('pools_b', '–')} | "
                 f"{'yes' if f.get('same_order') else 'no' if f else '–'} |")
    L.append("")

    L += ["## Block differences", ""]
    if not b["differences"]:
        L.append("None: every height has the same block hash and identical block fields (ids aside).")
    for d in b["differences"]:
        L.append(f"- **{d['height']}** {d['kind']}" + (f" ({d['hash'][:16]}…)" if d.get("hash") else ""))
        if d.get("pool_a") and d["pool_a"] != d.get("pool_b"):
            L.append(f"  - pool: A {d['pool_a']} vs B {d['pool_b']}")
        for x in d["details"][:12]:
            L.append(f"  - `{x}`")
    L.append("")

    L += ["## First seen per block (R4)", ""]
    for s in "ab":
        only = fs[f"pool_only_on_{s}_heights"]
        L.append(f"- Pools only on {s.upper()} (heights): " + (", ".join(f"{k} ({v})" for k, v in sorted(only.items()))
                                                             or "none"))
    diff_order = [r for r in fs["heights"] if not r["same_order"]]
    L.append(f"- Heights where the common pools' order differs: {len(diff_order)} of {fs['n']}"
             + (" (" + ", ".join(f"{r['height']}: {r['discordant_pairs']}/{r['pairs']} pairs" for r in diff_order[:30])
                + (", …" if len(diff_order) > 30 else "") + ")" if diff_order else ""))
    L.append("")

    if pl["field_differences"] or pl["duplicates_a"] or pl["duplicates_b"]:
        L += ["## Pools list (R7) differences", ""]
        L += [f"- {d['name']}: {', '.join(d['differs'])}" for d in pl["field_differences"]]
        if pl["duplicates_a"] or pl["duplicates_b"]:
            L.append(f"- duplicate names: A {pl['duplicates_a']}, B {pl['duplicates_b']}")
        L.append("")
    if it and it["differ"]:
        L += ["## Interesting blocks (R3) differences", ""]
        for d in it["differ"]:
            L.append(f"- **{d['height']}**: " + "; ".join(f"`{x}`" for x in d["details"][:6]))
        L.append("")
    if t["unexplained_examples"]:
        L += ["## Unexplained templates (examples)", ""]
        for e in t["unexplained_examples"][:30]:
            L.append(f"- {e['height']} only on {e['side'].upper()}: {e['pool']} ts={e['timestamp']} ({e['detail']})")
        L.append("")
    return "\n".join(L)
