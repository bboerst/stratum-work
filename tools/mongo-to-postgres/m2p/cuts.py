"""Per-(day, source) cut-offs: how much of a UTC day each source has been (or is to be) loaded.

A day's cut is a default (`--until`, or the live-day cut behind now) plus optional per-source overrides
(`--pool-until NAME=INSTANT`). Every value is an exclusive bound on the receive time *as recorded*, normalized to the
day: `None` is the whole day, an instant at or before the day's start means nothing of it. The tool records the cut
it loaded with each day (`days.until` and `days.pool_until`), and coverage only ever grows: a run that asks for less
than what is recorded keeps what is there.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Optional

UTC = timezone.utc


def source_name(doc: dict) -> str:
    """The source a document belongs to: `pool_name` exactly as stored (the same key as `sources.name`)."""
    v = doc.get("pool_name")
    return v if isinstance(v, str) else str(v or "")


def bounds(d: date) -> tuple[datetime, datetime]:
    start = datetime(d.year, d.month, d.day, tzinfo=UTC)
    return start, start + timedelta(days=1)


def norm(d: date, until: Optional[datetime]) -> Optional[datetime]:
    """An exclusive cut, clamped to day d: None for the whole day, the day's start for none of it."""
    start, end = bounds(d)
    if until is None or until >= end:
        return None
    return max(until, start)


def end_of(d: date, until: Optional[datetime]) -> datetime:
    """Where coverage of day d ends under a cut (comparable: later = more)."""
    start, end = bounds(d)
    return end if until is None else min(max(until, start), end)


@dataclass(frozen=True)
class Cuts:
    day: date
    default: Optional[datetime]                       # sources without an override
    per_source: dict = field(default_factory=dict)    # name -> Optional[datetime], only where != default

    @classmethod
    def make(cls, d: date, default: Optional[datetime], per_source: Optional[dict] = None) -> "Cuts":
        dflt = norm(d, default)
        per = {}
        for name, u in (per_source or {}).items():
            u = norm(d, u)
            if end_of(d, u) != end_of(d, dflt):
                per[name] = u
        return cls(d, dflt, per)

    @classmethod
    def empty(cls, d: date) -> "Cuts":
        return cls(d, bounds(d)[0], {})

    def at(self, source: str) -> Optional[datetime]:
        return self.per_source.get(source, self.default)

    def end(self, source: Optional[str] = None) -> datetime:
        return end_of(self.day, self.default if source is None else self.at(source))

    def any_coverage(self) -> bool:
        start = bounds(self.day)[0]
        return self.end() > start or any(end_of(self.day, u) > start for u in self.per_source.values())

    def query_until(self) -> Optional[datetime]:
        """One bound that selects every document any source needs (per-source cuts are applied per document)."""
        ends = [self.end()] + [end_of(self.day, u) for u in self.per_source.values()]
        return norm(self.day, max(ends))

    def admits(self, source: str, raw: datetime) -> bool:
        u = self.at(source)
        return u is None or raw < u

    def merge(self, other: "Cuts") -> "Cuts":
        """Per source, the larger coverage of the two (coverage never shrinks)."""
        names = set(self.per_source) | set(other.per_source)
        later = lambda a, b: a if end_of(self.day, a) >= end_of(self.day, b) else b
        return Cuts.make(self.day, later(self.default, other.default),
                         {n: later(self.at(n), other.at(n)) for n in names})

    def same_coverage(self, other: "Cuts") -> bool:
        names = set(self.per_source) | set(other.per_source)
        return self.end() == other.end() and all(self.end(n) == other.end(n) for n in names)

    def grown(self, before: "Cuts") -> tuple[bool, set]:
        """(default grew?, sources whose own cut grew) going from `before` to self."""
        names = set(self.per_source) | set(before.per_source)
        return self.end() > before.end(), {n for n in names if self.end(n) > before.end(n)}

    # ── bookkeeping (days.until, days.pool_until) ─────────────────────────────────────────────────────────
    def pool_until_json(self) -> dict:
        return {n: None if u is None else u.isoformat() for n, u in sorted(self.per_source.items())}

    @classmethod
    def from_record(cls, d: date, until: Optional[datetime], pool_until: Optional[dict]) -> "Cuts":
        return cls.make(d, until, {n: None if v is None else datetime.fromisoformat(v)
                                   for n, v in (pool_until or {}).items()})

    def describe(self) -> str:
        parts = [] if self.default is None else [f"until {self.default.isoformat()}"]
        parts += [f"{n} {'whole day' if u is None else 'until ' + u.isoformat()}" for n, u in sorted(self.per_source.items())]
        return ", ".join(parts)


def instant(s: str) -> datetime:
    dt = datetime.fromisoformat(s)
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)
