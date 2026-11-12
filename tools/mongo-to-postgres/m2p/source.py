"""Reading the restored MongoDB, one UTC day at a time.

`mining_notify.timestamp` comes in three shapes (see convert.parse_timestamp), and a day's documents are selected by
string/date *ranges*, so a `timestamp` index (created on the throwaway restore with `migrate --create-index`) makes
each day an index range scan. Without the index every day is a collection scan: correct, just slow.

Every document belongs to exactly one day, its UTC day as recorded (before any timezone correction):
  * hex ns       [hex(D), hex(D+1))                                  exact
  * naive ISO    ["D", "D+1")  (date prefix)                         exact
  * ISO with an offset: its UTC day can differ from its date prefix by one, so day D also reads offset-suffixed
    strings with prefix D-1 and D+1, and every candidate is kept only if its parsed UTC day is D
  * BSON dates   [D, D+1)                                            exact
The two string ranges can't overlap: hex ns starts with "1" until 2042, ISO strings with "2".
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Iterator, Optional

from pymongo import ASCENDING, DESCENDING, MongoClient

from .convert import ISO_PREFIX, Reject, day_start, hex_ns, parse_timestamp, utc_day

LOG = logging.getLogger("m2p.source")
TZ_SUFFIX_RE = r"(Z|[+-][0-9]{2}:?[0-9]{2})$"
HEX_RE = r"^[0-9a-f]{16}$"
ISO_RE = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}"


class Source:
    def __init__(self, uri: str, db: str, batch_size: int = 5000):
        # The URI may carry credentials: it is never logged (see describe()).
        self._client = MongoClient(uri, tz_aware=False, appname="stratum-work-mongo-to-postgres",
                                   readPreference="secondaryPreferred")
        self.db = self._client[db]
        self.batch_size = batch_size

    def describe(self) -> str:
        nodes = ", ".join(f"{h}:{p}" for h, p in self._client.topology_description.server_descriptions())
        return f"mongodb {nodes or '(not connected yet)'} db={self.db.name}"

    def close(self):
        self._client.close()

    # ── setup ───────────────────────────────────────────────────────────────────────────────────────────
    def has_timestamp_index(self) -> bool:
        return any(list(ix["key"].keys())[:1] == ["timestamp"] for ix in self.db.mining_notify.list_indexes())

    def create_timestamp_index(self) -> None:
        """Only for the throwaway restore. Never run against a live database."""
        self.db.mining_notify.create_index([("timestamp", ASCENDING)], name="m2p_timestamp")

    def day_range(self) -> Optional[tuple[date, date]]:
        """First and last UTC day with documents. Index range bounds, not regexes, so each end is a short index walk:
        hex ns strings start with "1" (2004-2042) and ISO strings with "2"; BSON dates sort apart from strings."""
        coll, days = self.db.mining_notify, []
        for flt in ({"timestamp": {"$gte": "0", "$lt": "2"}}, {"timestamp": {"$gte": "2", "$lt": "3"}},
                    {"timestamp": {"$gte": datetime(1970, 1, 1), "$lt": datetime(9999, 1, 1)}}):
            for direction in (ASCENDING, DESCENDING):
                for doc in coll.find(flt, {"timestamp": 1}).sort("timestamp", direction).limit(1000):
                    try:
                        days.append(utc_day(parse_timestamp(doc["timestamp"])[0]))
                        break
                    except Reject:
                        continue   # an odd string at the edge: coverage reports it; keep looking
        if not days:
            return None
        # ISO strings with an offset can sit one day either side of their prefix.
        return min(days) - timedelta(days=1), max(days) + timedelta(days=1)

    # ── reading a day ───────────────────────────────────────────────────────────────────────────────────
    @staticmethod
    def day_query(d: date, until: Optional[datetime] = None) -> dict:
        start, end = day_start(d), day_start(d + timedelta(days=1))
        if until is not None and until < end:
            end = until
        prev, nxt, after = (d - timedelta(days=1)).isoformat(), (d + timedelta(days=1)).isoformat(), \
            (d + timedelta(days=2)).isoformat()
        return {"$or": [
            {"timestamp": {"$gte": hex_ns(start), "$lt": hex_ns(end)}},
            {"timestamp": {"$gte": d.isoformat(), "$lt": nxt}},
            {"timestamp": {"$gte": prev, "$lt": d.isoformat(), "$regex": TZ_SUFFIX_RE}},
            {"timestamp": {"$gte": nxt, "$lt": after, "$regex": TZ_SUFFIX_RE}},
            {"timestamp": {"$gte": start.replace(tzinfo=None), "$lt": end.replace(tzinfo=None)}},
        ]}

    def iter_day(self, d: date, until: Optional[datetime] = None, projection: Optional[dict] = None) -> Iterator[dict]:
        """Documents whose recorded UTC day is d (and recorded time < until, if given).

        Documents whose timestamp can't be parsed never match a day; verify's coverage check finds them."""
        cur = self.db.mining_notify.find(self.day_query(d, until), projection, batch_size=self.batch_size)
        for doc in cur:
            try:
                raw, _ = parse_timestamp(doc.get("timestamp"))
            except Reject:
                # An ISO-looking string that doesn't parse belongs to the day of its date prefix: hand it to the
                # caller, whose conversion rejects (and records) it, so it is counted rather than skipped.
                ts = doc.get("timestamp")
                if isinstance(ts, str) and ISO_PREFIX.match(ts) and ts[:10] == d.isoformat():
                    yield doc
                continue
            if utc_day(raw) != d or (until is not None and raw >= until):
                continue
            yield doc

    # ── other collections ───────────────────────────────────────────────────────────────────────────────
    def blocks(self) -> list[dict]:
        return list(self.db.blocks.find({}).sort("_id", ASCENDING))

    def pools(self) -> list[dict]:
        return [{k: v for k, v in p.items() if k != "_id"} for p in self.db.pools.find({}).sort("_id", ASCENDING)]

    def count_all(self) -> int:
        return self.db.mining_notify.estimated_document_count()

    def count_exact(self) -> int:
        return self.db.mining_notify.count_documents({})

    def unrecognized_timestamps(self, limit: int = 20) -> tuple[int, list]:
        """Documents no day query can select: timestamps that are neither hex ns, ISO nor a BSON date."""
        flt = {"$nor": [{"timestamp": {"$regex": HEX_RE}}, {"timestamp": {"$regex": ISO_RE}},
                        {"timestamp": {"$type": "date"}}]}
        n = self.db.mining_notify.count_documents(flt)
        sample = [{"_id": str(d["_id"]), "timestamp": repr(d.get("timestamp"))[:60]}
                  for d in self.db.mining_notify.find(flt, {"timestamp": 1}).limit(limit)] if n else []
        return n, sample
