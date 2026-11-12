"""`m2p report`: what the migration did, from its bookkeeping (Markdown, for the issue / sign-off)."""
from __future__ import annotations

import json
from collections import Counter

import psycopg

from .target import SCHEMA


def build(pg_kw: dict, site: str, verify_json: dict | None = None) -> str:
    with psycopg.connect(**pg_kw, autocommit=True) as pg:
        days = pg.execute(f"""SELECT day, until, mongo_docs, templates, templates_other, duplicates, rejected, seconds,
                                     stats FROM {SCHEMA}.days WHERE site = %s ORDER BY day""", (site,)).fetchall()
        findings = pg.execute(f"""SELECT day, height, offset_s, count, corrected, evidence FROM {SCHEMA}.tz_findings
                                  WHERE site = %s ORDER BY height, day""", (site,)).fetchall()
        rejected = pg.execute(f"""SELECT reason, count(*), min(mongo_id), min(detail) FROM {SCHEMA}.rejected
                                  WHERE site = %s GROUP BY 1 ORDER BY 2 DESC""", (site,)).fetchall()
        sources = pg.execute("SELECT count(*) FROM sources WHERE site = %s", (site,)).fetchone()[0]
    out = [f"# MongoDB → Postgres backfill report (site `{site}`)", ""]
    if not days:
        return "\n".join(out + ["No days migrated yet."])
    tot = Counter()
    formats, reasons, unknown = Counter(), Counter(), Counter()
    dup_identical = dup_differing = height_changed = 0
    dup_samples, hc_samples = [], []
    for d, until, m, t, o, dup, rej, sec, st in days:
        tot.update(mongo=m, templates=t, other=o, dups=dup, rejected=rej)
        tot["seconds"] += sec
        formats.update(st.get("formats", {}))
        reasons.update(st.get("reasons", {}))
        unknown.update(st.get("unknown_fields", {}))
        dup_identical += st.get("duplicates_identical", 0)
        dup_differing += st.get("duplicates_differing", 0)
        height_changed += st.get("height_changed", 0)
        dup_samples += st.get("duplicate_samples", [])
        hc_samples += st.get("height_changed_samples", [])
    partial = [(d, u) for d, u, *_ in days if u is not None]
    out += [
        f"- **Days:** {len(days)} ({days[0][0]} … {days[-1][0]})" + (
            f"; partial (cut at): " + ", ".join(f"{d} < {u.isoformat()}" for d, u in partial) if partial else ""),
        f"- **MongoDB documents:** {tot['mongo']:,} from {sources} sources",
        f"- **→ `templates`:** {tot['templates']:,}; **`templates_other`:** {tot['other']:,}; "
        f"**duplicates dropped:** {tot['dups']:,} ({dup_identical:,} identical, {dup_differing:,} differing); "
        f"**rejected:** {tot['rejected']:,}",
        f"- **Throughput:** {tot['mongo'] / tot['seconds']:,.0f} docs/s per worker "
        f"(sum of per-day seconds {tot['seconds']:,.1f} s, read + convert + COPY)" if tot["seconds"] else "",
        f"- **Timestamp formats:** " + ", ".join(f"{k} {v:,}" for k, v in formats.most_common()),
        f"- **Height re-derived differently from MongoDB's stored `height`:** {height_changed:,}",
        "",
        "## Routing (`templates_other` by reason)",
        "| reason | rows | share |", "|---|---|---|",
    ]
    total = tot["templates"] + tot["other"]
    out += [f"| `{r}` | {n:,} | {n / total:.3%} |" for r, n in reasons.most_common()] or ["| (none) | 0 | |"]
    out += ["", "## Timezone safety net", ""]
    corrected = [f for f in findings if f[4]]
    suspects = [f for f in findings if not f[4]]
    if not findings:
        out.append("No height shows a −6 h / −7 h shift. Nothing was corrected.")
    else:
        out += [f"Corrected heights: {len(corrected)} ({sum(f[3] for f in corrected):,} templates). "
                f"Suspects (one signal only, not changed): {len(suspects)}.", "",
                "| height | day | offset | templates | received − ntime (median) | first − block(h−1) | corrected |",
                "|---|---|---|---|---|---|---|"]
        for d, h, off, n, corr, ev in findings:
            out.append(f"| {h} | {d} | {off / 3600:+.0f} h | {n} | {ev['median_vs_ntime_s'] / 3600:+.2f} h | "
                       f"{'' if ev['first_vs_prev_block_s'] is None else format(ev['first_vs_prev_block_s'] / 3600, '+.2f') + ' h'} | "
                       f"{'yes' if corr else 'no (suspect)'} |")
    out += ["", "## Rejected documents (not loaded; full documents in `mongo_to_postgres.rejected`)", ""]
    out += [f"- `{r}`: {n:,} (e.g. `_id` {i}: {det})" for r, n, i, det in rejected] or ["None."]
    if unknown:
        out += ["", "## Fields not carried over", ""] + [f"- `{k}`: {v:,} documents" for k, v in unknown.most_common()]
    if dup_samples:
        out += ["", "## Duplicate samples", ""] + [f"- {json.dumps(s)}" for s in dup_samples[:10]]
    if hc_samples:
        out += ["", "## Height re-derivation samples", ""] + [f"- {json.dumps(s)}" for s in hc_samples[:10]]
    out += ["", "## Per day", "| day | docs | templates | other | dups | rejected | s | docs/s |",
            "|---|---|---|---|---|---|---|---|"]
    out += [f"| {d}{' (partial)' if u else ''} | {m:,} | {t:,} | {o:,} | {dup:,} | {rej:,} | {sec:.1f} | "
            f"{m / sec if sec else 0:,.0f} |" for d, u, m, t, o, dup, rej, sec, _ in days]
    if verify_json:
        out += ["", "## Verification", "", "| check | status |", "|---|---|"]
        out += [f"| {c['name']} | **{c['status']}** |" for c in verify_json["checks"]]
    return "\n".join(x for x in out if x is not None)
