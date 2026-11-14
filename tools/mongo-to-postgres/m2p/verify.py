"""`m2p verify`: independent checks that the backfill is complete and exact (design doc section 5, "Verification").

Every check reads MongoDB and Postgres directly; the tool's bookkeeping is only used for what can't be recounted
(duplicates dropped, documents rejected, the per-height timezone corrections). Each check ends PASS, WARN (needs a
human look, not a migration error) or FAIL.
"""
from __future__ import annotations

import json
import logging
import random
import statistics
import struct
from collections import Counter, defaultdict
from datetime import date, timedelta
from typing import Optional

import psycopg

from .convert import FMT_HEX, FMT_ISO_NAIVE, Reject, epoch_us, parse_timestamp, utc_day
from .shared import parse_bip34_height
from .source import Source
from .target import RAW_DAY_FILTER, SCHEMA

LOG = logging.getLogger("m2p.verify")
DEFAULT_KNOWN_GAPS = ((876_883, 876_903),)   # collection outage (template heights), design doc section 5
SANITY_WARN_S = 3600                          # first template vs block(h-1) header time: list beyond ±1 h
TZ_SIGNATURES_S = (6 * 3600, 7 * 3600)        # a ±6 h / ±7 h outlier means a mis-parsed or uncorrected timezone
TZ_TOLERANCE_S = 30 * 60


class Check:
    def __init__(self, name: str):
        self.name, self.status, self.details = name, "PASS", {}

    def warn(self):
        if self.status == "PASS":
            self.status = "WARN"

    def fail(self):
        self.status = "FAIL"

    def as_dict(self):
        return dict(name=self.name, status=self.status, **self.details)


def _f32(x):
    return None if x is None else struct.unpack("f", struct.pack("f", x))[0]


class Verifier:
    def __init__(self, src: Source, pg_kw: dict, site: str, sample: int, seed: int,
                 known_gaps=DEFAULT_KNOWN_GAPS, max_listed: int = 50):
        self.src, self.site, self.sample, self.seed = src, site, sample, seed
        self.known_gaps, self.max_listed = known_gaps, max_listed
        self.pg = psycopg.connect(**pg_kw, autocommit=True)
        self.days = dict(self.pg.execute(f"SELECT day, until FROM {SCHEMA}.days WHERE site = %s ORDER BY day",
                                         (site,)).fetchall())
        self.checks: list[Check] = []

    def run(self, from_day: Optional[date] = None, to_day: Optional[date] = None) -> list[Check]:
        days = [d for d in self.days if (from_day is None or d >= from_day) and (to_day is None or d <= to_day)]
        if not days:
            c = Check("migrated days")
            c.fail()
            c.details["error"] = f"no migrated days for site {self.site!r} in range"
            return [c]
        self.checks = [self.check_coverage(days), self.check_counts(days), self.check_roundtrip(days),
                       self.check_routing(days), self.check_timestamps(days), self.check_gaps(days),
                       self.check_blocks(), self.check_pools()]
        return self.checks

    # ── 0. coverage: every document belongs to a migrated day ───────────────────────────────────────────
    def check_coverage(self, days: list[date]) -> Check:
        c = Check("coverage")
        n, sample = self.src.unrecognized_timestamps()
        c.details["unrecognized_timestamps"] = n
        if n:
            c.fail()
            c.details["unrecognized_samples"] = sample
        rng = self.src.day_range()
        c.details["mongo_day_range"] = [str(rng[0] + timedelta(days=1)), str(rng[1] - timedelta(days=1))] if rng else None
        c.details["migrated_days"] = [str(days[0]), str(days[-1]), len(days)]
        partial = {str(d): self.days[d].isoformat() for d in days if self.days[d] is not None}
        if partial:
            c.details["partial_days_until"] = partial
        if rng:
            missing = [d for d in (rng[0] + timedelta(days=i) for i in range((rng[1] - rng[0]).days + 1))
                       if d not in self.days and next(self.src.iter_day(d, None, {"_id": 1}), None) is not None]
            if missing:
                c.warn()
                c.details["days_with_documents_not_migrated"] = [str(d) for d in missing[: self.max_listed]]
        return c

    # ── 1. exact counts per (day, source) ───────────────────────────────────────────────────────────────
    def check_counts(self, days: list[date]) -> Check:
        c = Check("counts per (day, source): mongo = templates + templates_other + duplicates + rejected")
        mismatches, totals = [], Counter()
        for d in days:
            until = self.days[d]
            mongo = Counter(doc.get("pool_name") if isinstance(doc.get("pool_name"), str) else str(doc.get("pool_name") or "")
                            for doc in self.src.iter_day(d, until, {"timestamp": 1, "pool_name": 1}))
            pg = defaultdict(Counter)
            for table in ("templates", "templates_other"):
                for name, n in self.pg.execute(
                        f"""SELECT s.name, count(*) FROM {table} t JOIN sources s ON s.id = t.source_id
                            WHERE s.site = %(site)s AND {RAW_DAY_FILTER} GROUP BY s.name""",
                        dict(site=self.site, lo=d, hi=d)).fetchall():
                    pg[name][table] = n
            book = {name: (dups, rej) for name, dups, rej in self.pg.execute(
                f"SELECT source, duplicates, rejected FROM {SCHEMA}.day_sources WHERE site = %s AND day = %s",
                (self.site, d)).fetchall()}
            for name in sorted(set(mongo) | set(pg) | set(book)):
                t, o = pg[name]["templates"], pg[name]["templates_other"]
                dups, rej = book.get(name, (0, 0))
                totals.update(mongo=mongo[name], templates=t, templates_other=o, duplicates=dups, rejected=rej)
                if mongo[name] != t + o + dups + rej:
                    mismatches.append(dict(day=str(d), source=name, mongo=mongo[name], templates=t,
                                           templates_other=o, duplicates=dups, rejected=rej))
        c.details["totals"] = dict(totals)
        c.details["days"] = len(days)
        if mismatches:
            c.fail()
            c.details["mismatches"] = mismatches[: self.max_listed]
            c.details["mismatch_count"] = len(mismatches)
        differing = self.pg.execute(f"""SELECT day, kept_id, dropped_id FROM {SCHEMA}.duplicates
                                         WHERE site = %s AND NOT identical ORDER BY day""", (self.site,)).fetchall()
        c.details["duplicates_differing"] = len(differing)
        if differing:   # same (source, received_at, job_id) but different content: one version was not loaded
            c.warn()
            c.details["duplicates_differing_samples"] = [dict(day=str(d), kept=k, dropped=x) for d, k, x in differing[:20]]
        if totals["rejected"]:
            c.warn()
            c.details["rejected_by_reason"] = dict(self.pg.execute(
                f"SELECT reason, count(*) FROM {SCHEMA}.rejected WHERE site = %s GROUP BY 1", (self.site,)).fetchall())
        return c

    # ── 2. byte-exact round trip ────────────────────────────────────────────────────────────────────────
    def _eligible(self, doc, days: set) -> bool:
        try:
            raw, _ = parse_timestamp(doc.get("timestamp"))
        except Reject:
            return False
        d = utc_day(raw)
        return d in days and (self.days[d] is None or raw < self.days[d])

    def _sample_docs(self, days: list[date]) -> list[dict]:
        dayset, coll = set(days), self.src.db.mining_notify
        total = coll.estimated_document_count()
        if total <= self.sample * 2:
            docs = [d for day in days for d in self.src.iter_day(day, self.days[day])]
            return random.Random(self.seed).sample(docs, min(self.sample, len(docs)))
        out, seen = [], set()
        for _ in range(20):   # $sample is random (a seed can't make it repeatable); filter to migrated days
            for doc in coll.aggregate([{"$sample": {"size": self.sample}}], allowDiskUse=True):
                if doc["_id"] not in seen and self._eligible(doc, dayset):
                    seen.add(doc["_id"])
                    out.append(doc)
            if len(out) >= self.sample:
                break
        return out[: self.sample]

    def check_roundtrip(self, days: list[date]) -> Check:
        c = Check(f"byte-exact round trip ({self.sample} random templates)")
        docs = self._sample_docs(days)
        offsets = {(d, h): o for d, h, o in self.pg.execute(
            f"SELECT day, height, offset_s FROM {SCHEMA}.tz_findings WHERE site = %s AND corrected", (self.site,)).fetchall()}
        rejected = {r[0] for r in self.pg.execute(f"SELECT mongo_id FROM {SCHEMA}.rejected WHERE site = %s",
                                                  (self.site,)).fetchall()}
        dropped = {r[0] for r in self.pg.execute(f"SELECT dropped_id FROM {SCHEMA}.duplicates WHERE site = %s AND NOT identical",
                                                 (self.site,)).fetchall()}
        ids = dict(self.pg.execute("SELECT name, id FROM sources WHERE site = %s AND replica = 'a'", (self.site,)).fetchall())
        mismatch, samples, stats = Counter(), [], Counter()
        sql = """SELECT encode(prev_hash,'hex'), encode(coinbase1,'hex'), encode(coinbase2,'hex'),
                        encode(merkle_branches,'hex'), lpad(to_hex(version),8,'0'), lpad(to_hex(nbits),8,'0'),
                        lpad(to_hex(ntime),8,'0'), clean_jobs, encode(extranonce1,'hex'), extranonce2_length, job_id,
                        latency_ms, latency_method::text, received_at + make_interval(secs => received_at_offset_s),
                        height, {extra}
                 FROM {table} WHERE source_id = %s AND height = %s AND received_at = %s AND job_id = %s"""
        for doc in docs:
            if str(doc.get("_id")) in rejected:
                stats["rejected_listed"] += 1
                continue
            if str(doc.get("_id")) in dropped:   # its twin was kept; listed under counts
                stats["duplicate_differing_listed"] += 1
                continue
            raw, fmt = parse_timestamp(doc["timestamp"])
            height = parse_bip34_height(doc["coinbase1"]) or 0
            off = offsets.get((utc_day(raw), height), 0) if fmt == FMT_ISO_NAIVE else 0
            key = (ids.get(doc.get("pool_name") or ""), height, raw - timedelta(seconds=off), doc["job_id"])
            row, table = None, None
            for table, extra in (("templates", "NULL, NULL"), ("templates_other", "chain::text, reason")):
                row = self.pg.execute(sql.format(table=table, extra=extra), key).fetchone()
                if row:
                    break
            if row is None:
                mismatch["missing"] += 1
                if len(samples) < 10:
                    samples.append(dict(_id=str(doc["_id"]), problem="missing"))
                continue
            stats[table] += 1
            got_ts = row[13]
            if fmt == FMT_HEX:   # hex ns: equal at µs (the sub-µs remainder isn't stored)
                ts_ok = epoch_us(got_ts) == int(doc["timestamp"], 16) // 1000
            else:                # ISO / BSON date: the same instant (naive ISO read as UTC)
                ts_ok = got_ts == raw
            expect = dict(
                prev_hash=doc["prev_hash"], coinbase1=doc["coinbase1"], coinbase2=doc["coinbase2"],
                merkle_branches="".join(doc.get("merkle_branches") or []), version=doc["version"], nbits=doc["nbits"],
                ntime=doc["ntime"], clean_jobs=doc["clean_jobs"], extranonce1=doc["extranonce1"],
                extranonce2_length=doc["extranonce2_length"], job_id=doc["job_id"],
                latency_ms=_f32(doc.get("lat_ms")), latency_method=doc.get("lat_m"))
            got = dict(zip(expect, row[:13]))
            got["latency_ms"] = _f32(got["latency_ms"])   # psycopg reads float4 as its shortest decimal text
            bad = [k for k in expect if expect[k] != got[k]]
            if not ts_ok:
                bad.append("timestamp")
            if row[14] != height:
                bad.append("height")
            # Routing invariants that don't depend on the tip (that part is the routing report's job):
            fam = doc.get("chain_family")
            if height == 0:
                want = ("templates_other", "unknown", "height_parse_failed")
            elif fam == "bch":
                want = ("templates_other", "bch", "bch")
            elif fam:
                want = ("templates_other", "unknown", "unknown_chain")
            else:
                want = None   # templates, or templates_other/height_implausible depending on the tip
            if want and (table, row[15], row[16]) != want:
                bad.append("routing")
            if not want and table == "templates_other" and row[16] != "height_implausible":
                bad.append("routing")
            if doc.get("lat_ms") is not None and _f32(doc["lat_ms"]) != doc["lat_ms"] and \
                    float(f"{_f32(doc['lat_ms']):.7g}") != doc["lat_ms"]:
                stats["latency_inexact"] += 1
            for k in bad:
                mismatch[k] += 1
            if bad:
                if len(samples) < 10:
                    samples.append(dict(_id=str(doc["_id"]), fields=bad))
            else:
                stats["matched"] += 1
        c.details.update(checked=len(docs), matched=stats.pop("matched", 0), by_table=dict(stats),
                         mismatches=dict(mismatch))
        if mismatch:
            c.fail()
            c.details["mismatch_samples"] = samples
        if len(docs) < self.sample:
            c.details["note"] = f"only {len(docs)} migrated templates available to sample"
        c.details["latency_ms_note"] = ("compared as float4 (the column is real); MongoDB doubles that float4 can't hold "
                                        f"exactly: {stats.pop('latency_inexact', 0)} of the sample")
        return c

    # ── 3. routing report ───────────────────────────────────────────────────────────────────────────────
    def check_routing(self, days: list[date]) -> Check:
        c = Check("routing by reason")
        p = dict(site=self.site, lo=days[0], hi=days[-1])
        btc = self.pg.execute(f"""SELECT count(*) FROM templates t JOIN sources s ON s.id = t.source_id
                                  WHERE s.site = %(site)s AND {RAW_DAY_FILTER}""", p).fetchone()[0]
        rows = self.pg.execute(f"""SELECT reason, chain::text, count(*), count(DISTINCT s.name), min(height), max(height)
                                   FROM templates_other t JOIN sources s ON s.id = t.source_id
                                   WHERE s.site = %(site)s AND {RAW_DAY_FILTER} GROUP BY 1, 2 ORDER BY 3 DESC""", p).fetchall()
        total = btc + sum(r[2] for r in rows)
        c.details["templates"] = dict(count=btc, share=round(btc / total, 5) if total else None)
        reasons = {}
        for reason, chain, n, nsrc, hmin, hmax in rows:
            samp = self.pg.execute(f"""SELECT s.name, t.height, t.received_at, encode(substring(t.coinbase1 from 1 for 48), 'hex')
                                       FROM templates_other t JOIN sources s ON s.id = t.source_id
                                       WHERE s.site = %(site)s AND t.reason = %(reason)s AND {RAW_DAY_FILTER}
                                       ORDER BY t.received_at LIMIT 3""", dict(p, reason=reason)).fetchall()
            per_source = self.pg.execute(f"""SELECT s.name, count(*) FROM templates_other t JOIN sources s ON s.id = t.source_id
                                             WHERE s.site = %(site)s AND t.reason = %(reason)s AND {RAW_DAY_FILTER}
                                             GROUP BY 1 ORDER BY 2 DESC""", dict(p, reason=reason)).fetchall()
            reasons[reason] = dict(chain=chain, count=n, share=round(n / total, 5), sources=nsrc, heights=[hmin, hmax],
                                   by_source=dict(per_source),
                                   samples=[dict(source=a, height=b, received_at=t.isoformat(), coinbase1_prefix=x)
                                            for a, b, t, x in samp])
        c.details["templates_other"] = reasons
        # Independent look at height_implausible: rows whose prev_hash is the known block at height-1 build on a real
        # Bitcoin block. That's right for stale/replayed jobs (received long after the block), suspicious otherwise.
        rows = self.pg.execute(f"""
            SELECT s.name, t.height, t.received_at, extract(epoch FROM t.received_at - b.block_time)::float8
            FROM templates_other t JOIN sources s ON s.id = t.source_id
            JOIN blocks b ON b.height = t.height - 1
             AND t.prev_hash = (SELECT string_agg(substring(b.block_hash from 33 - 4 * i for 4), ''::bytea ORDER BY i)
                                FROM generate_series(1, 8) i)
            WHERE s.site = %(site)s AND t.reason = 'height_implausible' AND {RAW_DAY_FILTER}
            ORDER BY t.received_at""", p).fetchall()
        recent = [r for r in rows if r[3] < 3600]
        c.details["implausible_building_on_known_block"] = dict(
            total=len(rows), within_1h_of_block=len(recent),
            samples=[dict(source=a, height=h, received_at=t.isoformat(), after_block_s=round(d, 1)) for a, h, t, d in recent[:10]])
        if recent:
            c.warn()
        return c

    # ── 4. per-height timestamp sanity ──────────────────────────────────────────────────────────────────
    def check_timestamps(self, days: list[date]) -> Check:
        c = Check("timestamp sanity per height: first template - block(h-1) header time")
        p = dict(site=self.site, lo=days[0], hi=days[-1])
        rows = self.pg.execute(f"""
            WITH f AS (SELECT t.height, min(t.received_at) AS first, bool_or(t.received_at_offset_s <> 0) AS corrected
                       FROM templates t JOIN sources s ON s.id = t.source_id
                       WHERE s.site = %(site)s AND {RAW_DAY_FILTER} GROUP BY t.height),
                 b AS (SELECT height, min(block_time) AS t FROM blocks GROUP BY height)
            SELECT f.height, extract(epoch FROM f.first - b.t)::float8, f.corrected
            FROM f LEFT JOIN b ON b.height = f.height - 1 ORDER BY f.height""", p).fetchall()
        deltas = [(h, d, corr) for h, d, corr in rows if d is not None]
        c.details["heights"] = len(rows)
        c.details["heights_without_block_h_minus_1"] = len(rows) - len(deltas)
        c.details["heights_tz_corrected"] = sum(1 for _, _, corr in rows if corr)
        if deltas:
            ds = sorted(d for _, d, _ in deltas)
            q = lambda f: round(ds[min(len(ds) - 1, int(f * len(ds)))], 1)
            c.details["delta_s"] = dict(min=round(ds[0], 1), p01=q(0.01), median=round(statistics.median(ds), 1),
                                        p99=q(0.99), max=round(ds[-1], 1))
        outliers = [(h, d) for h, d, _ in deltas if abs(d) > SANITY_WARN_S]
        tz_like = [(h, d) for h, d in outliers if any(abs(abs(d) - s) <= TZ_TOLERANCE_S for s in TZ_SIGNATURES_S)]
        c.details["outliers_beyond_1h"] = len(outliers)
        if outliers:
            c.warn()
            c.details["outlier_samples"] = [dict(height=h, delta_s=round(d, 1)) for h, d in outliers[: self.max_listed]]
        if tz_like:
            c.fail()
            c.details["timezone_signature_outliers"] = [dict(height=h, delta_s=round(d, 1)) for h, d in tz_like[: self.max_listed]]
        return c

    # ── 5. missing heights, with the known gaps expected ────────────────────────────────────────────────
    def check_gaps(self, days: list[date]) -> Check:
        c = Check("missing heights (known gaps expected)")
        p = dict(site=self.site, lo=days[0], hi=days[-1])
        heights = [h for (h,) in self.pg.execute(f"""SELECT DISTINCT t.height FROM templates t JOIN sources s ON s.id = t.source_id
                                                     WHERE s.site = %(site)s AND {RAW_DAY_FILTER} ORDER BY 1""", p).fetchall()]
        if not heights:
            c.details["heights"] = 0
            return c
        present = set(heights)
        missing = [h for h in range(heights[0], heights[-1] + 1) if h not in present]
        known = [h for h in missing if any(a <= h <= b for a, b in self.known_gaps)]
        unexpected = [h for h in missing if h not in set(known)]
        c.details.update(height_range=[heights[0], heights[-1]], heights_with_templates=len(heights),
                         known_gaps=[list(g) for g in self.known_gaps], missing_known=_ranges(known),
                         missing_unexpected=_ranges(unexpected)[: self.max_listed])
        if unexpected:
            c.warn()
        return c

    # ── blocks and pools ────────────────────────────────────────────────────────────────────────────────
    def check_blocks(self) -> Check:
        c = Check("blocks: every MongoDB block_hash present, fields equal")
        newest = {}
        n_docs = 0
        for b in self.src.blocks():
            n_docs += 1
            newest[b.get("block_hash")] = b
        pg = {h: r for h, *r in self.pg.execute(
            """SELECT encode(block_hash,'hex'), height, extract(epoch FROM block_time)::bigint,
                      encode(coinbase_script_sig,'hex'), pool_id, mining_pool, analysis FROM blocks""").fetchall()}
        missing, differ = [], []
        for h, b in newest.items():
            r = pg.get(h)
            if r is None:
                missing.append(h)
                continue
            want = [int(b["height"]), int(b["timestamp"]), b.get("coinbase_script_sig") or "",
                    json.loads(json.dumps(b.get("mining_pool") or {}, default=str)),
                    json.loads(json.dumps(b.get("analysis") or {}, default=str))]
            got = [r[0], r[1], r[2], r[4], r[5]]
            if want != got:
                differ.append(dict(block_hash=h, fields=[n for n, a, g in zip(
                    ("height", "timestamp", "coinbase_script_sig", "mining_pool", "analysis"), want, got) if a != g]))
        c.details.update(mongo_docs=n_docs, distinct_hashes=len(newest), duplicates=n_docs - len(newest),
                         postgres_rows=len(pg), missing=len(missing), differing=len(differ))
        if missing:
            c.fail()
            c.details["missing_samples"] = missing[:10]
        if differ:
            c.warn()   # with the default (keep existing rows) a block written by the new backend may differ
            c.details["differing_samples"] = differ[:10]
        return c

    def check_pools(self) -> Check:
        c = Check("pools: full definition")
        mongo = {p.get("id"): json.loads(json.dumps(p, default=str)) for p in self.src.pools()}
        pg = dict(self.pg.execute("SELECT id, definition FROM pools").fetchall())
        differ = [i for i, p in mongo.items() if isinstance(i, int) and pg.get(i) != p]
        c.details.update(mongo=len(mongo), postgres=len(pg), differing=len(differ))
        if differ:
            c.warn()   # the backend's daily refresh replaces pools; differences after it ran are expected
            c.details["differing_ids"] = differ[:20]
        return c


def _ranges(hs: list[int]) -> list:
    out = []
    for h in hs:
        if out and out[-1][1] == h - 1:
            out[-1][1] = h
        else:
            out.append([h, h])
    return [a if a == b else f"{a}-{b}" for a, b in out]
