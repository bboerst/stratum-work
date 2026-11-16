from site_compare.compare import (classify, compare_blocks, compare_first_seen, compare_pools, compare_templates,
                                  delta_stats, diff_paths, job_key, kendall_discordant, match_height, percentile,
                                  ts_ns)

S = 1_000_000_000   # ns per second


def tpl(pool="p1", h=100, t_s=0.0, merkle="aa", ntime="65000000", version="20000000", nbits="17000000",
        prev="11" * 32, **kw):
    return {"pool_name": pool, "height": h, "prev_hash": prev, "merkle_branches": [merkle * 32],
            "version": version, "nbits": nbits, "ntime": ntime, "timestamp": format(int(1e18 + t_s * S), "x"),
            "coinbase1": "c1", "coinbase2": "c2", "clean_jobs": False, "extranonce1": "abcd",
            "extranonce2_length": 8, **kw}


def test_job_key_ignores_ids_times_and_case():
    a = tpl(t_s=1, id="x", extranonce1="0000")
    b = tpl(t_s=9, id="y", prev=("11" * 32).upper())
    assert job_key(a) == job_key(b)
    assert job_key(tpl(ntime="65000001")) != job_key(a)
    assert job_key(tpl(merkle="bb")) != job_key(a)


def test_ts_ns_hex_and_naive_iso_as_utc():
    assert ts_ns({"timestamp": "10"}) == 16
    assert ts_ns({"timestamp": "2030-01-01T00:00:00"}) == 1_893_456_000 * S


def test_match_is_one_to_one_closest_first_per_key():
    a = [tpl(t_s=0), tpl(t_s=30)]                   # the same job twice on A
    b = [tpl(t_s=30.010)]                           # B only got the re-send
    hm = match_height(100, a, b)
    [(ta, tb)] = hm.pairs["p1"]
    assert ta is a[1] and tb is b[0]
    [u] = hm.unmatched
    assert (u.side, u.cls, u.template) == ("a", "extra_copy", a[0])


def classify_one(a, b, anywhere=None, gap_s=60):
    hm = match_height(100, a, b)
    by = {"a": {}, "b": {}}
    for side, ts in (("a", a), ("b", b)):
        for t in ts:
            by[side].setdefault(t["pool_name"], []).append(t)
    pools = anywhere or {"a": {t["pool_name"] for t in a}, "b": {t["pool_name"] for t in b}}
    classify(hm, by, pools, gap_s)
    return sorted((u.side, u.cls) for u in hm.unmatched), hm


def test_near_miss_names_the_differing_fields():
    got, hm = classify_one([tpl(ntime="65000000")], [tpl(ntime="65000002")])
    assert got == [("a", "near_miss:ntime"), ("b", "near_miss:ntime")]
    assert {u.detail for u in hm.unmatched} == {"ntime -2 s", "ntime +2 s"}
    got, _ = classify_one([tpl(version="20000000")], [tpl(version="20002000")])
    assert got == [("a", "near_miss:version"), ("b", "near_miss:version")]


def test_pool_one_side_only_vs_missing_at_height():
    got, _ = classify_one([tpl(pool="p2")], [tpl(pool="p1")])
    assert got == [("a", "pool_one_side_only"), ("b", "pool_one_side_only")]
    got, _ = classify_one([tpl(pool="p2")], [tpl(pool="p1")], anywhere={"a": {"p1", "p2"}, "b": {"p1", "p2"}})
    assert got == [("a", "pool_missing_at_height"), ("b", "pool_missing_at_height")]


def test_other_prev_hash():
    got, _ = classify_one([tpl(prev="22" * 32, merkle="cc")], [tpl()])
    assert got == [("a", "other_prev_hash"), ("b", "other_prev_hash")]


def test_time_classes():
    b = [tpl(merkle="b1", t_s=100), tpl(merkle="b2", t_s=200), tpl(merkle="b3", t_s=500)]
    a = [tpl(merkle="a1", t_s=0), tpl(merkle="a2", t_s=350), tpl(merkle="a3", t_s=600), tpl(merkle="a4", t_s=210)]
    hm = match_height(100, a, b)
    by = {"a": {"p1": a}, "b": {"p1": b}}
    classify(hm, by, {"a": {"p1"}, "b": {"p1"}}, gap_s=60)
    cls = {u.template["merkle_branches"][0][:2]: u.cls for u in hm.unmatched if u.side == "a"}
    assert cls == {"a1": "before_other_first", "a2": "other_side_gap", "a3": "after_other_last",
                   "a4": "unexplained"}


def test_compare_templates_deltas_and_totals():
    per_height = {
        100: ([tpl(t_s=0), tpl(merkle="bb", t_s=30)], [tpl(t_s=0.020), tpl(merkle="bb", t_s=29.990)]),
        101: ([tpl(h=101, t_s=600)], []),
    }
    r = compare_templates(per_height)
    p = r["pools"]["p1"]
    assert p.matched == 2 and p.templates == {"a": 3, "b": 2}
    assert sorted(round(d, 3) for d in p.deltas_ms) == [-10.0, 20.0]
    assert dict(p.only["a"]) == {"pool_missing_at_height": 1}
    assert [row["matched"] for row in r["heights"]] == [2, 0]
    assert p.coinbase_identical == 2


def test_percentile_and_stats():
    assert percentile([], 50) is None
    xs = list(range(1, 101))
    assert (percentile(xs, 50), percentile(xs, 95), percentile(xs, 100)) == (50, 95, 100)
    s = delta_stats([-1.0, 2.0, 3.0])
    assert s["n"] == 3 and s["p50"] == 2.0 and s["max"] == 3.0 and s["b_earlier_share"] == round(1 / 3, 4)
    assert delta_stats([]) == {"n": 0}


def test_kendall_over_common_pools():
    assert kendall_discordant(["x", "y", "z"], ["x", "y", "z"]) == (0, 3)
    assert kendall_discordant(["x", "y", "z"], ["z", "y", "x", "w"]) == (3, 3)


def fs(pool, t_s, reliable=True):
    return {"poolName": pool, "firstSeenTimestamp": format(int(1e18 + t_s * S), "x"), "reliable": reliable}


def test_first_seen_sets_order_and_flags():
    r = compare_first_seen({100: ([fs("x", 0), fs("y", 1)], [fs("y", 0.5), fs("x", 0.6, False), fs("z", 2)])})
    row = r["heights"][0]
    assert row["only_b"] == ["z"] and not row["same_order"] and row["reliable_differs"] == 1
    assert r["pool_only_on_b_heights"] == {"z": 1} and r["kendall_tau"] == -1.0


def blk(h, hash_="aa", pool="P", analysis=None, **kw):
    return {"height": h, "block_hash": hash_, "coinbase_script_sig": "03", "timestamp": 1,
            "mining_pool": {"name": pool, "id": 1}, "analysis": analysis or {"pool_identification": {"method": "tag"}},
            **kw}


def test_blocks_ids_ignored_key_order_ignored_differences_categorized():
    a = {1: [blk(1, _id={"$oid": "x"}, id="[object Object]")], 2: [blk(2, pool="P")], 3: [blk(3, "c1")],
         4: [blk(4)], 5: [blk(5, analysis={"pool_identification": {"method": "tag"}, "z": 1})]}
    b = {1: [dict(reversed(list(blk(1, id="aa").items())))], 2: [blk(2, pool="Q")], 3: [blk(3, "c2")],
         5: [blk(5)]}
    r = compare_blocks(a, b, [1, 2, 3, 4, 5, 6])
    kinds = {d["height"]: d["kind"] for d in r["differences"]}
    assert kinds == {2: "fields differ (pool_identification)", 3: "block hash differs", 4: "block only on A",
                     5: "fields differ (analysis)"}
    assert r["summary"]["identical"] == 1 and r["summary"]["missing_both"] == 1


def test_diff_paths():
    assert diff_paths({"a": 1, "b": [1, 2]}, {"b": [1, 3], "c": 0}) == ["$.a: only on A", "$.b[1]: 2 vs 3",
                                                                       "$.c: only on B"]


def test_pools_by_name():
    a = [{"id": "x1", "name": "n1", "tag": None, "addresses": ["q", "r"]}, {"id": "x2", "name": "n2"}]
    b = [{"id": "2", "name": "n2"}, {"id": "1", "name": "n1", "tag": None, "addresses": ["r", "q"]},
         {"id": "3", "name": "n3"}]
    r = compare_pools(a, b)
    assert r["only_b"] == ["n3"] and r["only_a"] == [] and r["field_differences"] == [] and not r["same_order"]


def test_source_classes():
    from site_compare.compare import source_of
    assert source_of({"id": "12-1893456000000000-j1"}) == "12" and source_of({"id": "8c1f-uuid"}) is None
    assert source_of({"id": "12345678-1234-4123-8123-123456789012"}) is None      # an all-digit UUID
    # B has sources 1 and 2 for p1 in the range; at this height only 2, with its own job: A's template is explained
    # by B's missing source, B's by nothing (single source here).
    a = [tpl(merkle="a1", t_s=0)]
    b = [tpl(merkle="b1", t_s=5, id="2-1893456005000000-j")]
    hm = match_height(100, a, b)
    classify(hm, {"a": {"p1": a}, "b": {"p1": b}}, {"a": {"p1"}, "b": {"p1"}}, 60, {"a": {}, "b": {"p1": "1"}})
    assert sorted((u.side, u.cls) for u in hm.unmatched) == [("a", "other_source_missing"), ("b", "unexplained")]
    hm = match_height(100, a, b)          # B's main source is the one that's here: no explanation
    classify(hm, {"a": {"p1": a}, "b": {"p1": b}}, {"a": {"p1"}, "b": {"p1"}}, 60, {"a": {}, "b": {"p1": "2"}})
    assert sorted((u.side, u.cls) for u in hm.unmatched) == [("a", "unexplained"), ("b", "unexplained")]
    # Both of B's sources here, one with its own jobs: multi_source.
    b = [tpl(merkle="a1", t_s=0.01, id="1-1893456000000000-j"), tpl(merkle="b1", t_s=5, id="2-1893456005000000-j")]
    hm = match_height(100, a, b)
    classify(hm, {"a": {"p1": a}, "b": {"p1": b}}, {"a": {"p1"}, "b": {"p1"}}, 60, {"a": {}, "b": {"p1": "1"}})
    assert [(u.side, u.cls) for u in hm.unmatched] == [("b", "multi_source")]


def test_before_other_started_at_the_first_height():
    # B's collection starts at t=100 s, during height 100; A's earlier templates there are explained by that.
    per_height = {100: ([tpl(merkle="a0", t_s=0), tpl(merkle="a1", t_s=100)], [tpl(merkle="a1", t_s=100.01)]),
                  101: ([tpl(h=101, merkle="c", t_s=700)], [tpl(h=101, merkle="c", t_s=700.01)])}
    r = compare_templates(per_height, gap_s=60)
    assert dict(r["pools"]["p1"].only["a"]) == {"before_other_started": 1}
