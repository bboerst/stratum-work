#!/usr/bin/env python3
"""Compare two Trivy JSON reports (the PR's image vs the component's :main image) and report fixable findings the PR
adds. Used by .github/workflows/images.yml (job `scan`, pull requests only).

    new_vulns.py PR.json [MAIN.json] --component NAME --fail-on CRITICAL [--summary FILE]

A finding is (vulnerability id, package, installed version); "fixable" = Trivy has a fixed version. Only findings in
the PR's image and not in :main count as new, so a vulnerable base image that :main already has doesn't block every
PR (the deployment's own scanning tracks those). Without MAIN.json (no :main image yet) every finding is new.
Exit 1 if a new fixable finding has a severity in --fail-on. The summary (Markdown) lists new findings only, and
counts for the rest.
"""
import argparse
import json
import sys

SEVERITIES = ("CRITICAL", "HIGH")


def fixable(report: dict) -> dict:
    out = {}
    for r in report.get("Results") or []:
        for v in r.get("Vulnerabilities") or []:
            if v.get("Severity") not in SEVERITIES:
                continue
            status = v.get("Status")
            if not (status == "fixed" if status else v.get("FixedVersion")):
                continue
            key = (v.get("VulnerabilityID"), v.get("PkgName"), v.get("InstalledVersion"))
            out.setdefault(key, {"id": key[0], "pkg": key[1], "installed": key[2], "severity": v["Severity"],
                                 "fixed": v.get("FixedVersion") or "", "target": r.get("Target") or "",
                                 "url": v.get("PrimaryURL") or ""})
    return out


def compare(pr: dict, main) -> tuple:
    pr_f = fixable(pr)
    main_f = fixable(main) if main is not None else {}
    new = [pr_f[k] for k in sorted(pr_f, key=lambda k: (SEVERITIES.index(pr_f[k]["severity"]), k)) if k not in main_f]
    fixed = [k for k in main_f if k not in pr_f]
    return new, len(pr_f), len(fixed)


def summary(component: str, new: list, total: int, fixed: int, has_main: bool, fail_on: set) -> str:
    lines = [f"### Trivy: `{component}`", ""]
    base = "`:main`" if has_main else "nothing (no `:main` image yet)"
    lines.append(f"{total} fixable HIGH/CRITICAL in this PR's image (linux/amd64); **{len(new)} new** compared with "
                 f"{base}" + (f", {fixed} fixed by this PR" if has_main else "") + ".")
    if new:
        lines += ["", "| Severity | Vulnerability | Package | Installed | Fixed in |", "|---|---|---|---|---|"]
        for f in new:
            vid = f"[{f['id']}]({f['url']})" if f["url"] else f["id"]
            mark = " ❌" if f["severity"] in fail_on else ""
            lines.append(f"| {f['severity']}{mark} | {vid} | `{f['pkg']}` | {f['installed']} | {f['fixed']} |")
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pr")
    ap.add_argument("main", nargs="?")
    ap.add_argument("--component", required=True)
    ap.add_argument("--fail-on", default="CRITICAL", help="comma-separated severities that fail the check")
    ap.add_argument("--summary")
    a = ap.parse_args(argv)
    with open(a.pr) as fh:
        pr = json.load(fh)
    main_r = None
    if a.main:
        with open(a.main) as fh:
            main_r = json.load(fh)
    fail_on = {s.strip().upper() for s in a.fail_on.split(",") if s.strip()}
    new, total, fixed = compare(pr, main_r)
    text = summary(a.component, new, total, fixed, main_r is not None, fail_on)
    print(text)
    if a.summary:
        with open(a.summary, "a") as fh:
            fh.write(text + "\n")
    bad = [f for f in new if f["severity"] in fail_on]
    if bad:
        print(f"::error::{a.component}: {len(bad)} new fixable {'/'.join(sorted(fail_on))} finding(s): "
              + ", ".join(f"{f['id']} ({f['pkg']})" for f in bad[:10]), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
