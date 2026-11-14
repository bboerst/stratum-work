package main

import (
	"crypto/sha256"
	"time"
)

// Quarantine (#105): what a pool sends that can't be stored as a template goes to templates_rejected instead of
// being dropped, so broken or hostile input stays available for triage. A Rejection is one such message:
//   - "line":   no newline within the line cap (the session reconnects);
//   - "json":   undecodable, or over a decoding limit (pyLimits);
//   - "notify": a mining.notify without the 9 params it needs;
//   - "row":    a mining.notify that can't be stored losslessly (non-hex fields, out-of-range values, ...).
//
// Odd but storable templates (implausible heights, other chains, unusual coinbases) are NOT rejections: they're
// stored as usual. Only what can't be stored losslessly, or can't be decoded safely, ends up here.
type Rejection struct {
	TsNs   int64
	Stage  string
	Reason string
	Raw    []byte
}

// rejectRow is one templates_rejected row (without source_id, which the sink adds).
type rejectRow struct {
	ReceivedAt time.Time
	Stage      string
	Reason     string
	RawLength  int
	RawSHA256  []byte
	Raw        []byte
	Truncated  bool
	Suppressed int
}

func (r rejectRow) values(sourceID int16) []any {
	var sum, raw any
	if r.RawSHA256 != nil {
		sum = r.RawSHA256
	}
	if r.Raw != nil {
		raw = r.Raw
	}
	return []any{r.ReceivedAt, sourceID, r.Stage, r.Reason, int32(r.RawLength), sum, raw, r.Truncated, int32(r.Suppressed)}
}

var rejectColumns = []string{"received_at", "source_id", "stage", "reason", "raw_length", "raw_sha256", "raw",
	"raw_truncated", "suppressed"}

// QuarantineBudget bounds what one source can write, so a pool that floods garbage (or targets this collector on
// purpose) can't fill the database: per window, the first FullRows rejections keep up to MaxRaw bytes of the
// message, the next MetaRows keep its length, SHA-256 and a MetaPrefix-byte prefix, and the rest are only counted.
// Worst case per source and hour with the defaults: 20 x 256 KiB + 2,000 small rows, about 6 MB.
type QuarantineBudget struct {
	Window     time.Duration
	FullRows   int
	MaxRaw     int
	MetaRows   int
	MetaPrefix int
}

var defaultQuarantineBudget = QuarantineBudget{Window: time.Hour, FullRows: 20, MaxRaw: 256 << 10, MetaRows: 2000,
	MetaPrefix: 256}

const maxReasonLen = 200

type quarantine struct {
	b           QuarantineBudget
	windowStart time.Time
	full, meta  int
	suppressed  int
}

// admit returns the rows to store for r: a summary of the previous window if it suppressed anything, then r's
// own row unless the budget is spent. The first suppressed rejection of a window also gets a marker row, so a
// flood is visible right away (its count follows at the window's end).
func (q *quarantine) admit(r Rejection, now time.Time) (rows []rejectRow, suppressed bool) {
	rows = q.expire(now)
	if q.windowStart.IsZero() {
		q.windowStart = now
	}
	sum := sha256.Sum256(r.Raw)
	row := rejectRow{ReceivedAt: time.Unix(0, r.TsNs).UTC(), Stage: r.Stage, Reason: truncate(r.Reason, maxReasonLen),
		RawLength: len(r.Raw), RawSHA256: sum[:]}
	switch {
	case q.full < q.b.FullRows:
		q.full++
		row.Raw, row.Truncated = clip(r.Raw, q.b.MaxRaw)
	case q.meta < q.b.MetaRows:
		q.meta++
		row.Raw, row.Truncated = clip(r.Raw, q.b.MetaPrefix)
	default:
		if q.suppressed == 0 {
			rows = append(rows, rejectRow{ReceivedAt: now.UTC(), Stage: "suppressed",
				Reason: "quarantine budget spent for this window; further rejections are counted only"})
		}
		q.suppressed++
		return rows, true
	}
	return append(rows, row), false
}

// expire closes the window if it's over, returning its summary row (if it suppressed anything).
func (q *quarantine) expire(now time.Time) []rejectRow {
	if q.windowStart.IsZero() || now.Sub(q.windowStart) < q.b.Window {
		return nil
	}
	var rows []rejectRow
	if q.suppressed > 0 {
		end := q.windowStart.Add(q.b.Window)
		rows = append(rows, rejectRow{ReceivedAt: end.UTC(), Stage: "suppressed", Reason: "rejections counted, not stored",
			Suppressed: q.suppressed})
	}
	q.windowStart, q.full, q.meta, q.suppressed = time.Time{}, 0, 0, 0
	return rows
}

func clip(b []byte, n int) ([]byte, bool) {
	if len(b) <= n {
		return append([]byte{}, b...), false
	}
	return append([]byte{}, b[:n]...), true
}
