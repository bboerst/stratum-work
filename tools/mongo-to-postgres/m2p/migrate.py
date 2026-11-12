"""`m2p migrate`: copy MongoDB history into Postgres, one UTC day per transaction, oldest first, resumable."""
from __future__ import annotations

import json
import logging
import multiprocessing as mp
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Optional

from . import tzshift
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
        src = doc.get("pool_name") if isinstance(doc.get("pool_name"), str) else str(doc.get("pool_name") or "")
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
def day_end(d: date, until: Optional[datetime]) -> datetime:
    end = datetime(d.year, d.month, d.day, tzinfo=timezone.utc) + timedelta(days=1)
    return min(end, until) if until else end


def plan(days: list[date], done: dict, until: Optional[datetime], now: datetime) -> list[tuple[date, Optional[datetime], bool]]:
    """(day, until to record, redo?) for every day that needs work. A day is skipped when a previous run already
    covered at least as much of it; it is redone (delete + reload, one transaction) when this run covers more."""
    out = []
    for d in days:
        eff = until
        if day_end(d, eff) > now - LIVE_SAFETY:          # still being written: cut behind now, record the cut
            eff = min(eff, now - LIVE_SAFETY) if eff else now - LIVE_SAFETY
        if day_end(d, eff) <= datetime(d.year, d.month, d.day, tzinfo=timezone.utc):
            continue                                       # nothing of this day is in range yet
        rec_until = eff if day_end(d, eff) < day_end(d, None) else None
        if d in done:
            if day_end(d, done[d]) >= day_end(d, rec_until):
                continue
            out.append((d, rec_until, True))
        else:
            out.append((d, rec_until, False))
    return out


_W: dict = {}


def _worker_init(mongo_uri, mongo_db, pg_kw, site, block_pairs, batch_size):
    from .source import Source
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    _W["source"] = Source(mongo_uri, mongo_db, batch_size)
    _W["target"] = Target(pg_kw, site)
    _W["tips"] = TipIndex(block_pairs)


def process_day(task) -> dict:
    d, until, redo = task
    src, tgt, tips = _W["source"], _W["target"], _W["tips"]
    t0 = time.monotonic()
    res = build_day(src.iter_day(d, until), tips)
    t_read = time.monotonic() - t0
    first_seen = {}
    for c, _ in res.btc + res.other:
        if c.source not in first_seen or c.received_at < first_seen[c.source]:
            first_seen[c.source] = c.received_at
    ids = tgt.source_ids(first_seen)
    btc, other = rows_for_copy(res, ids)
    res.summary["seconds_read_convert"] = round(t_read, 3)
    seconds = tgt.write_day(d, until, btc, other, res.rejected, res.duplicates, res.findings, res.per_source, res.summary, t0, redo)
    s = res.summary
    LOG.info("%s%s: %d docs -> %d templates, %d other, %d duplicates, %d rejected%s in %.1fs (%.0f docs/s)",
             d, f" (until {until.isoformat()})" if until else "", s["mongo_docs"], s["templates"], s["templates_other"],
             s["duplicates"], s["rejected"],
             f", {sum(1 for f in res.findings if f.corrected)} tz-corrected heights" if res.findings else "",
             seconds, s["mongo_docs"] / seconds if seconds else 0)
    return dict(day=d.isoformat(), seconds=seconds, **{k: s[k] for k in ("mongo_docs", "templates", "templates_other",
                                                                         "duplicates", "rejected")})


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
    tasks = plan(days, tgt.done_days(), args.until, datetime.now(timezone.utc))
    LOG.info("days %s .. %s: %d to do, %d skipped (already done, or after the cut-off)", lo, hi, len(tasks),
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
    return 0
