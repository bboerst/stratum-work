import json

from helpers import T0, commitment, p2wpkh, template
from replica_compare.__main__ import run
from replica_compare.analyze import analyze_pool, classify_location, pair_templates
from replica_compare.report import render

EN_A, EN_B = b"\xa1\xa2\xa3\xa4", b"\xb1\xb2\xb3\xb4"


def counter_bytes(n: int) -> bytes:
    return n.to_bytes(3, "little")


def scenario(n_jobs=20, offset_ms=6.0, skip_b=(), per_conn=lambda r, i: b"", per_conn_out=None, ntime_drift=False,
             repeats=1, gaps_ms=(10_000,)):
    """Two replicas get the same jobs (a new merkle set every 10 s); b offset_ms later. per_conn(replica, i) is
    appended to the scriptSig tail, standing in for per-connection coinbase bytes (i counts templates). Each job is
    sent `repeats` times, 1 s apart; jobs start gaps_ms apart (cycled)."""
    rows = []
    start = 0
    for i in range(n_jobs):
        if i:
            start += gaps_ms[(i - 1) % len(gaps_ms)]
        merkle = bytes([i]) * 32
        sends = [(r, e, d, k) for k in range(repeats) for r, e, d in (("a", EN_A, 0.0), ("b", EN_B, offset_ms))]
        for r, en1, dt, k in sends:
            if r == "b" and i in skip_b:
                continue
            outs = None
            if per_conn_out:
                outs = [(312_500_000, p2wpkh("payout")), (0, per_conn_out(r, i)), (0, commitment(merkle.hex()))]
            ntime = 1_893_456_000 + i * 10 + (1 if ntime_drift and r == "b" and i % 2 else 0)
            rows.append(template(r, start + k * 1000 + dt, merkle=merkle, en1=en1,
                                 sig_post=b"/x/" + per_conn(r, i * repeats + k),
                                 job_id=f"{r}{i}", ntime=ntime, outputs=outs))
    return rows


def test_pairing_is_nearest_one_to_one_and_respects_prev_hash():
    a = [template("a", 0), template("a", 1000), template("a", 5000, prev=b"\x33" * 32)]
    b = [template("b", 10), template("b", 1500), template("b", 5005)]
    pairs = pair_templates(a, b, max_offset_s=2.0)
    got = [((x.received_at - T0).total_seconds(), (y.received_at - T0).total_seconds()) for x, y in pairs]
    assert got == [(0.0, 0.01), (1.0, 1.5)]          # the prev_hash 33.. template has no partner
    assert pair_templates(a, b, max_offset_s=0.1) == [pairs[0]]


def test_identical_jobs_per_session_counter():
    rows = scenario(per_conn=lambda r, i: counter_bytes((100 if r == "a" else 5000) + i), skip_b=(7,),
                    gaps_ms=(2_000, 20_000))   # irregular timing, so it can't pass for a clock
    res = analyze_pool(rows, max_offset_s=2.0)
    assert res["templates"] == {"a": 20, "b": 19}
    assert res["pairs"] == 19
    eq = res["field_equal_share"]
    assert eq["prev_hash"] == eq["merkle_branches"] == eq["ntime"] == eq["coinbase_outputs"] == 1.0
    assert eq["job_id"] == 0.0 and eq["extranonce1"] == 0.0 and eq["coinbase2"] == 0.0 and eq["coinbase1"] == 1.0
    cb = res["coinbase"]
    assert cb["outputs_identical"] == 19 and cb["regions"] == {"sig_post": 19}
    loc = cb["fields"][0]
    assert (loc["region"], loc["anchor"]) == ("sig_post", "end") and loc["length"] <= 3
    assert loc["classification"]["label"] == "per-session counter"
    k1 = res["job_keys"]["prev_hash+merkle+version+nbits"]
    assert (k1["jobs_a"], k1["jobs_b"], k1["matched"], k1["only_a"], k1["only_b"]) == (20, 19, 19, 1, 0)
    assert k1["a_first"] == 19 and k1["b_first"] == 0
    assert abs(k1["offset_ms"]["p50"] - 6.0) < 0.01
    assert res["unmatched_jobs"]["a"]["jobs"] == 1
    assert res["unmatched_jobs"]["a"]["lifetime_ms"]["p50"] in (2_000, 20_000)


def test_clock_and_timestamp():
    # jobs 10 s apart, a 100,000 ticks/s clock; b's connection is 3 ticks behind
    clock = scenario(per_conn=lambda r, i: (7_000_000 + 1_000_000 * i + (3 if r == "b" else 0)).to_bytes(4, "big"))
    loc = analyze_pool(clock)["coinbase"]["fields"][0]
    assert loc["classification"]["label"] == "clock-like (~100000 ticks/s, low bytes)"
    ns = scenario(per_conn=lambda r, i: int((T0.timestamp() + 10 * i) * 1e9 + (5000 if r == "b" else 0))
                  .to_bytes(8, "little"))
    loc = analyze_pool(ns)["coinbase"]["fields"][0]
    assert loc["classification"]["label"] == "timestamp (ns, low bytes)"


def test_per_session_constant_tag_and_random():
    rows = scenario(per_conn=lambda r, i: b"\x01\x02" if r == "a" else b"\x09\x08")
    loc = analyze_pool(rows)["coinbase"]["fields"][0]
    assert loc["classification"]["label"].startswith("per-session constant")
    import hashlib
    rows = scenario(per_conn=lambda r, i: hashlib.sha256(f"{r}{i}".encode()).digest()[:8], repeats=2)
    loc = analyze_pool(rows)["coinbase"]["fields"][0]
    assert loc["classification"]["label"] == "random (new value per template)"
    rows = scenario(per_conn=lambda r, i: hashlib.sha256(f"{r}{i // 2}".encode()).digest()[:8], repeats=2)
    loc = analyze_pool(rows)["coinbase"]["fields"][0]
    assert loc["classification"]["label"] == "per connection, new value with each job"


def test_per_connection_outputs_detected():
    rows = scenario(per_conn_out=lambda r, i: b"\x6a\x04" + (b"AAAA" if r == "a" else b"BBBB"))
    res = analyze_pool(rows)
    cb = res["coinbase"]
    assert cb["outputs_identical"] == 0 and cb["output_scripts_differ"] == 20
    assert cb["differing_output_kinds"] == {"op_return": 20}
    assert res["field_equal_share"]["coinbase_outputs"] == 0.0
    # the outputs-aware key splits the jobs; the merkle key doesn't
    assert res["job_keys"]["prev_hash+merkle+version+nbits"]["match_rate"] == 1.0
    assert res["job_keys"]["prev_hash+merkle+version+nbits+outputs"]["match_rate"] == 0.0


def test_ntime_drift_breaks_only_the_ntime_key():
    res = analyze_pool(scenario(ntime_drift=True))
    assert res["field_equal_share"]["ntime"] == 0.5
    assert res["job_keys"]["prev_hash+merkle+version+nbits"]["match_rate"] == 1.0
    assert res["job_keys"]["prev_hash+merkle+version+nbits+ntime"]["match_rate"] < 1.0


def test_single_replica_is_skipped():
    res = analyze_pool([t for t in scenario() if t.replica == "a"])
    assert "skipped" in res


def test_report_never_contains_values():
    rows = scenario(per_conn=lambda r, i: counter_bytes(4242 + i))
    result = run({"pool-1": rows, "pool-2": [t for t in rows if t.replica == "a"]}, T0, T0, ("a", "b"), 2.0)
    md, js = render(result), json.dumps(result, default=str)
    assert "pool-1" in md and "skipped" in md
    for t in rows:
        for secret in (t.coinbase1.hex(), t.coinbase2.hex(), t.extranonce1.hex(), t.job_id + "|"):
            assert secret not in md and secret not in js
    assert counter_bytes(4242).hex() not in js


def test_per_connection_locktime_with_extranonce_in_the_sequence():
    rows = []
    for i in range(10):
        merkle = bytes([i]) * 32
        for r, en1, dt in (("a", b"\x01", 0.0), ("b", b"\x01", 4.0)):
            lock = (1000 if r == "a" else 9000) * (i + 1)          # differs per connection, new value per job
            rows.append(template(r, i * 10_000 + dt, merkle=merkle, en1=en1, sig_pre=b"/t/", locktime=lock,
                                 en_in_sig=5))
    res = analyze_pool(rows)
    cb = res["coinbase"]
    assert cb["extranonce_regions"] == {"scriptSig+sequence": 10}
    assert cb["outputs_identical"] == 10 and cb["scriptsig_differs"] == 0
    assert cb["regions"] == {"locktime": 10}
    assert {f["region"] for f in cb["fields"]} == {"locktime"}


def test_mostly_constant_tag_next_to_a_clock_and_shared_job_builder():
    """A builder tag (2 bytes) followed by the builder's clock (4 bytes). b switches to a's builder for the last
    5 jobs: then job id and coinbase are identical too."""
    rows = []
    for i in range(30):
        merkle = bytes([i]) * 32
        for r, en1 in (("a", EN_A), ("b", EN_B)):
            builder = "a" if r == "a" or i >= 25 else "b"
            tag = b"\x01\x01" if builder == "a" else b"\x02\x02"
            clock = (5_000_000 + 1_000_000 * i + (0 if builder == "a" else 40)).to_bytes(4, "big")
            rows.append(template(r, i * 10_000 + (0 if r == "a" else 3), merkle=merkle, en1=en1,
                                 sig_pre=b"/p/" + tag + clock, job_id=f"{builder}{i}"))
    cb = analyze_pool(rows)["coinbase"]
    labels = {(f["from_start"], f["length"]): f["classification"]["label"] for f in cb["fields"]}
    assert labels[(7, 2)] == "mostly constant per session (changes occasionally)"
    assert labels[(12, 1)].startswith("clock-like")
    assert cb["same_job_id"] == 5 and cb["same_job_id_identical"] == 5
