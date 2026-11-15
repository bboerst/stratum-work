"""Render the analysis as Markdown. Counts, shares, offsets and positions only."""
from __future__ import annotations

from .analyze import FIELDS


def _pct(x) -> str:
    return "–" if x is None else f"{100 * x:.1f} %"


def _ms(x) -> str:
    return "–" if x is None else (f"{x:.1f}" if x < 100 else f"{x:.0f}")


def _dist(d: dict) -> str:
    return f"{_ms(d['p50'])} / {_ms(d['p95'])} / {_ms(d['max'])}"


def _n(x) -> str:
    return "–" if x is None else str(x)


def _dedup_section(rows) -> list[str]:
    """The database's template_dedup_report: what the read path's de-duplication does with these replicas."""
    out = ["", "## De-duplication on the read path (`template_dedup_report`)", ""]
    if rows is None:
        return out + ["Not available: the database has no `template_dedup_report` (migration "
                      "`20261115000001_templates_dedup.sql`).", ""]
    if not rows:
        return out + ["No templates in the window.", ""]
    out += ["Per UTC day, pool and site (*all* = the pool's total; every site, regardless of `--site`). Per pool and "
            "height the first source by (site, replica) is the primary; its rows are all shown. A secondary row is "
            "hidden only as an exact copy of a primary row (same prev_hash, merkle_branches, version, nbits, ntime). "
            "*Near miss* = same job, other ntime (|Δntime| 1 / 2 / 3 / 4–10 / >10 s); *gap fill* = a job the primary "
            "doesn't have; *extra* = more exact copies than the primary has. *Gains*: for *all*, shown primary rows "
            "whose first_seen came from an earlier copy; per site, that site's copies that beat the primary row.", "",
            "| day | pool | site | rows | primary | secondary | hidden (exact copies) | shown | extra | near misses "
            "| Δntime 1 / 2 / 3 / 4–10 / >10 s | gap fills | gains | gain ms p50 / p95 / max |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        out.append(f"| {r['day']} | {r['pool']} | {r['site'] or '*all*'} | {r['rows']} | {r['primary_rows']} "
                   f"| {r['secondary_rows']} | {r['secondary_hidden']} | {r['secondary_shown']} | {r['extra_copies']} "
                   f"| {r['near_misses']} | {r['near_miss_ntime_1s']} / {r['near_miss_ntime_2s']} / "
                   f"{r['near_miss_ntime_3s']} / {r['near_miss_ntime_4_10s']} / {r['near_miss_ntime_over_10s']} "
                   f"| {r['gap_fills']} | {_n(r['first_seen_gains'])} "
                   f"| {_ms(r['gain_ms_p50'])} / {_ms(r['gain_ms_p95'])} / {_ms(r['gain_ms_max'])} |")
    return out + [""]


def render(result: dict) -> str:
    meta, pools = result["meta"], result["pools"]
    ra, rb = meta["replicas"]
    out = ["# Replica comparison", "",
           f"Window `{meta['since']}` – `{meta['until']}` (UTC), replicas `{ra}` vs `{rb}`"
           + (f", site `{meta['site']}`" if meta.get("site") else "")
           + ". Templates are paired by `prev_hash` and nearest receive time "
           f"(at most {meta['max_offset_s']} s apart).",
           ""]
    k1 = "prev_hash+merkle+version+nbits"
    out += ["## Summary", "",
            f"| pool | templates {ra} / {rb} | sessions {ra} / {rb} | pairs | pair offset ms p50 / p95 / max "
            f"| coinbase outputs equal | jobs matched (`{k1}`) | only {ra} / {rb} "
            "| first-seen offset ms p50 / p95 / max "
            f"| {ra} first / {rb} first / tie |",
            "|---|---|---|---|---|---|---|---|---|---|"]
    for name, p in pools.items():
        t, s = p["templates"], p["sessions"]
        if "skipped" in p:
            out.append(f"| {name} | {t.get(ra, 0)} / {t.get(rb, 0)} | {s.get(ra, 0)} / {s.get(rb, 0)} | skipped: "
                       f"{p['skipped']} | | | | | | |")
            continue
        j = p["job_keys"][k1]
        out.append(f"| {name} | {t[ra]} / {t[rb]} | {s[ra]} / {s[rb]} | {p['pairs']} | {_dist(p['pair_offset_ms'])} "
                   f"| {_pct(p['field_equal_share']['coinbase_outputs'])} | {_pct(j['match_rate'])} "
                   f"| {j['only_a']} / {j['only_b']} | {_dist(j['offset_ms'])} | {j['a_first']} / {j['b_first']} / "
                   f"{j['ties']} |")
    out += _dedup_section(result.get("dedup"))
    active = {n: p for n, p in pools.items() if "skipped" not in p}
    if not active:
        return "\n".join(out + ["", "No pool has templates from both replicas in the window."])
    names = list(active)
    out += ["", "## Field equality across paired templates", "",
            "| field | " + " | ".join(names) + " |", "|---|" + "---|" * len(names)]
    for f in FIELDS + ("coinbase_outputs", "coinbase_lengths"):
        out.append(f"| `{f}` | " + " | ".join(_pct(active[n]["field_equal_share"][f]) for n in names) + " |")

    out += ["", "## Candidate job keys", "",
            "Jobs = distinct key values per replica. Match rate = jobs both replicas saw / all jobs. "
            "First-seen offset = |first receive on b − first receive on a| per matched job. "
            "*Several output sets* = jobs whose templates carry different coinbase outputs (the key merges them).", ""]
    for name in names:
        p = active[name]
        out += [f"### {name}", "",
                f"| key | jobs {ra} / {rb} | matched | only {ra} / {rb} | match rate | templates/job {ra} / {rb} "
                f"| several output sets | offset ms p50 / p95 / max | {ra} first / {rb} first / tie |",
                "|---|---|---|---|---|---|---|---|---|"]
        for key, j in p["job_keys"].items():
            out.append(f"| `{key}` | {j['jobs_a']} / {j['jobs_b']} | {j['matched']} | {j['only_a']} / {j['only_b']} "
                       f"| {_pct(j['match_rate'])} | {j['templates_per_job_a']} / {j['templates_per_job_b']} "
                       f"| {j['jobs_with_several_output_sets']} | {_dist(j['offset_ms'])} "
                       f"| {j['a_first']} / {j['b_first']} / {j['ties']} |")
        u = p["unmatched_jobs"]
        out += ["", f"Jobs only one replica saw (`{k1}`): {ra} {u['a']['jobs']} "
                    f"(clean_jobs {u['a']['clean_jobs']}, lived ms p50/p95/max {_dist(u['a']['lifetime_ms'])}), "
                    f"{rb} {u['b']['jobs']} (clean_jobs {u['b']['clean_jobs']}, lived ms p50/p95/max "
                    f"{_dist(u['b']['lifetime_ms'])}). *Lived* = time until that replica's next job.", ""]

    out += ["## Coinbase structure", "",
            "Each coinbase is rebuilt as coinbase1 + extranonce1 + zero extranonce2 + coinbase2 and decoded. The "
            "extranonce is masked: only the bytes around it are compared. Regions: `header` (version, input, prevout, "
            "scriptSig length), `sig_pre` / `sig_post` (scriptSig before / after the extranonce), `sequence`, "
            "`out<i>.value` / `out<i>.script`, `locktime`. A field's position is given from the region start and from "
            "its end (negative; the stable anchor for `sig_post` and regions whose length varies). A *field* is a run "
            "of adjacent bytes that differ in at least 2 % of the pairs; *session* = one extranonce1 of one "
            "replica.", ""]
    for name in names:
        c = active[name]["coinbase"]
        d = c["decoded"] or 1
        out += [f"### {name}", "",
                f"- decoded pairs: {c['decoded']} of {c['pairs']}; identical outside the extranonce: "
                f"{_pct(c['identical_outside_extranonce'] / d)}",
                f"- **outputs identical (values + scriptPubKeys): {_pct(c['outputs_identical'] / d)}**"
                + (f" — count differs {c['output_count_differs']}, values differ {c['output_values_differ']}, "
                   f"scripts differ {c['output_scripts_differ']}; differing outputs by kind: "
                   + ", ".join(f"{k} {v}" for k, v in c["differing_output_kinds"].items())
                   if c["outputs_identical"] < c["decoded"] else ""),
                f"- scriptSig differs: {_pct(c['scriptsig_differs'] / d)} (length differs "
                f"{_pct(c['scriptsig_length_differs'] / d)})",
                "- differing regions (pairs): " + (", ".join(f"`{k}` {v}" for k, v in c["regions"].items()) or "none")]
        if c["same_job_id"]:
            out.append(f"- same `job_id` on both replicas: {c['same_job_id']} pairs, coinbase identical outside the "
                       f"extranonce in {c['same_job_id_identical']} of them (both connections were served by the same "
                       "job builder)")
        out.append("- extranonce sits in: " + ", ".join(f"`{k}` {v}" for k, v in c["extranonce_regions"].items()))
        if c["region_length_differs"]:
            out.append("- region length differs (pairs): "
                       + ", ".join(f"`{k}` {v}" for k, v in c["region_length_differs"].items()))
        if c["fields"]:
            out += ["", "| region (usual length) | bytes from start / from end | length | pairs differing "
                    "| classification | evidence |", "|---|---|---|---|---|---|"]
            for f in c["fields"]:
                cls = dict(f["classification"])
                label = cls.pop("label")
                ev = ", ".join(f"{k} {v}" for k, v in cls.items())
                out.append(f"| `{f['region']}` ({f['region_length']}) | {f['from_start']} / {f['from_end']} "
                           f"| {f['length']} "
                           f"| {f['pairs']} ({_pct(f['share'])}) | {label} | {ev} |")
        out.append("")
    return "\n".join(out)
