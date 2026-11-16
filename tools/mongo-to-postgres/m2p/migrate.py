"""`m2p migrate`: copy MongoDB history into Postgres, one UTC day per transaction, oldest first, resumable."""
from __future__ import annotations

import json
import logging
import multiprocessing as mp
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, NamedTuple, Optional

from . import tzshift
from .cuts import Cuts, bounds, source_name
from .convert import Converted, DayTips, Reject, TipIndex, convert, is_btc, route_converted
from .target import Target

LOG = logging.getLogger("m2p.migrate")
MAX_SAMPLES = 5
LIVE_SAFETY = timedelta(minutes=2)   # a still-growing day is cut this far behind "now" (inserts can lag receipt)


@dataclass
class DayResult:
    """A converted day, ready for COPY. Rows reference sources by name until ids are known."""
    btc: list = field(default_factory=list)          # (Converted, None)
    other: list = field(default_factory=list)        # (Converted, Route)
    rejected: list = field(default_factory=list)     # (mongo_id, source, reason, detail, doc json)
    duplicates: list = field(default_factory=list)   # (kept mongo_id, dropped mongo_id, identical?)
    findings: list = field(default_factory=list)     # tzshift.Finding
    per_source: dict = field(default_factory=lambda: defaultdict(Counter))
    summary: dict = field(default_factory=dict)


def build_day(docs: Iterable[dict], tips: TipIndex) -> DayResult:
    """Convert, correct (timezone safety net), de-duplicate and route one day's documents. No I/O."""
    res = DayResult()
    formats, reasons, unknown = Counter(), Counter(), Counter()
    height_changed, n_docs = 0, 0
    height_changed_samples, dup_samples = [], []
    converted: list[Converted] = []
    for doc in docs:
        n_docs += 1
        src = source_name(doc)
        res.per_source[src]["mongo_docs"] += 1
        try:
            c = convert(doc)
        except Reject as exc:
            res.per_source[src]["rejected"] += 1
            res.rejected.append((str(doc.get("_id")), src, exc.reason, str(exc)[:500], json.dumps(doc, default=str)))
            continue
        converted.append(c)
        formats[c.fmt] += 1
        for k in c.unknown_fields:
            unknown[k] += 1
        if c.stored_height != c.height:
            height_changed += 1
            if len(height_changed_samples) < MAX_SAMPLES:
                height_changed_samples.append(dict(_id=c.mongo_id, source=c.source, stored=c.stored_height, rederived=c.height))

    res.findings = tzshift.detect(converted, tips)
    corrected_rows = tzshift.apply(converted, res.findings)

    # Dedup on (source, received_at µs, job_id). Deterministic: the smallest MongoDB _id of a group is kept.
    keyed = sorted(((c.key(), c.mongo_id, c) for c in converted), key=lambda x: (x[0], x[1]))
    kept: list[Converted] = []
    dups_identical = dups_differing = 0
    prev = prev_key = None
    for key, _, c in keyed:
        if prev is not None and key == prev_key:
            res.per_source[c.source]["duplicates"] += 1
            same = c.values == prev.values and c.chain_family == prev.chain_family and c.height == prev.height
            dups_identical += same
            dups_differing += not same
            res.duplicates.append((prev.mongo_id, c.mongo_id, same))
            if len(dup_samples) < MAX_SAMPLES:
                dup_samples.append(dict(kept=prev.mongo_id, dropped=c.mongo_id, source=c.source,
                                        received_at=c.received_at.isoformat(), job_id=c.values[0], identical=same))
            continue
        kept.append(c)
        prev, prev_key = c, key

    day_tips = DayTips(tips, kept)
    lifted = 0
    for c in kept:
        r = route_converted(c, day_tips)
        if day_tips.tip_at(c.received_at) != tips.tip_at(c.received_at):
            lifted += 1
        if is_btc(r):
            res.btc.append((c, None))
            res.per_source[c.source]["templates"] += 1
        else:
            res.other.append((c, r))
            reasons[r.reason] += 1
            res.per_source[c.source]["templates_other"] += 1
    res.btc.sort(key=lambda x: x[0].received_at)
    res.other.sort(key=lambda x: x[0].received_at)
    for s in res.per_source.values():
        for k in ("mongo_docs", "templates", "templates_other", "duplicates", "rejected"):
            s.setdefault(k, 0)
    res.summary = dict(
        mongo_docs=n_docs, templates=len(res.btc), templates_other=len(res.other),
        duplicates=dups_identical + dups_differing, duplicates_identical=dups_identical,
        duplicates_differing=dups_differing, duplicate_samples=dup_samples,
        rejected=len(res.rejected), rejected_reasons=dict(Counter(r[2] for r in res.rejected)),
        formats=dict(formats), reasons=dict(reasons), unknown_fields=dict(unknown),
        height_changed=height_changed, height_changed_samples=height_changed_samples,
        tz_corrected_rows=corrected_rows, tip_lifted_by_prev_hash=lifted, tz_findings=[f.as_dict() for f in res.findings],
        btc_heights=[min((c.height for c, _ in res.btc), default=None), max((c.height for c, _ in res.btc), default=None)],
    )
    return res


def rows_for_copy(res: DayResult, ids: dict[str, int]) -> tuple[list, list]:
    btc = [(c.received_at, c.offset_s, ids[c.source], c.height) + c.values for c, _ in res.btc]
    other = [(c.received_at, c.offset_s, ids[c.source], c.height) + c.values + (r.chain, r.reason) for c, r in res.other]
    return btc, other


# ── orchestration ─────────────────────────────────────────────────────────────────────────────────────────────
class Task(NamedTuple):
    day: date
    cuts: Cuts                    # what the day will hold afterwards (recorded with it)
    mode: str                     # "new" (nothing loaded yet), "day" (delete + reload the day), "sources" (only these)
    sources: frozenset = frozenset()


def plan(days: list[date], done: dict, until: Optional[datetime], now: datetime,
         pool_until: Optional[dict] = None, only_pools: Optional[set] = None) -> list[Task]:
    """A Task for every day that needs work. `done` maps day -> recorded Cuts.

    Per day and source, the requested cut is `pool_until[source]` if given, else `until`; a day still being written is
    cut LIVE_SAFETY behind now whatever was asked. With `only_pools`, every other source keeps what it has (nothing,
    on a day not loaded yet). Coverage never shrinks: the day's new cut is the per-source maximum of what is recorded
    and what is requested. Then:
      * same coverage as recorded                -> skipped
      * not loaded yet                           -> "new"
      * the default cut grew (most sources)      -> "day": delete and reload the whole day
      * only some sources' own cuts grew         -> "sources": reload just those sources' rows of the day"""
    pool_until = pool_until or {}
    out = []
    live = now - LIVE_SAFETY
    for d in days:
        start, end = bounds(d)
        cap = lambda u: (live if u is None or u > live else u) if end > live else u
        have = done.get(d) or Cuts.empty(d)
        if only_pools is not None:
            want = Cuts.make(d, have.default, {**have.per_source,
                                               **{n: cap(pool_until.get(n, until)) for n in only_pools}})
        else:
            want = Cuts.make(d, cap(until), {n: cap(u) for n, u in pool_until.items()})
        new = have.merge(want)
        if d not in done:
            if new.any_coverage():
                out.append(Task(d, new, "new"))
            continue
        if new.same_coverage(have):
            continue
        default_grew, sources = new.grown(have)
        out.append(Task(d, new, "day") if default_grew else Task(d, new, "sources", frozenset(sources)))
    return out


_W: dict = {}


def _worker_init(mongo_uri, mongo_db, pg_kw, site, block_pairs, batch_size):
    from .source import Source
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    _W["source"] = Source(mongo_uri, mongo_db, batch_size)
    _W["target"] = Target(pg_kw, site)
    _W["tips"] = TipIndex(block_pairs)


def row_keys(res: DayResult, exclude: frozenset) -> Counter:
    """What identifies a loaded row and everything about it that can depend on other sources' documents (timezone
    correction, routing), for every source but `exclude`: compared with Postgres before a "sources" reload."""
    out = Counter()
    for c, _ in res.btc:
        if c.source not in exclude:
            out[("templates", c.source, c.received_at, c.offset_s, c.values[0], c.height, None)] += 1
    for c, r in res.other:
        if c.source not in exclude:
            out[("templates_other", c.source, c.received_at, c.offset_s, c.values[0], c.height, r.reason)] += 1
    return out


def process_day(task: Task) -> dict:
    d, cuts = task.day, task.cuts
    src, tgt, tips = _W["source"], _W["target"], _W["tips"]
    t0 = time.monotonic()
    res = build_day(src.iter_day(d, cuts=cuts), tips)
    t_read = time.monotonic() - t0
    first_seen = {}
    for c, _ in res.btc + res.other:
        if c.source not in first_seen or c.received_at < first_seen[c.source]:
            first_seen[c.source] = c.received_at
    ids = tgt.source_ids(first_seen)
    btc, other = rows_for_copy(res, ids)
    res.summary["seconds_read_convert"] = round(t_read, 3)
    res.summary["cuts"] = dict(until=cuts.default, pool_until=cuts.pool_until_json())
    check = row_keys(res, task.sources) if task.mode == "sources" else None
    seconds, mode = tgt.write_day(cuts, task.mode, task.sources, btc, other, res.rejected, res.duplicates,
                                  res.findings, res.per_source, res.summary, t0, {i: n for n, i in ids.items()}, check)
    s = res.summary
    what = {"new": "", "day": " (reloaded)", "sources": f" (reloaded {', '.join(sorted(task.sources))} only)"}[mode]
    LOG.info("%s%s%s: %d docs -> %d templates, %d other, %d duplicates, %d rejected%s in %.1fs (%.0f docs/s)",
             d, f" ({cuts.describe()})" if cuts.describe() else "", what, s["mongo_docs"], s["templates"],
             s["templates_other"], s["duplicates"], s["rejected"],
             f", {sum(1 for f in res.findings if f.corrected)} tz-corrected heights" if res.findings else "",
             seconds, s["mongo_docs"] / seconds if seconds else 0)
    return dict(day=d.isoformat(), seconds=seconds, mode=mode, **{k: s[k] for k in ("mongo_docs", "templates",
                                                                                    "templates_other", "duplicates",
                                                                                    "rejected")})


def run(args, pg_kw: dict, mongo_uri: str) -> int:
    from .source import Source
    src = Source(mongo_uri, args.mongo_db, args.batch_size)
    tgt = Target(pg_kw, args.site)
    tgt.setup()
    LOG.info("source: %s; target: site %r", src.describe(), args.site)

    if not src.has_timestamp_index():
        if args.create_index:
            LOG.info("creating index on mining_notify.timestamp (throwaway restore only) ...")
            src.create_timestamp_index()
        else:
            LOG.warning("mining_notify has no timestamp index: every day is a collection scan. On a throwaway "
                        "restore, pass --create-index.")

    blocks = src.blocks()
    if not args.skip_blocks:
        LOG.info("blocks: %s", json.dumps(tgt.load_blocks(blocks, args.blocks_overwrite)))
    if not args.skip_pools:
        LOG.info("pools: %s", json.dumps(tgt.load_pools(src.pools(), args.pools_overwrite)))
    seen, block_pairs = set(), []
    for b in blocks:
        if b.get("block_hash") not in seen and isinstance(b.get("height"), int) and isinstance(b.get("timestamp"), (int, float)):
            seen.add(b.get("block_hash"))
            block_pairs.append((int(b["height"]), int(b["timestamp"]), b.get("block_hash")))

    rng = src.day_range()
    if rng is None:
        LOG.info("mining_notify is empty: nothing to do")
        return 0
    lo = args.from_day or rng[0]
    hi = args.to_day or rng[1]
    days = [lo + timedelta(days=i) for i in range((hi - lo).days + 1)]
    pool_until = getattr(args, "pool_until", None) or {}
    only = set(args.only_pools) if getattr(args, "only_pools", None) else None
    if pool_until:
        LOG.info("per-pool cut-offs: %s", ", ".join(f"{n!r} < {u.isoformat()}" for n, u in sorted(pool_until.items())))
    if only is not None:
        LOG.info("only pools: %s (every other source keeps what it has)", ", ".join(repr(n) for n in sorted(only)))
    tasks = plan(days, tgt.done_days(), args.until, datetime.now(timezone.utc), pool_until, only)
    LOG.info("days %s .. %s: %d to do (%s), %d skipped (already done, or after the cut-off)", lo, hi, len(tasks),
             ", ".join(f"{m} {n}" for m, n in sorted(Counter(t.mode for t in tasks).items())) or "none",
             len(days) - len(tasks))
    src.close()
    tgt.close()

    t0 = time.monotonic()
    init = (mongo_uri, args.mongo_db, pg_kw, args.site, block_pairs, args.batch_size)
    results = []
    if args.workers <= 1:
        _worker_init(*init)
        results = [process_day(t) for t in tasks]
    else:
        with mp.get_context("spawn").Pool(args.workers, initializer=_worker_init, initargs=init) as pool:
            results = list(pool.imap_unordered(process_day, tasks))
    wall = time.monotonic() - t0
    docs = sum(r["mongo_docs"] for r in results)
    LOG.info("done: %d days, %d docs in %.1fs wall (%.0f docs/s, %d worker(s))", len(results), docs, wall,
             docs / wall if wall else 0, args.workers)
    named = set(pool_until) | (only or set())
    if named:
        tgt = Target(pg_kw, args.site)
        known = {n for (n,) in tgt._meta.execute("SELECT name FROM sources WHERE site = %s AND name = ANY(%s)",
                                                 (args.site, sorted(named))).fetchall()}
        tgt.close()
        for n in sorted(named - known):   # matched exactly as stored: a typo silently loads nothing
            LOG.warning("pool %r has no rows for site %r: check the name (matched exactly as pool_name is stored)",
                        n, args.site)
    return 0
