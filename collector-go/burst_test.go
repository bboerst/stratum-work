package main

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)

// feed sends n templates spread over second s (relative to t0), with job ids job-<s>-<i>.
func feed(b *BurstDetector, s, n int, prev string) []IngestEvent {
	var out []IngestEvent
	for i := 0; i < n; i++ {
		ts := t0.Add(time.Duration(s)*time.Second + time.Duration(i)*time.Second/time.Duration(n+1))
		out = append(out, b.Observe(ts.UnixNano(), fmt.Sprintf("job-%d-%d", s, i), prev, i == 0)...)
	}
	return out
}

func testDetector() *BurstDetector {
	return NewBurstDetector(BurstConfig{Threshold: 20, Gap: 5 * time.Second, MaxSegment: 10 * time.Minute})
}

func TestNormalTrafficIsNoBurst(t *testing.T) {
	b := testDetector()
	var evs []IngestEvent
	for s := 0; s < 120; s += 3 { // a template every few seconds, 19 at once at a "block"
		n := 1
		if s == 60 {
			n = 19
		}
		evs = append(evs, feed(b, s, n, "p")...)
	}
	evs = append(evs, b.Flush(t0.Add(10*time.Minute))...)
	if len(evs) != 0 {
		t.Errorf("events %+v", evs)
	}
}

func TestOneBurstSecond(t *testing.T) {
	b := testDetector()
	evs := feed(b, 0, 3000, "p")
	evs = append(evs, feed(b, 1, 1, "p")...) // the quiet tail is not part of the episode
	evs = append(evs, b.Flush(t0.Add(7*time.Second))...)
	if len(evs) != 1 {
		t.Fatalf("events %+v", evs)
	}
	e := evs[0]
	if e.Kind != "burst" || e.Templates != 3000 || e.Peak != 3000 || !e.Start.Equal(t0) || !e.End.Equal(t0.Add(time.Second)) {
		t.Errorf("event %+v", e)
	}
	d := e.Detail
	if d["distinct_job_ids"] != 3000 || d["distinct_prev_hashes"] != 1 || d["clean_jobs"] != 1 || d["first_job_id"] != "job-0-0" ||
		d["last_job_id"] != "job-0-2999" || fmt.Sprint(d["per_second"]) != "[3000]" || d["threshold_per_second"] != 20 {
		t.Errorf("detail %v", d)
	}
}

func TestQuietSecondsInsideAnEpisodeCountTheGapEndsIt(t *testing.T) {
	b := testDetector()
	var evs []IngestEvent
	evs = append(evs, feed(b, 0, 30, "a")...)
	evs = append(evs, feed(b, 1, 2, "a")...) // below the threshold, but inside the episode
	evs = append(evs, feed(b, 3, 40, "b")...)
	evs = append(evs, feed(b, 4, 1, "b")...)   // tail: excluded
	evs = append(evs, feed(b, 10, 25, "c")...) // 7 s after the last burst second (> 5 s gap): a new episode
	evs = append(evs, b.Flush(t0.Add(20*time.Second))...)
	if len(evs) != 2 {
		t.Fatalf("events %+v", evs)
	}
	a, c := evs[0], evs[1]
	if a.Templates != 72 || a.Peak != 40 || fmt.Sprint(a.Detail["per_second"]) != "[30 2 0 40]" || !a.End.Equal(t0.Add(4*time.Second)) ||
		a.Detail["distinct_prev_hashes"] != 2 {
		t.Errorf("first %+v", a)
	}
	if c.Templates != 25 || !c.Start.Equal(t0.Add(10*time.Second)) {
		t.Errorf("second %+v", c)
	}
}

func TestLongFloodIsWrittenInSegments(t *testing.T) {
	b := testDetector()
	var evs []IngestEvent
	for s := 0; s < 1300; s++ {
		evs = append(evs, feed(b, s, 25, "p")...)
	}
	if len(evs) != 2 { // visible while it lasts: segments at 10 and 20 minutes
		t.Fatalf("during the flood: %d events", len(evs))
	}
	evs = append(evs, b.Flush(t0.Add(1400*time.Second))...)
	if len(evs) != 3 {
		t.Fatalf("events %d", len(evs))
	}
	total := 0
	for i, e := range evs {
		total += e.Templates
		cont := e.Detail["continued"] == true
		if (i < 2) != cont || e.Detail["segment"] != i {
			t.Errorf("segment %d: continued=%v detail %v", i, cont, e.Detail["segment"])
		}
		if i > 0 && !e.Start.Equal(evs[i-1].End) {
			t.Errorf("segment %d starts %v, previous ended %v", i, e.Start, evs[i-1].End)
		}
	}
	if total != 1300*25 || evs[0].Templates != 600*25 || len(evs[0].Detail["per_second"].([]int)) != 600 {
		t.Errorf("total %d first %d", total, evs[0].Templates)
	}
}

func TestFlushClosesAnEpisodeWhenThePoolGoesQuiet(t *testing.T) {
	b := testDetector()
	if evs := feed(b, 0, 50, "p"); len(evs) != 0 {
		t.Fatal(evs)
	}
	if evs := b.Flush(t0.Add(3 * time.Second)); len(evs) != 0 { // within the gap
		t.Fatal(evs)
	}
	if evs := b.Flush(t0.Add(6*time.Second + time.Millisecond)); len(evs) != 1 || evs[0].Templates != 50 {
		t.Fatalf("%+v", evs)
	}
}

func TestDisabledDetectorAndNilAreNoOps(t *testing.T) {
	var nilDet *BurstDetector
	off := NewBurstDetector(BurstConfig{Threshold: 0})
	for _, b := range []*BurstDetector{nilDet, off} {
		if evs := append(feed(b, 0, 5000, "p"), b.Flush(t0.Add(time.Minute))...); len(evs) != 0 {
			t.Errorf("events %v", evs)
		}
	}
}

func TestDistinctSetsAreBounded(t *testing.T) {
	b := testDetector()
	feed(b, 0, maxDistinctTracked+500, "p")
	evs := b.Flush(t0.Add(10 * time.Second))
	if len(evs) != 1 || evs[0].Detail["distinct_job_ids"] != maxDistinctTracked || evs[0].Detail["distinct_capped"] != true ||
		evs[0].Templates != maxDistinctTracked+500 {
		t.Errorf("%+v", evs[0].Detail)
	}
}

func TestEventRowShape(t *testing.T) {
	e := IngestEvent{Kind: "burst", Start: t0, End: t0.Add(time.Second), Templates: 3, Peak: 3,
		Detail: map[string]any{"per_second": []int{3}}}
	v := e.values(7)
	if len(v) != len(eventColumns) || v[0] != int16(7) || v[4] != int32(3) || string(v[6].([]byte)) != `{"per_second":[3]}` {
		t.Errorf("%v", v)
	}
}

// ── sink ────────────────────────────────────────────────────────────────────────────────────────────────────────

func TestEventsAreWrittenAndNeverBlockTemplates(t *testing.T) {
	db := &fakeDB{failEvents: true}
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return db, nil }).Start()
	s.SubmitEvent(IngestEvent{Kind: "burst", Start: t0, End: t0, Templates: 1})
	s.Submit(testDoc(nil))
	if !waitFor(func() bool { return db.count("templates") == 1 }, 3*time.Second) {
		t.Fatal("templates blocked")
	}
	db.mu.Lock()
	db.failEvents = false
	db.mu.Unlock()
	s.SubmitEvent(IngestEvent{Kind: "burst", Start: t0, End: t0, Templates: 2})
	if !waitFor(func() bool { return db.count("ingest_events") == 1 }, 3*time.Second) {
		t.Fatal("event not written")
	}
	s.Close(time.Second)
	if st := s.Stats(); st["events_db_errors"] != 1 || st["events_written"] != 1 || st["db_errors"] != 0 {
		t.Errorf("stats %v", st)
	}
}

func TestQueueOverflowIsRecordedAsAnEvent(t *testing.T) {
	db := &fakeDB{}
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return db, nil })
	s.maxQueue = 3
	for i := 0; i < 10; i++ { // not started yet: 7 dropped
		s.Submit(testDoc(nil))
	}
	s.Start()
	s.Close(2 * time.Second) // Close flushes the overflow event
	if !waitFor(func() bool { return db.count("ingest_events") == 1 }, 3*time.Second) {
		t.Fatalf("events %d stats %v", db.count("ingest_events"), s.Stats())
	}
	db.mu.Lock()
	row := db.rows["ingest_events"][0]
	db.mu.Unlock()
	if row[1] != "sink_overflow" || row[4] != int32(7) || !strings.Contains(string(row[6].([]byte)), `"max_queue":3`) {
		t.Errorf("row %v", row)
	}
}

// ── end to end ──────────────────────────────────────────────────────────────────────────────────────────────────

func TestBurstFromAPoolIsRecordedAndEveryTemplateCollected(t *testing.T) {
	pool := newFakePool(t)
	c, docs, m, cancel := testCollector(t, poolURL(pool), nil)
	c.Bursts = NewBurstDetector(BurstConfig{Threshold: 20, Gap: 5 * time.Second, MaxSegment: 10 * time.Minute})
	got := make(chan IngestEvent, 4)
	c.Event = func(e IngestEvent) { got <- e }
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	defer cancel()
	go c.Run(ctx)
	f := pool.accept(t)
	f.handshake(t)
	var flood strings.Builder
	for i := 0; i < 90; i++ { // one write: arrives within a second or two
		flood.WriteString(notifyLine(fmt.Sprintf("f%d", i)))
	}
	f.send(t, flood.String())
	for i := 0; i < 90; i++ {
		if d := nextDoc(t, docs); d.Params[pJobID].s != fmt.Sprintf("f%d", i) {
			t.Fatalf("template %d: %s", i, d.Params[pJobID].s)
		}
	}
	for _, e := range c.Bursts.Flush(time.Now().Add(10 * time.Second)) {
		c.event(e)
	}
	select {
	case e := <-got:
		if e.Kind != "burst" || e.Templates < 20 || e.Templates > 90 || e.Peak < 20 || m.Bursts.Load() != 1 {
			t.Errorf("event %+v bursts %d", e, m.Bursts.Load())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no burst event")
	}
}
