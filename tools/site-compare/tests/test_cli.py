"""The whole tool against the two fake sites (tests/fakesite.py), in-process."""
import json
import socket

import fakesite
import pytest

from site_compare.__main__ import main
from site_compare.api import normalize_base


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def sites():
    a, b, state, stop = fakesite.start(free_port(), free_port())
    yield a, b, state
    stop()


def args(a, b, tmp_path, *extra):
    return ["--a", a, "--b", b, "--gap-s", "25", "--rate", "5", "--burst", "5", "--cache", str(tmp_path / "c"),
            "--out", str(tmp_path / "r.md"), "--json", str(tmp_path / "r.json"), "--quiet", *extra]


def test_end_to_end_finds_what_was_planted(sites, tmp_path):
    a, b, state = sites
    assert main(args(a, b, tmp_path)) == 0
    assert fakesite.check(str(tmp_path / "r.json")) == 0
    md = (tmp_path / "r.md").read_text()
    assert "| pool-two | 5/4 | 30/21 | 21 |" in md
    assert "**1002** fields differ (pool_identification)" in md


def test_rerun_uses_the_cache(sites, tmp_path):
    a, b, state = sites
    main(args(a, b, tmp_path))
    first = dict(state.requests)
    main(args(a, b, tmp_path))
    second = {k: state.requests[k] - first[k] for k in first}
    r = json.loads((tmp_path / "r.json").read_text())
    # Only the tips, the lowest block / probe, block pages that can still change, the pools list and R3 are refetched.
    assert sum(second.values()) < sum(first.values()) / 2
    assert r["meta"]["requests"]["cache_hits"] >= 20


def test_max_requests_stops_and_resume_completes(sites, tmp_path):
    a, b, _ = sites
    assert main(args(a, b, tmp_path, "--max-requests", "12")) == 3
    assert main(args(a, b, tmp_path)) == 0
    assert fakesite.check(str(tmp_path / "r.json")) == 0


def test_explicit_range_is_clamped_to_the_lower_tip(sites, tmp_path):
    a, b, _ = sites
    assert main(args(a, b, tmp_path, "--from", "1002", "--to", "1010")) == 0
    m = json.loads((tmp_path / "r.json").read_text())["meta"]
    assert (m["from"], m["to"]) == (1002, 1004)


def test_rejects_bad_urls_and_rates(tmp_path):
    with pytest.raises(ValueError):
        normalize_base("site-a.example")
    assert normalize_base("https://site-a.example/") == "https://site-a.example"
    assert main(["--a", "https://site-a.example", "--b", "https://site-b.example", "--rate", "10"]) == 2
