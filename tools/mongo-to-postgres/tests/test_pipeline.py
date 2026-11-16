from datetime import date, datetime, timedelta, timezone

from m2p import tzshift
from m2p.convert import TipIndex, convert, parse_timestamp
from m2p.cuts import Cuts
from m2p.migrate import LIVE_SAFETY, build_day, plan, row_keys
from m2p.source import Source

from helpers import coinbase1, doc, hex_ts, iso_naive

UTC = timezone.utc
H = 870_000
BLOCK_PREV = datetime(2024, 11, 12, 15, 0, tzinfo=UTC)     # header time of block H-1


def tips():
    return TipIndex([(H - 1, int(BLOCK_PREV.timestamp())), (H, int((BLOCK_PREV + timedelta(minutes=10)).timestamp()))])


def height_docs(n=20, shift=timedelta(0), fmt=iso_naive, height=H, prefix="d", ntime_skew=timedelta(0)):
    """n templates for `height`, received over 9 minutes after block H-1 (true time), recorded `shift` off UTC."""
    out = []
    for i in range(n):
        true = BLOCK_PREV + timedelta(seconds=5 + i * 27)
        out.append(doc(f"{prefix}{i:03}", fmt(true + shift), height=height, coinbase1=coinbase1(height),
                       job_id=f"{prefix}{i}", ntime=true - timedelta(seconds=3) + ntime_skew))
    return out


# ── timezone safety net ─────────────────────────────────────────────────────────────────────────────────────────
class TestTimezoneShift:
    def _run(self, docs):
        rows = [convert(d) for d in docs]
        findings = tzshift.detect(rows, tips())
        return rows, findings, tzshift.apply(rows, findings)

    def test_minus_6h_is_detected_and_corrected(self):
        rows, findings, n = self._run(height_docs(shift=-timedelta(hours=6)))
        assert [(f.height, f.offset_s, f.corrected) for f in findings] == [(H, -21600, True)]
        assert n == 20
        assert all(r.offset_s == -21600 for r in rows)
        assert rows[0].received_at == BLOCK_PREV + timedelta(seconds=5)          # back on true UTC
        assert rows[0].raw_received_at == BLOCK_PREV + timedelta(seconds=5) - timedelta(hours=6)

    def test_minus_7h_is_detected(self):
        _, findings, n = self._run(height_docs(shift=-timedelta(hours=7)))
        assert [(f.offset_s, f.corrected) for f in findings] == [(-25200, True)] and n == 20

    def test_no_shift_nothing_found(self):
        rows, findings, n = self._run(height_docs())
        assert findings == [] and n == 0 and all(r.offset_s == 0 for r in rows)

    def test_positive_offset_stale_templates_are_not_a_timezone(self):
        # e.g. production heights 867,946 (+12 h) and 872,096 (+94 h): received long after their ntime
        _, findings, n = self._run(height_docs(shift=timedelta(hours=12)))
        assert findings == [] and n == 0
        _, findings, n = self._run(height_docs(shift=timedelta(hours=6)))
        assert findings == [] and n == 0   # +6 h is a different signature: never "corrected" into the future

    def test_inconsistent_height_is_a_suspect_only(self):
        docs = height_docs(n=10, shift=-timedelta(hours=6), prefix="a") + height_docs(n=8, prefix="b")
        rows, findings, n = self._run(docs)
        # median at -6 h but only 10/18 templates agree: reported, not corrected
        assert [(f.offset_s, f.corrected) for f in findings] == [(-21600, False)]
        assert n == 0

    def test_ntime_agrees_but_no_block_data(self):
        docs = height_docs(shift=-timedelta(hours=6), height=H + 5)   # no block H+4 known
        _, findings, n = self._run(docs)
        assert [(f.height, f.corrected, f.first_vs_prev_block_s) for f in findings] == [(H + 5, False, None)]
        assert n == 0

    def test_block_signal_alone_is_a_suspect(self):
        # recorded -6 h vs the block, but the pool's ntime is just as far off (a pool clock problem, not ours)
        docs = height_docs(shift=-timedelta(hours=6), ntime_skew=-timedelta(hours=6))
        _, findings, n = self._run(docs)
        assert [(f.offset_s, f.corrected) for f in findings] == [(-21600, False)] and n == 0

    def test_hex_templates_are_never_corrected(self):
        _, findings, n = self._run(height_docs(shift=-timedelta(hours=6), fmt=hex_ts))
        assert findings == [] and n == 0


# ── one day through the pipeline: dedup + routing ───────────────────────────────────────────────────────────────
class TestBuildDay:
    def test_dedup_keeps_smallest_id_and_counts(self):
        t = BLOCK_PREV + timedelta(seconds=30)
        a = doc("b-2", hex_ts(t), height=H, coinbase1=coinbase1(H), job_id="J")
        b = dict(a, _id="a-1")                                        # identical twin, smaller _id
        c = dict(a, _id="c-3", lat_ms=99.0)                           # same key, different content
        other_job = dict(a, _id="d-4", job_id="K")
        other_src = dict(a, _id="e-5", pool_name="PoolB")
        res = build_day([a, b, c, other_job, other_src], tips())
        assert {x.mongo_id for x, _ in res.btc} == {"a-1", "d-4", "e-5"}
        assert res.summary["duplicates"] == 2
        assert (res.summary["duplicates_identical"], res.summary["duplicates_differing"]) == (1, 1)
        assert res.per_source["PoolA"]["duplicates"] == 2 and res.per_source["PoolA"]["mongo_docs"] == 4
        s = res.per_source["PoolA"]
        assert s["mongo_docs"] == s["templates"] + s["templates_other"] + s["duplicates"] + s["rejected"]

    def test_counts_balance_with_routing_and_rejects(self):
        t = BLOCK_PREV + timedelta(seconds=30)
        docs = [doc("1", hex_ts(t), height=H, coinbase1=coinbase1(H)),
                doc("2", hex_ts(t), height=6_976_415, coinbase1=coinbase1(6_976_415), job_id="x"),
                doc("3", hex_ts(t), coinbase1=coinbase1(raw_script=b"\x00"), job_id="y"),
                doc("4", hex_ts(t), chain_family="bch", job_id="z"),
                doc("5", hex_ts(t), prev_hash="AB" * 32, job_id="w")]
        res = build_day(docs, tips())
        assert len(res.btc) == 1
        assert sorted(r.reason for _, r in res.other) == ["bch", "height_implausible", "height_parse_failed"]
        assert [r[2] for r in res.rejected] == ["non_lossless_hex"]
        s = res.per_source["PoolA"]
        assert (s["mongo_docs"], s["templates"], s["templates_other"], s["rejected"]) == (5, 1, 3, 1)

    def test_row_keys_cover_routing_of_other_sources(self):
        t = BLOCK_PREV + timedelta(seconds=30)
        docs = [doc("1", hex_ts(t), height=H, coinbase1=coinbase1(H), job_id="a"),
                doc("2", hex_ts(t), height=6_976_415, coinbase1=coinbase1(6_976_415), job_id="b"),
                doc("3", hex_ts(t), height=H, coinbase1=coinbase1(H), job_id="c", pool_name="PoolB")]
        keys = row_keys(build_day(docs, tips()), frozenset({"PoolB"}))
        assert sorted(k[0] + ":" + k[4] + ":" + str(k[6]) for k in keys) == \
            ["templates:a:None", "templates_other:b:height_implausible"]

    def test_routing_uses_the_corrected_time(self):
        # -6 h shifted: raw time is before block H-1 (tip H-2 -> H would be plausible anyway), so use H+2 tip check:
        docs = height_docs(shift=-timedelta(hours=6))
        res = build_day(docs, tips())
        assert res.summary["tz_corrected_rows"] == 20
        assert len(res.btc) == 20 and all(c.offset_s == -21600 for c, _ in res.btc)


# ── resumability ────────────────────────────────────────────────────────────────────────────────────────────────
def _t(task):
    """A Task as (day, default cut, per-source cuts, mode, sources) for compact assertions."""
    return (task.day, task.cuts.default, task.cuts.per_source, task.mode, set(task.sources))


class TestPlan:
    NOW = datetime(2026, 11, 12, 12, 0, tzinfo=UTC)
    D1, D2, D3 = date(2026, 11, 10), date(2026, 11, 11), date(2026, 11, 12)

    def rec(self, d, until=None, per=None):
        return Cuts.make(d, until, per)

    def test_completed_days_are_skipped(self):
        assert [_t(t) for t in plan([self.D1, self.D2], {self.D1: self.rec(self.D1)}, None, self.NOW)] == \
            [(self.D2, None, {}, "new", set())]
        assert plan([self.D1, self.D2], {self.D1: self.rec(self.D1), self.D2: self.rec(self.D2)}, None, self.NOW) == []

    def test_live_day_is_cut_behind_now_and_extended_later(self):
        cut = self.NOW - LIVE_SAFETY
        assert [_t(t) for t in plan([self.D3], {}, None, self.NOW)] == [(self.D3, cut, {}, "new", set())]
        assert plan([self.D3], {self.D3: self.rec(self.D3, cut)}, None, self.NOW) == []           # same coverage: skip
        later = self.NOW + timedelta(hours=1)
        assert [_t(t) for t in plan([self.D3], {self.D3: self.rec(self.D3, cut)}, None, later)] == \
            [(self.D3, later - LIVE_SAFETY, {}, "day", set())]                                     # redo, more

    def test_until_cut(self):
        until = datetime(2026, 11, 11, 6, 0, tzinfo=UTC)
        assert [_t(t) for t in plan([self.D1, self.D2, self.D3], {}, until, self.NOW)] == \
            [(self.D1, None, {}, "new", set()), (self.D2, until, {}, "new", set())]
        # a later run with no cut-off (but D2 is complete by now) redoes D2 fully
        assert [_t(t) for t in plan([self.D2], {self.D2: self.rec(self.D2, until)}, None, self.NOW)] == \
            [(self.D2, None, {}, "day", set())]
        # an earlier cut-off than what's loaded never shrinks a day
        assert plan([self.D2], {self.D2: self.rec(self.D2)}, until, self.NOW) == []


class TestPlanPerPool:
    """Global cut T0 on D2 06:00; pool P is still collected only by the old deployment until TL = D3 03:00."""
    NOW = datetime(2026, 11, 20, tzinfo=UTC)
    D1, D2, D3, D4 = (date(2026, 11, d) for d in (10, 11, 12, 13))
    T0 = datetime(2026, 11, 11, 6, 0, tzinfo=UTC)
    TL = datetime(2026, 11, 12, 3, 0, tzinfo=UTC)
    DAYS = [D1, D2, D3, D4]

    def one_pass(self):
        return plan(self.DAYS, {}, self.T0, self.NOW, {"P": self.TL})

    def test_one_pass(self):
        assert [_t(t) for t in self.one_pass()] == [
            (self.D1, None, {}, "new", set()),
            (self.D2, self.T0, {"P": None}, "new", set()),                       # P: the whole of D2
            (self.D3, datetime(2026, 11, 12, tzinfo=UTC), {"P": self.TL}, "new", set()),   # others: nothing of D3
        ]                                                                          # D4: nothing for anyone

    def done(self, tasks):
        return {t.day: t.cuts for t in tasks}

    def test_second_pass_reloads_only_that_pool(self):
        first = plan(self.DAYS, {}, self.T0, self.NOW)
        assert [t.day for t in first] == [self.D1, self.D2]
        second = plan(self.DAYS, self.done(first), self.T0, self.NOW, {"P": self.TL})
        assert [_t(t) for t in second] == [
            (self.D2, self.T0, {"P": None}, "sources", {"P"}),
            (self.D3, datetime(2026, 11, 12, tzinfo=UTC), {"P": self.TL}, "new", set()),
        ]
        # recorded cuts equal those of the single pass, and a re-run is a no-op either way
        assert self.done(second) | {self.D1: self.done(first)[self.D1]} == self.done(self.one_pass())
        assert plan(self.DAYS, self.done(self.one_pass()), self.T0, self.NOW, {"P": self.TL}) == []

    def test_only_pools_never_advances_other_sources(self):
        first = self.done(plan(self.DAYS, {}, self.T0, self.NOW))
        # forgetting --until in the second pass: with --only-pools the others still keep T0
        second = plan(self.DAYS, first, None, self.NOW, {"P": self.TL}, only_pools={"P"})
        assert [_t(t) for t in second] == [
            (self.D2, self.T0, {"P": None}, "sources", {"P"}),
            (self.D3, datetime(2026, 11, 12, tzinfo=UTC), {"P": self.TL}, "new", set()),
        ]
        # without it, every source would grow to the whole day: whole-day reloads
        assert {t.mode for t in plan(self.DAYS, first, None, self.NOW, {"P": self.TL})} == {"day", "new"}

    def test_pool_cut_never_shrinks(self):
        done = self.done(self.one_pass())
        assert plan(self.DAYS, done, self.T0, self.NOW) == []                      # without the option: keep P's rows
        assert plan(self.DAYS, done, self.T0, self.NOW, {"P": self.T0}) == []      # an earlier P cut: keep
        later = self.TL + timedelta(hours=1)
        assert [_t(t) for t in plan(self.DAYS, done, self.T0, self.NOW, {"P": later})] == \
            [(self.D3, datetime(2026, 11, 12, tzinfo=UTC), {"P": later}, "sources", {"P"})]
        # the default growing past P's cut: P is no longer special that day
        assert [_t(t) for t in plan([self.D2], done, None, self.NOW)] == [(self.D2, None, {}, "day", set())]

    def test_pool_cut_before_default(self):
        early = datetime(2026, 11, 11, 3, 0, tzinfo=UTC)
        assert [_t(t) for t in plan([self.D2], {}, self.T0, self.NOW, {"P": early})] == \
            [(self.D2, self.T0, {"P": early}, "new", set())]

    def test_live_cap_applies_to_pool_cuts(self):
        now = datetime(2026, 11, 12, 2, 0, tzinfo=UTC)
        t = plan([self.D3], {}, self.T0, now, {"P": self.TL})
        assert [_t(x) for x in t] == [(self.D3, datetime(2026, 11, 12, tzinfo=UTC), {"P": now - LIVE_SAFETY}, "new", set())]


class TestCuts:
    D = date(2026, 11, 11)

    def test_normalization_and_admission(self):
        c = Cuts.make(self.D, datetime(2026, 11, 11, 6, tzinfo=UTC),
                      {"P": datetime(2026, 11, 13, tzinfo=UTC), "Q": datetime(2026, 11, 11, 6, tzinfo=UTC),
                       "R": datetime(2026, 11, 1, tzinfo=UTC)})
        assert c.per_source == {"P": None, "R": datetime(2026, 11, 11, tzinfo=UTC)}   # Q = default: dropped
        assert c.query_until() is None
        assert c.admits("P", datetime(2026, 11, 11, 23, tzinfo=UTC))
        assert not c.admits("Q", datetime(2026, 11, 11, 6, tzinfo=UTC))
        assert not c.admits("R", datetime(2026, 11, 11, 0, tzinfo=UTC))
        assert c.any_coverage()
        assert not Cuts.empty(self.D).any_coverage()

    def test_record_round_trip(self):
        c = Cuts.make(self.D, datetime(2026, 11, 11, 6, tzinfo=UTC), {"P": None, "a=b": datetime(2026, 11, 11, 9, tzinfo=UTC)})
        rec = c.pool_until_json()
        assert rec == {"P": None, "a=b": "2026-11-11T09:00:00+00:00"}
        assert Cuts.from_record(self.D, c.default, rec) == c
        assert Cuts.from_record(self.D, None, {}) == Cuts.make(self.D, None)


class TestCli:
    def test_pool_until_parsing(self):
        from m2p.__main__ import parser
        a = parser().parse_args(["migrate", "--until", "2026-11-11T06:00:00Z", "--pool-until", "Pool X=2026-11-12T03:00",
                                 "--pool-until", "a=b=2026-11-12T04:00:00+01:00", "--only-pools", "Pool X,a=b"])
        assert dict(a.pool_until) == {"Pool X": datetime(2026, 11, 12, 3, tzinfo=UTC),
                                      "a=b": datetime(2026, 11, 12, 3, tzinfo=UTC)}
        assert a.only_pools == ["Pool X", "a=b"]


# ── day selection (client-side half; the query half is exercised end to end) ────────────────────────────────────
class _FakeColl:
    def __init__(self, docs):
        self.docs = docs

    def find(self, query, projection=None, batch_size=None):
        return iter(self.docs)


class TestDaySelection:
    def test_each_document_lands_in_exactly_one_day(self):
        docs = [{"_id": 1, "timestamp": "2024-06-10T23:30:00-06:00"},   # UTC 06-11
                {"_id": 2, "timestamp": "2024-06-11T01:00:00+02:00"},   # UTC 06-10
                {"_id": 3, "timestamp": "2024-06-10T23:59:59.999999"},  # naive: 06-10
                {"_id": 4, "timestamp": hex_ts(datetime(2024, 6, 11, tzinfo=UTC))},
                {"_id": 5, "timestamp": datetime(2024, 6, 10, 12)},
                {"_id": 6, "timestamp": "2024-06-10T25:00:00"},          # unparseable: its prefix day, to be rejected
                {"_id": 7, "timestamp": "garbage"}]
        src = Source.__new__(Source)
        src.db = type("DB", (), {"mining_notify": _FakeColl(docs)})()
        src.batch_size = 10
        got = {d: sorted(x["_id"] for x in src.iter_day(d)) for d in (date(2024, 6, 9), date(2024, 6, 10), date(2024, 6, 11))}
        assert got == {date(2024, 6, 9): [], date(2024, 6, 10): [2, 3, 5, 6], date(2024, 6, 11): [1, 4]}
        until = datetime(2024, 6, 10, 12, tzinfo=UTC)
        assert sorted(x["_id"] for x in src.iter_day(date(2024, 6, 10), until)) == [6]   # 2 is 23:00 UTC

    def test_per_source_cuts(self):
        d, t = date(2024, 6, 10), lambda h: datetime(2024, 6, 10, h, tzinfo=UTC)
        docs = [{"_id": i, "timestamp": hex_ts(t(h)), "pool_name": p}
                for i, (h, p) in enumerate([(5, "A"), (7, "A"), (5, "B"), (7, "B"), (9, "B"), (5, None)])]
        docs.append({"_id": 9, "timestamp": "2024-06-10T25:00:00", "pool_name": "C"})   # unparseable, source C
        src = Source.__new__(Source)
        src.db = type("DB", (), {"mining_notify": _FakeColl(docs)})()
        src.batch_size = 10
        cuts = Cuts.make(d, t(6), {"B": t(8), "C": t(0)})
        assert sorted(x["_id"] for x in src.iter_day(d, cuts=cuts)) == [0, 2, 3, 5]   # C has none of the day
        assert sorted(x["_id"] for x in src.iter_day(d, cuts=Cuts.make(d, t(6), {"C": None}))) == [0, 2, 5, 9]

    def test_query_ranges(self):
        q = Source.day_query(date(2024, 6, 10))["$or"]
        assert q[0]["timestamp"]["$gte"] == format(int(datetime(2024, 6, 10, tzinfo=UTC).timestamp()) * 10**9, "016x")
        assert q[1]["timestamp"] == {"$gte": "2024-06-10", "$lt": "2024-06-11"}
        assert q[2]["timestamp"]["$gte"] == "2024-06-09" and "$regex" in q[2]["timestamp"]
        assert parse_timestamp(q[0]["timestamp"]["$lt"])[0] == datetime(2024, 6, 11, tzinfo=UTC)
