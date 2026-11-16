import json
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import pytest

from site_compare.fetch import (FetchError, Fetcher, MaxRequestsExceeded, RateLimiter, Response, backoff_delay,
                                retry_after_seconds)


class Clock:
    def __init__(self):
        self.t = 0.0
        self.sleeps = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


def test_rate_limiter_spaces_requests():
    c = Clock()
    lim = RateLimiter(2.0, burst=1, clock=c, sleep=c.sleep)
    for _ in range(5):
        lim.acquire()
    assert c.t == pytest.approx(2.0)      # 5 requests at 2/s: the first is free, then 0.5 s apart


def test_rate_limiter_burst_then_rate():
    c = Clock()
    lim = RateLimiter(1.0, burst=3, clock=c, sleep=c.sleep)
    for _ in range(3):
        lim.acquire()
    assert c.t == 0
    lim.acquire()
    assert c.t == pytest.approx(1.0)
    c.t += 10                              # idle refills to the burst, not beyond
    for _ in range(3):
        assert lim.acquire() == 0
    assert lim.acquire() == pytest.approx(1.0)


def test_retry_after_parsing():
    now = datetime(2030, 1, 1, tzinfo=timezone.utc)
    assert retry_after_seconds("7") == 7
    assert retry_after_seconds(format_datetime(now + timedelta(seconds=30), usegmt=True), now) == 30
    assert retry_after_seconds("soon") is None and retry_after_seconds(None) is None
    assert retry_after_seconds("-3") == 0


def test_backoff_grows_caps_and_honors_retry_after():
    mid = lambda: 1.0                      # noqa: E731  (jitter factor 1.0)
    assert [backoff_delay(i, None, rand=mid) for i in range(4)] == [1, 2, 4, 8]
    assert backoff_delay(10, None, rand=mid) == 60
    assert backoff_delay(0, 20, rand=mid) == 20
    assert backoff_delay(0, None, rand=lambda: 0.0) == 0.5


class Opener:
    def __init__(self, responses):
        self.responses = list(responses)
        self.urls = []

    def __call__(self, url, timeout):
        self.urls.append(url)
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def fetcher(opener, tmp_path=None, **kw):
    c = Clock()
    return Fetcher(RateLimiter(100, clock=c, sleep=c.sleep), cache_dir=tmp_path, opener=opener, sleep=c.sleep,
                   rand=lambda: 1.0, **kw), c


def ok(body):
    return Response(200, {}, json.dumps(body).encode())


def test_retries_429_and_5xx_with_retry_after_then_succeeds():
    op = Opener([Response(429, {"retry-after": "5"}, b""), Response(503, {}, b""), OSError("reset"), ok([1])])
    f, c = fetcher(op)
    assert f.get_json("http://x/api") == [1]
    assert f.stats.network == 4 and f.stats.retries == 3
    assert c.sleeps[-3:] == [5, 2, 4]      # Retry-After 5 beats backoff 1; then 2, 4


def test_client_errors_are_not_retried():
    f, _ = fetcher(Opener([Response(404, {}, b"nope")]))
    with pytest.raises(FetchError) as e:
        f.get_json("http://x/api")
    assert e.value.status == 404 and f.stats.network == 1


def test_gives_up_after_retries():
    f, _ = fetcher(Opener([Response(500, {}, b"")] * 3), retries=2)
    with pytest.raises(FetchError):
        f.get_json("http://x/api")
    assert f.stats.network == 3


def test_cache_hit_avoids_network_and_survives_a_new_fetcher(tmp_path):
    op = Opener([ok({"v": 1})])
    f, _ = fetcher(op, tmp_path)
    assert f.get_json("http://x/a?h=1") == {"v": 1}
    f2, _ = fetcher(Opener([]), tmp_path)
    assert f2.get_json("http://x/a?h=1") == {"v": 1}
    assert f2.stats.cache_hits == 1 and f2.stats.network == 0


def test_uncacheable_and_store_if(tmp_path):
    f, _ = fetcher(Opener([ok(1), ok(2), ok(3), ok(4)]), tmp_path)
    assert f.get_json("http://x/tip", cacheable=False) == 1
    assert f.get_json("http://x/tip", cacheable=False) == 2
    assert f.get_json("http://x/p", store_if=lambda b: b > 5) == 3     # not stored
    assert f.get_json("http://x/p") == 4                              # stored now
    assert f.get_json("http://x/p") == 4 and f.stats.cache_hits == 1


def test_refresh_refetches(tmp_path):
    f, _ = fetcher(Opener([ok(1)]), tmp_path)
    f.get_json("http://x/a")
    f2, _ = fetcher(Opener([ok(2)]), tmp_path, refresh=True)
    assert f2.get_json("http://x/a") == 2


def test_torn_cache_file_is_refetched(tmp_path):
    f, _ = fetcher(Opener([ok(1), ok(1)]), tmp_path)
    f.get_json("http://x/a")
    [p] = tmp_path.glob("*.json")
    p.write_text("{")
    assert f.get_json("http://x/a") == 1 and f.stats.network == 2


def test_max_requests_guard_counts_retries():
    f, _ = fetcher(Opener([Response(500, {}, b""), ok(1)]), max_requests=1)
    with pytest.raises(MaxRequestsExceeded):
        f.get_json("http://x/a")
