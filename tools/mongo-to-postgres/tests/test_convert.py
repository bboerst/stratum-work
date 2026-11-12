import importlib.util
import itertools
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from m2p import convert as cv
from m2p.convert import Reject, TipIndex, convert, parse_timestamp
from m2p.shared import REPO_ROOT, route

from helpers import coinbase1, doc, hex_ts, iso_naive

UTC = timezone.utc
T = datetime(2026, 11, 12, 6, 0, 0, 123456, tzinfo=UTC)


# ── timestamps ──────────────────────────────────────────────────────────────────────────────────────────────────
class TestTimestamps:
    def test_hex_ns_truncates_to_microseconds(self):
        dt, fmt = parse_timestamp(hex_ts(T))
        assert (dt, fmt) == (T, cv.FMT_HEX)
        assert parse_timestamp("18e73296bf15f43f")[0] == datetime.fromtimestamp(0x18e73296bf15f43f // 1000 / 1e6, tz=UTC)
        assert parse_timestamp("18e73296bf15f43f")[0].microsecond == (0x18e73296bf15f43f // 1000) % 1_000_000

    @pytest.mark.parametrize("s", ["2024-06-10T12:00:00.123456", "2024-06-10 12:00:00.123456",
                                   "2024-06-10T12:00:00.123456789"])
    def test_naive_iso_is_utc_not_local_time(self, s, monkeypatch):
        monkeypatch.setenv("TZ", "America/Denver")   # the historical trap: fromisoformat().timestamp() = local
        import time
        time.tzset()
        try:
            dt, fmt = parse_timestamp(s)
        finally:
            monkeypatch.delenv("TZ")
            time.tzset()
        assert fmt == cv.FMT_ISO_NAIVE
        assert dt == datetime(2024, 6, 10, 12, 0, 0, 123456, tzinfo=UTC)
        assert dt.tzinfo == UTC

    def test_iso_with_offset_uses_the_offset(self):
        assert parse_timestamp("2024-06-10T12:00:00Z") == (datetime(2024, 6, 10, 12, tzinfo=UTC), cv.FMT_ISO_TZ)
        assert parse_timestamp("2024-06-10T23:30:00-06:00")[0] == datetime(2024, 6, 11, 5, 30, tzinfo=UTC)
        assert parse_timestamp("2024-06-10T12:00:00+0200")[0] == datetime(2024, 6, 10, 10, tzinfo=UTC)

    def test_bson_datetime_naive_or_aware(self):
        assert parse_timestamp(datetime(2024, 6, 10, 12, 0, 0, 5000)) == (
            datetime(2024, 6, 10, 12, 0, 0, 5000, tzinfo=UTC), cv.FMT_DATETIME)
        aware = datetime(2024, 6, 10, 6, tzinfo=timezone(timedelta(hours=-6)))
        assert parse_timestamp(aware)[0] == datetime(2024, 6, 10, 12, tzinfo=UTC)

    @pytest.mark.parametrize("bad", [None, 12345, "", "18E73296BF15F43F", "18e73296bf15f4", "2024-13-45T00:00:00",
                                     "yesterday"])
    def test_unparseable(self, bad):
        with pytest.raises(Reject) as e:
            parse_timestamp(bad)
        assert e.value.reason == "timestamp_unparseable"

    def test_hex_ns_inverse(self):
        assert parse_timestamp(cv.hex_ns(T))[0] == T
        assert cv.hex_ns(T) < cv.hex_ns(T + timedelta(microseconds=1))


# ── routing: identical to live ingest ───────────────────────────────────────────────────────────────────────────
def _live_pgsink():
    """collector/pgsink.py imported the way the collector's own tests do, independently of m2p.shared."""
    sys.path.insert(0, str(REPO_ROOT / "collector"))
    try:
        spec = importlib.util.spec_from_file_location("pgsink_live", REPO_ROOT / "collector" / "pgsink.py")
        mod = importlib.util.module_from_spec(spec)
        sys.modules["pgsink_live"] = mod   # dataclasses need the module registered
        spec.loader.exec_module(mod)
        return mod
    finally:
        sys.path.pop(0)


def _t(r):
    return (r.table, r.chain, r.reason)


class TestRouting:
    def test_route_is_the_collector_function(self):
        live = _live_pgsink()
        assert route.__code__.co_code == live.route.__code__.co_code
        assert Path(route.__code__.co_filename).resolve() == (REPO_ROOT / "collector" / "pgsink.py").resolve()

    def test_equivalent_on_a_grid(self):
        live = _live_pgsink()
        tip = 975_499
        for h, fam, t in itertools.product([0, -1, 1, 975_490, 975_492, 975_493, 975_499, 975_501, 975_502,
                                            6_976_415, 824_246], [None, "bch", "unknown", "xyz"], [tip, None]):
            assert _t(route(h, fam, t)) == _t(live.route(h, fam, t)), (h, fam, t)

    def test_tip_at_receive_time(self):
        base = datetime(2026, 11, 12, tzinfo=UTC)
        # header times aren't monotonic: 101's header is earlier than 100's
        tips = TipIndex([(100, int(base.timestamp()) + 600), (101, int(base.timestamp()) + 500),
                         (102, int(base.timestamp()) + 1800)])
        assert tips.tip_at(base) is None
        assert tips.tip_at(base + timedelta(seconds=500)) == 101
        assert tips.tip_at(base + timedelta(seconds=700)) == 101
        assert tips.tip_at(base + timedelta(seconds=1799)) == 101
        assert tips.tip_at(base + timedelta(seconds=1800)) == 102
        assert tips.block_time[101] == int(base.timestamp()) + 500

    def test_backfill_routing_matches_live_for_documents(self):
        live = _live_pgsink()
        t_block = datetime(2026, 11, 12, 5, 0, tzinfo=UTC)
        tips = TipIndex([(975_499, int(t_block.timestamp()))])
        cases = [doc("a", hex_ts(T)),                                            # tip+1
                 doc("b", hex_ts(T), height=6_976_415),                          # impossible
                 doc("c", hex_ts(T), coinbase1=coinbase1(raw_script=b"\x00\x00")),  # parse failure
                 doc("d", hex_ts(T), chain_family="bch"), doc("e", hex_ts(T), chain_family="unknown"),
                 doc("f", hex_ts(t_block - timedelta(seconds=1)), height=123)]   # before any block: no tip
        for d in cases:
            c = convert(d)
            live_height = live.to_row(dict(d, height=c.height), 1)[2]
            assert _t(cv.route_converted(c, tips)) == _t(live.route(live_height, d.get("chain_family"), tips.tip_at(c.received_at)))
        assert [cv.route_converted(convert(d), tips).reason for d in cases] == [
            None, "height_implausible", "height_parse_failed", "bch", "unknown_chain", None]


# ── document conversion ────────────────────────────────────────────────────────────────────────────────────────
class TestConvert:
    def test_lossless_values(self):
        d = doc("x", hex_ts(T))
        c = convert(d)
        job, prev, cb1, cb2, br, ver, nb, nt, clean, en1, e2, lat, latm = c.values
        assert (job, prev.hex(), cb1.hex(), cb2.hex(), br.hex()) == (
            d["job_id"], d["prev_hash"], d["coinbase1"], d["coinbase2"], "".join(d["merkle_branches"]))
        assert [format(v, "08x") for v in (ver, nb, nt)] == [d["version"], d["nbits"], d["ntime"]]
        assert (clean, en1.hex(), e2, lat, latm) == (True, "abcd", 8, 31.1805, "tcp")
        assert c.height == 975_500 and c.received_at == T and c.mongo_id == "x"

    def test_height_is_rederived_not_copied(self):
        c = convert(doc("x", hex_ts(T), height=975_500, coinbase1=coinbase1(975_501)))
        assert (c.stored_height, c.height) == (975_500, 975_501)
        assert convert(doc("y", hex_ts(T), coinbase1=coinbase1(raw_script=b"\x00"))).height == 0

    @pytest.mark.parametrize("field,value,reason", [
        ("prev_hash", "AA" * 32, "non_lossless_hex"), ("coinbase2", "abc", "non_lossless_hex"),
        ("prev_hash", "11" * 31, "non_lossless_hex"), ("version", "2000000", "non_lossless_hex"),
        ("nbits", "0x1701e5", "non_lossless_hex"), ("merkle_branches", ["aa" * 31], "non_lossless_hex"),
        ("job_id", 17, "bad_job_id"), ("clean_jobs", 1, "bad_clean_jobs"), ("extranonce2_length", "8", "bad_extranonce2_length"),
        ("lat_m", "udp", "bad_latency"), ("lat_ms", "3", "bad_latency"), ("pool_name", 5, "bad_pool_name"),
    ])
    def test_rejects_anything_that_would_not_round_trip(self, field, value, reason):
        with pytest.raises(Reject) as e:
            convert(doc("x", hex_ts(T), **{field: value}))
        assert e.value.reason == reason

    def test_optional_fields_and_unknown_fields(self):
        d = doc("x", hex_ts(T), merkle_branches=[], extra_field=1)
        del d["lat_ms"], d["lat_m"]
        c = convert(d)
        assert c.values[4] == b"" and c.values[11:] == (None, None)
        assert c.unknown_fields == ("extra_field",)
        assert convert(doc("y", hex_ts(T), pool_name=None)).source == ""

    def test_naive_iso_document(self):
        c = convert(doc("x", iso_naive(T)))
        assert c.fmt == cv.FMT_ISO_NAIVE and c.received_at == T
        assert cv.utc_day(c.received_at) == date(2026, 11, 12)


class TestDayTips:
    def test_stratum_prev_hash_word_order(self):
        # block 975,564 and the prev_hash its successors' templates carry (dev data)
        assert cv.stratum_prev_hash("00000000000000000000bf4136548940516fd4709ec366105d55c06a3249f51e").hex() == \
            "3249f51e5d55c06a9ec36610516fd470365489400000bf410000000000000000"

    def test_prev_hash_evidence_lifts_a_lagging_header_tip(self):
        base = datetime(2026, 11, 12, 14, 0, tzinfo=UTC)
        hashes = {h: format(h, "064x") for h in range(975_560, 975_566)}
        # 975,563/975,564 headers are minutes after they really arrived (as in production)
        blocks = [(975_562, int((base + timedelta(minutes=21)).timestamp()), hashes[975_562]),
                  (975_563, int((base + timedelta(minutes=55)).timestamp()), hashes[975_563]),
                  (975_564, int((base + timedelta(minutes=54)).timestamp()), hashes[975_564])]
        tips = TipIndex(blocks)
        t = base + timedelta(minutes=52, seconds=38)
        d = doc("x", hex_ts(t), height=975_565, coinbase1=coinbase1(975_565),
                prev_hash=cv.stratum_prev_hash(hashes[975_564]).hex())
        c = convert(d)
        assert tips.tip_at(t) == 975_562
        assert cv.route_converted(c, tips).reason == "height_implausible"      # header times alone: misrouted
        day = cv.DayTips(tips, [c])
        assert day.tip_at(t) == 975_564 and day.tip_at(t - timedelta(seconds=1)) == 975_562
        assert cv.route_converted(c, day).table == "templates"
        # evidence never lowers the tip, and a stale template is still implausible
        stale = convert(doc("y", hex_ts(t), height=975_555, coinbase1=coinbase1(975_555),
                            prev_hash=cv.stratum_prev_hash(hashes[975_562]).hex()))
        assert cv.route_converted(stale, cv.DayTips(tips, [c, stale])).reason == "height_implausible"
