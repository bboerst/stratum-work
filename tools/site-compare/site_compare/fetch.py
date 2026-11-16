"""Gentle HTTP for public sites: one rate limiter for all requests, retries with backoff (honoring Retry-After), an
on-disk response cache so reruns don't refetch, and a hard cap on network requests. Standard library only."""
from __future__ import annotations

import email.utils
import hashlib
import json
import os
import random
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

USER_AGENT = "stratum-work-site-compare/1 (read-only parity check)"
RETRY_STATUSES = {429, 500, 502, 503, 504}


class MaxRequestsExceeded(RuntimeError):
    """The --max-requests guard tripped. Everything fetched so far is in the cache, so a rerun resumes."""


class FetchError(RuntimeError):
    def __init__(self, url: str, status: int | None, message: str):
        super().__init__(f"{url}: {message}")
        self.url, self.status = url, status


class RateLimiter:
    """Token bucket: at most `rate` requests per second on average, at most `burst` at once."""

    def __init__(self, rate: float, burst: int = 1, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        if rate <= 0 or burst < 1:
            raise ValueError("rate must be > 0 and burst >= 1")
        self.rate, self.burst, self.clock, self.sleep = rate, burst, clock, sleep
        self.tokens = float(burst)
        self.last = clock()
        self.lock = threading.Lock()

    def acquire(self) -> float:
        """Take a token, sleeping until one is available. Returns the time slept."""
        with self.lock:
            now = self.clock()
            self.tokens = min(self.burst, self.tokens + (now - self.last) * self.rate)
            self.last = now
            if self.tokens >= 1:
                self.tokens -= 1
                return 0.0
            # Sleep until the next token accrues and spend it right away (no re-check: float rounding could
            # otherwise leave the bucket a hair short forever). Oversleeping only makes it gentler.
            wait = (1 - self.tokens) / self.rate
            self.sleep(wait)
            self.tokens = 0.0
            self.last = max(self.clock(), now + wait)
            return wait


def retry_after_seconds(value: str | None, now: datetime | None = None) -> float | None:
    """Retry-After as seconds: delta-seconds or an HTTP date. None if absent or unparseable."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - (now or datetime.now(timezone.utc))).total_seconds())


def backoff_delay(attempt: int, retry_after: float | None, base: float = 1.0, cap: float = 60.0,
                  rand: Callable[[], float] = random.random) -> float:
    """Exponential backoff with jitter (attempt 0 → ~base), never shorter than the server's Retry-After."""
    exp = min(cap, base * (2 ** attempt)) * (0.5 + rand() / 2)
    return max(exp, retry_after or 0.0)


@dataclass
class Response:
    status: int
    headers: dict
    body: bytes


def urllib_opener(url: str, timeout: float) -> Response:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return Response(r.status, {k.lower(): v for k, v in r.headers.items()}, r.read())
    except urllib.error.HTTPError as e:
        return Response(e.code, {k.lower(): v for k, v in (e.headers or {}).items()}, e.read() or b"")


@dataclass
class Stats:
    network: int = 0          # requests sent, retries included
    cache_hits: int = 0
    retries: int = 0
    bytes: int = 0
    waited_s: float = 0.0     # time spent in the rate limiter and backoff
    by_route: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {"network_requests": self.network, "cache_hits": self.cache_hits, "retries": self.retries,
                "bytes": self.bytes, "waited_s": round(self.waited_s, 1), "by_route": dict(sorted(self.by_route.items()))}


class Fetcher:
    """GET JSON. `cacheable` responses (200 only) are kept under cache_dir, keyed by the URL's SHA-256."""

    def __init__(self, limiter: RateLimiter, cache_dir: str | os.PathLike | None = None, max_requests: int = 2000,
                 retries: int = 6, timeout: float = 60.0, opener: Callable[[str, float], Response] = urllib_opener,
                 sleep: Callable[[float], None] = time.sleep, rand: Callable[[], float] = random.random,
                 refresh: bool = False):
        self.limiter, self.max_requests, self.retries, self.timeout = limiter, max_requests, retries, timeout
        self.opener, self.sleep, self.rand, self.refresh = opener, sleep, rand, refresh
        self.cache_dir = Path(cache_dir) if cache_dir else None
        if self.cache_dir:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.stats = Stats()

    def _cache_path(self, url: str) -> Path | None:
        if not self.cache_dir:
            return None
        return self.cache_dir / f"{hashlib.sha256(url.encode()).hexdigest()[:40]}.json"

    def get_json(self, url: str, cacheable: bool = True, store_if: Callable[[object], bool] | None = None):
        """store_if: cache a fresh response only if this returns true for it (default: always, when cacheable)."""
        path = self._cache_path(url) if cacheable else None
        if path and path.exists() and not self.refresh:
            try:
                body = json.loads(path.read_bytes())
                self.stats.cache_hits += 1
                return body
            except ValueError:
                path.unlink(missing_ok=True)   # a torn write: fetch again
        raw = self._get(url)
        try:
            body = json.loads(raw)
        except ValueError as e:
            raise FetchError(url, 200, f"not JSON ({e})") from None
        if path and (store_if is None or store_if(body)):
            tmp = path.with_suffix(f".tmp{os.getpid()}")
            tmp.write_bytes(raw)
            os.replace(tmp, path)
        return body

    def _get(self, url: str) -> bytes:
        route = url.split("://", 1)[-1].split("/", 1)[-1].split("?", 1)[0]
        last = "no attempt"
        for attempt in range(self.retries + 1):
            if self.stats.network >= self.max_requests:
                raise MaxRequestsExceeded(f"--max-requests {self.max_requests} reached (rerun with the same --cache "
                                          f"to resume)")
            self.stats.waited_s += self.limiter.acquire()
            self.stats.network += 1
            self.stats.by_route[route] = self.stats.by_route.get(route, 0) + 1
            if attempt:
                self.stats.retries += 1
            retry_after = None
            try:
                r = self.opener(url, self.timeout)
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
                last = f"network error: {e}"
            else:
                self.stats.bytes += len(r.body)
                if r.status == 200:
                    return r.body
                if r.status not in RETRY_STATUSES:
                    raise FetchError(url, r.status, f"HTTP {r.status}: {r.body[:200]!r}")
                last = f"HTTP {r.status}"
                retry_after = retry_after_seconds(r.headers.get("retry-after"))
            if attempt < self.retries:
                delay = backoff_delay(attempt, retry_after, rand=self.rand)
                self.stats.waited_s += delay
                self.sleep(delay)
        raise FetchError(url, None, f"gave up after {self.retries + 1} attempts ({last})")
