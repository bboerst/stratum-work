"""The public read routes of a stratum-work site (web/app/api/*), as used by the comparison.

  /api/blocks?n=1                        tip (newest block)
  /api/blocks?after=X&n=N                blocks X+1 … X+N, ascending (R5)
  /api/mining-notify?height=h            Bitcoin templates at h, hidden pools removed (R1)
  /api/block-pool-first-seen?height=h    each pool's first template at h, ordered by time (R4)
  /api/pools                             the mining-pools list (R7)
  /api/analysis-data?interesting=true    newest 200 blocks with analysis beyond pool identification (R3)

Responses for heights at or below the comparison's end height (both tips) don't change any more, so they are cached;
the tip, the pools list and R3 are always fetched fresh.
"""
from __future__ import annotations

from urllib.parse import urlencode, urlsplit

from .fetch import Fetcher


def normalize_base(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ValueError(f"base URL must be http(s)://host[:port][/prefix], got {url!r}")
    return url.rstrip("/")


class Site:
    def __init__(self, label: str, base: str, fetcher: Fetcher, page: int = 100):
        self.label, self.base, self.fetcher, self.page = label, normalize_base(base), fetcher, page

    def url(self, path: str, **params) -> str:
        return f"{self.base}{path}" + (f"?{urlencode(params)}" if params else "")

    def get(self, path: str, cacheable: bool, store_if=None, **params):
        return self.fetcher.get_json(self.url(path, **params), cacheable=cacheable, store_if=store_if)

    def tip(self) -> int | None:
        blocks = self.get("/api/blocks", False, n=1).get("blocks") or []
        return max((b["height"] for b in blocks), default=None)

    def lowest_block(self) -> int | None:
        blocks = self.get("/api/blocks", False, after=0, n=1).get("blocks") or []
        return min((b["height"] for b in blocks), default=None)

    def blocks(self, start: int, end: int, stable_until: int) -> dict[int, list[dict]]:
        """Blocks with start <= height <= end, as {height: [block, …]} (two at a height means a fork).
        A page is cached only if it is full and ends at or below stable_until (nothing can join it any more)."""
        out: dict[int, list[dict]] = {}
        after, n = start - 1, self.page

        def stable(body) -> bool:
            heights = [b["height"] for b in body.get("blocks") or []]
            return len(heights) >= n and max(heights) <= stable_until

        while after < end:
            got = self.get("/api/blocks", True, stable, after=after, n=n).get("blocks") or []
            for b in got:
                at = out.setdefault(b["height"], []) if start <= b["height"] <= end else None
                if at is not None and all(x.get("block_hash") != b.get("block_hash") for x in at):
                    at.append(b)
            if len(got) < n:
                break
            # Restart at the page's last height, not after it: a fork's second block there may be on the next page.
            top = max(b["height"] for b in got)
            if top - 1 <= after:
                break
            after = top - 1
        return out

    def templates(self, height: int, cacheable: bool) -> list[dict]:
        return self.get("/api/mining-notify", cacheable, height=height)

    def first_seen(self, height: int, cacheable: bool) -> list[dict]:
        return self.get("/api/block-pool-first-seen", cacheable, height=height)

    def pools(self) -> list[dict]:
        return self.get("/api/pools", False)

    def interesting(self) -> list[dict]:
        return self.get("/api/analysis-data", False, interesting="true").get("items") or []
