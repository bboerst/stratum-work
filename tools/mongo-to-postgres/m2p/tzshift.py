"""Data-driven timezone safety net (design doc section 5).

There may have been a period when receive times were recorded in local time (MDT/MST, UTC-6/-7) and then stored
without an offset. A production scan found no such period, but the converter checks every height anyway:

For each height, take its naive-ISO templates. The height is corrected only if **both** independent clocks agree:
  * the pool's own header time: received - ntime sits at -S (±30 min) for at least 90% of the templates, and the
    median does too
  * our block data: the first template minus the header time of block h-1 sits at -S (±30 min)
for S = 6 h or 7 h. The correction is applied to that height's naive-ISO templates only, recorded per row in
`received_at_offset_s` (received_at = as-recorded - offset, so a -6 h shift is stored as offset -21600), and listed
in the report. Heights where only one signal points at a shift are listed as suspects and left alone.

There is never a blanket offset by height threshold or date.
"""
from __future__ import annotations

import statistics
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable, Optional

from .convert import FMT_ISO_NAIVE, Converted, TipIndex, epoch_us

SHIFTS_S = (6 * 3600, 7 * 3600)
TOLERANCE_S = 30 * 60
MIN_FRACTION = 0.9


@dataclass
class Finding:
    height: int
    offset_s: int                 # what to store in received_at_offset_s (negative: the clock was behind UTC)
    count: int                    # naive-ISO templates at the height (in this batch)
    median_vs_ntime_s: float
    first_vs_prev_block_s: Optional[float]
    fraction: float
    corrected: bool               # False = suspect, reported but not changed

    def as_dict(self) -> dict:
        return dict(height=self.height, offset_s=self.offset_s, count=self.count,
                    median_vs_ntime_s=round(self.median_vs_ntime_s, 1),
                    first_vs_prev_block_s=None if self.first_vs_prev_block_s is None else round(self.first_vs_prev_block_s, 1),
                    fraction=round(self.fraction, 4), corrected=self.corrected)


def _near(value: float, target: float) -> bool:
    return abs(value - target) <= TOLERANCE_S


def detect(rows: Iterable[Converted], tips: TipIndex) -> list[Finding]:
    by_height: dict[int, list[Converted]] = defaultdict(list)
    for c in rows:
        if c.fmt == FMT_ISO_NAIVE and c.height > 0:
            by_height[c.height].append(c)
    findings = []
    for h, group in sorted(by_height.items()):
        raw_s = [epoch_us(c.raw_received_at) / 1e6 for c in group]
        vs_ntime = [r - c.ntime for r, c in zip(raw_s, group)]
        median = statistics.median(vs_ntime)
        prev_t = tips.block_time.get(h - 1)
        vs_block = (min(raw_s) - prev_t) if prev_t is not None else None
        for shift in SHIFTS_S:
            if not _near(median, -shift):
                continue
            fraction = sum(1 for d in vs_ntime if _near(d, -shift)) / len(vs_ntime)
            consistent = fraction >= MIN_FRACTION and vs_block is not None and _near(vs_block, -shift)
            findings.append(Finding(h, -shift, len(group), median, vs_block, fraction, consistent))
            break
        else:
            # The block-time signal alone (e.g. a pool with a wrong ntime clock) never corrects, but is worth a look.
            if vs_block is not None and any(_near(vs_block, -s) for s in SHIFTS_S):
                s = next(s for s in SHIFTS_S if _near(vs_block, -s))
                fraction = sum(1 for d in vs_ntime if _near(d, -s)) / len(vs_ntime)
                findings.append(Finding(h, -s, len(group), median, vs_block, fraction, False))
    return findings


def apply(rows: Iterable[Converted], findings: list[Finding]) -> int:
    """Set offset_s on the naive-ISO rows of every corrected height. Returns the number of rows changed."""
    offsets = {f.height: f.offset_s for f in findings if f.corrected}
    n = 0
    if not offsets:
        return 0
    for c in rows:
        if c.fmt == FMT_ISO_NAIVE and c.height in offsets:
            c.set_offset(offsets[c.height])
            n += 1
    return n
