package main

import (
	"encoding/json"
	"sync"
	"time"
)

// Burst episodes (#105, part 2): a pool's job server sometimes sends templates far faster than normal (thousands
// in a second have been seen). That is a finding, not noise: every template is still stored as usual, and the
// episode is recorded in ingest_events so it can be analyzed (when, how long, how fast, how many distinct jobs).
//
// An episode starts at the first second with at least Threshold templates and ends when Gap passes without such a
// second. Seconds below the threshold inside the episode count towards it; the quiet tail after the last burst
// second doesn't. A long flood is written in segments of at most MaxSegment (detail.continued marks the later
// ones), so it is visible while it lasts and no row grows without bound.

// IngestEvent is one ingest_events row (without source_id, which the sink adds).
type IngestEvent struct {
	Kind      string // "burst" | "sink_overflow" | "start" | "session"
	Start     time.Time
	End       time.Time
	Templates int // burst: templates in the episode; sink_overflow: templates dropped; session: templates received
	Peak      int // burst: most templates in one second
	Detail    map[string]any
}

func (e IngestEvent) values(sourceID int16) []any {
	detail, _ := json.Marshal(e.Detail)
	return []any{sourceID, e.Kind, e.Start.UTC(), e.End.UTC(), int32(e.Templates), int32(e.Peak), detail}
}

var eventColumns = []string{"source_id", "kind", "started_at", "ended_at", "templates", "peak_per_second", "detail"}

type BurstConfig struct {
	Threshold  int           // templates in one second that make it a burst second; 0 disables detection
	Gap        time.Duration // an episode ends this long after its last burst second
	MaxSegment time.Duration // a longer episode is written in segments of this length
}

var defaultBurstConfig = BurstConfig{Threshold: 20, Gap: 5 * time.Second, MaxSegment: 10 * time.Minute}

const (
	maxDistinctTracked = 100_000 // per set and episode: bounds memory during an endless flood
	maxPerSecond       = 3600    // per-second counts kept per segment (MaxSegment / 1 s with the defaults)
)

// secStats aggregates one second (or the quiet tail after the last burst second).
type secStats struct {
	count, clean int
	jobs, prevs  map[string]struct{}
	firstJob     string
	lastJob      string
}

func newSecStats() secStats {
	return secStats{jobs: map[string]struct{}{}, prevs: map[string]struct{}{}}
}

func (s *secStats) add(job, prev string, clean bool) {
	if s.count == 0 {
		s.firstJob = job
	}
	s.count++
	s.lastJob = job
	if clean {
		s.clean++
	}
	addCapped(s.jobs, job)
	addCapped(s.prevs, prev)
}

func addCapped(m map[string]struct{}, k string) {
	if len(m) < maxDistinctTracked {
		m[k] = struct{}{}
	}
}

type episode struct {
	start, lastBurst time.Time // second starts
	stats            secStats
	peak             int
	perSecond        []int // counts from start, one per second, up to the last merged second
	segment          int
}

type BurstDetector struct {
	cfg      BurstConfig
	mu       sync.Mutex
	sec      time.Time // start of the second being counted (zero before the first template)
	cur      secStats
	tail     secStats // seconds after the episode's last burst second (merged if another burst second follows)
	tailSecs []int    // their per-second counts, contiguous from lastBurst+1s
	ep       *episode
}

func NewBurstDetector(cfg BurstConfig) *BurstDetector {
	return &BurstDetector{cfg: cfg, cur: newSecStats(), tail: newSecStats()}
}

// Observe counts one template (its receive time, job id, prev hash, clean_jobs) and returns finished events.
func (b *BurstDetector) Observe(tsNs int64, job, prev string, clean bool) []IngestEvent {
	if b == nil || b.cfg.Threshold <= 0 {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	sec := time.Unix(0, tsNs).UTC().Truncate(time.Second)
	var out []IngestEvent
	if !b.sec.IsZero() && sec.After(b.sec) {
		out = b.closeSecond(sec)
	} else if b.sec.IsZero() {
		b.sec = sec
	}
	// A receive time before the current second (clock step, kernel vs app clock) counts in the current one.
	b.cur.add(job, prev, clean)
	return out
}

// Flush closes the current second and the episode if time has moved on without templates (called periodically).
func (b *BurstDetector) Flush(now time.Time) []IngestEvent {
	if b == nil || b.cfg.Threshold <= 0 {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	sec := now.UTC().Truncate(time.Second)
	if b.sec.IsZero() || !sec.After(b.sec) {
		return nil
	}
	return b.closeSecond(sec)
}

// closeSecond finishes b.sec, accounts for the empty seconds up to next, and makes next the current second.
func (b *BurstDetector) closeSecond(next time.Time) []IngestEvent {
	var out []IngestEvent
	done := b.cur
	doneSec := b.sec
	b.cur, b.sec = newSecStats(), next
	if done.count >= b.cfg.Threshold {
		if b.ep == nil {
			b.ep = &episode{start: doneSec, stats: newSecStats()}
		} else {
			b.mergeTail()
		}
		b.merge(done, doneSec)
		b.ep.lastBurst = doneSec
		if done.count > b.ep.peak {
			b.ep.peak = done.count
		}
		if doneSec.Sub(b.ep.start) >= b.cfg.MaxSegment-time.Second {
			out = append(out, b.finish(true))
		}
	} else if b.ep != nil {
		b.tail.addAll(done)
		b.tailSecs = append(b.tailSecs, done.count)
	}
	// Seconds without any template between doneSec and next.
	if b.ep != nil {
		for s := doneSec.Add(time.Second); s.Before(next) && len(b.tailSecs) < maxPerSecond; s = s.Add(time.Second) {
			b.tailSecs = append(b.tailSecs, 0)
		}
		if next.Sub(b.ep.lastBurst) > b.cfg.Gap {
			if b.ep.stats.count == 0 { // a segment that just started and never got a burst second
				b.ep, b.tail, b.tailSecs = nil, newSecStats(), nil
			} else {
				out = append(out, b.finish(false))
			}
		}
	}
	return out
}

func (s *secStats) addAll(o secStats) {
	if o.count == 0 {
		return
	}
	if s.count == 0 {
		s.firstJob = o.firstJob
	}
	s.count += o.count
	s.clean += o.clean
	s.lastJob = o.lastJob
	for k := range o.jobs {
		addCapped(s.jobs, k)
	}
	for k := range o.prevs {
		addCapped(s.prevs, k)
	}
}

func (b *BurstDetector) mergeTail() {
	b.ep.stats.addAll(b.tail)
	for _, n := range b.tailSecs {
		if len(b.ep.perSecond) < maxPerSecond {
			b.ep.perSecond = append(b.ep.perSecond, n)
		}
	}
	b.tail, b.tailSecs = newSecStats(), nil
}

func (b *BurstDetector) merge(s secStats, sec time.Time) {
	b.ep.stats.addAll(s)
	if len(b.ep.perSecond) < maxPerSecond {
		b.ep.perSecond = append(b.ep.perSecond, s.count)
	}
}

// finish emits the episode (trimmed to its last burst second). continued: the flood goes on in a new segment.
func (b *BurstDetector) finish(continued bool) IngestEvent {
	ep := b.ep
	st := ep.stats
	ev := IngestEvent{Kind: "burst", Start: ep.start, End: ep.lastBurst.Add(time.Second), Templates: st.count, Peak: ep.peak,
		Detail: map[string]any{
			"threshold_per_second": b.cfg.Threshold,
			"distinct_job_ids":     len(st.jobs),
			"distinct_prev_hashes": len(st.prevs),
			"distinct_capped":      len(st.jobs) >= maxDistinctTracked || len(st.prevs) >= maxDistinctTracked,
			"clean_jobs":           st.clean,
			"first_job_id":         truncate(st.firstJob, 128),
			"last_job_id":          truncate(st.lastJob, 128),
			"per_second":           ep.perSecond,
			"segment":              ep.segment,
		}}
	if continued {
		b.ep = &episode{start: ep.lastBurst.Add(time.Second), lastBurst: ep.lastBurst, stats: newSecStats(),
			segment: ep.segment + 1}
		ev.Detail["continued"] = true
	} else {
		b.ep = nil
	}
	b.tail, b.tailSecs = newSecStats(), nil
	return ev
}
