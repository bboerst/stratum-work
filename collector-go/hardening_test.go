package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// Ingest hardening (#105): third-party input must not crash, freeze or exhaust a collector, and what can't be
// stored must be quarantined, not lost. The hostile inputs below are each a single line within the 4 MiB line cap.

const lineCap = maxLineBytes - 64

func hostileLines() map[string][]byte {
	return map[string][]byte{
		// Without limits: a fatal Go stack overflow (unrecoverable), i.e. the collector process dies.
		"deep nesting": bytes.Repeat([]byte("["), lineCap),
		// Without limits: ~800 MB allocated (x190), far over the collectors' 64 MiB memory limit.
		"array of zeros": []byte("[" + strings.TrimSuffix(strings.Repeat("0,", lineCap/2), ",") + "]"),
		// Without limits: ~370 MB allocated.
		"array of tiny strings": []byte("[" + strings.TrimSuffix(strings.Repeat(`"a",`, lineCap/4), ",") + "]"),
		// Without limits: quadratic duplicate-key handling.
		"object of tiny pairs": []byte("{" + strings.TrimSuffix(strings.Repeat(`"":0,`, lineCap/5), ",") + "}"),
		// Without limits: ~30 s of CPU (quadratic decimal conversion).
		"huge integer": bytes.Repeat([]byte("9"), lineCap),
	}
}

func TestPoolLimitsStopCrashStallAndMemoryInputs(t *testing.T) {
	for name, b := range hostileLines() {
		runtime.GC()
		var m0, m1 runtime.MemStats
		runtime.ReadMemStats(&m0)
		start := time.Now()
		_, err := pyLoadsWith(b, poolLimits)
		took := time.Since(start)
		runtime.ReadMemStats(&m1)
		var le *pyLimitError
		if !errors.As(err, &le) {
			t.Errorf("%s: want a limit error, got %v", name, err)
		}
		if took > 2*time.Second {
			t.Errorf("%s: took %v", name, took)
		}
		// The input itself is 4 MiB; decoding up to the limit may allocate a few times that, not hundreds.
		if alloc := m1.TotalAlloc - m0.TotalAlloc; alloc > 24<<20 {
			t.Errorf("%s: allocated %d MiB", name, alloc>>20)
		}
	}
}

func TestLimitsLeaveRealDataAlone(t *testing.T) {
	// A real mining.notify decodes unchanged.
	msg, err := pyLoadsWith([]byte(strings.TrimSuffix(notifyLine("j1"), "\n")), poolLimits)
	if err != nil {
		t.Fatal(err)
	}
	if p, ok := notifyParams(msg); !ok || p[pJobID].s != "j1" {
		t.Fatal("notify not decoded")
	}
	// Size is not limited: a 4 MiB coinbase string is fine (and cheap).
	big := `["` + strings.Repeat("ab", lineCap/2-8) + `"]`
	if _, err := pyLoadsWith([]byte(big), poolLimits); err != nil {
		t.Errorf("large string: %v", err)
	}
	// Boundaries: exactly at the limit is allowed, one over is not.
	cases := []struct {
		name string
		in   string
		ok   bool
	}{
		{"4300 digits (Python's limit)", strings.Repeat("9", 4300), true},
		{"4301 digits", strings.Repeat("9", 4301), false},
		{"negative 4300 digits", "-" + strings.Repeat("9", 4300), true},
		{"long float is not an integer", "1." + strings.Repeat("9", 10000), true},
		{"depth 64", strings.Repeat("[", 64) + strings.Repeat("]", 64), true},
		{"depth 65", strings.Repeat("[", 65) + strings.Repeat("]", 65), false},
		{"10,000 values", "[" + strings.TrimSuffix(strings.Repeat("0,", 9999), ",") + "]", true},
		{"10,001 values", "[" + strings.TrimSuffix(strings.Repeat("0,", 10000), ",") + "]", false},
	}
	for _, c := range cases {
		_, err := pyLoadsWith([]byte(c.in), poolLimits)
		if (err == nil) != c.ok {
			t.Errorf("%s: err=%v", c.name, err)
		}
	}
}

func TestDefaultLimitsAllowLargerAPIResponses(t *testing.T) {
	in := `{"data": [` + strings.TrimSuffix(strings.Repeat("1,", 100_000), ",") + `]}`
	if _, err := pyLoads([]byte(in)); err != nil {
		t.Errorf("100k values: %v", err)
	}
	if _, err := pyLoads(bytes.Repeat([]byte("["), 10_000)); !errors.Is(err, errJSONDepth) {
		t.Errorf("deep nesting must still be bounded: %v", err)
	}
}

// ── quarantine budget ───────────────────────────────────────────────────────────────────────────────────────────

func TestQuarantineBudgetTiersAndSummary(t *testing.T) {
	q := quarantine{b: QuarantineBudget{Window: time.Hour, FullRows: 2, MaxRaw: 10, MetaRows: 2, MetaPrefix: 4}}
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	raw := []byte("0123456789abcdef") // 16 bytes
	sum := sha256.Sum256(raw)
	var rows []rejectRow
	suppressed := 0
	for i := 0; i < 7; i++ {
		r, s := q.admit(Rejection{TsNs: now.UnixNano(), Stage: "json", Reason: "invalid JSON", Raw: raw}, now)
		rows = append(rows, r...)
		if s {
			suppressed++
		}
	}
	// 2 full (raw clipped to 10), 2 meta (prefix 4), 1 marker row, 3 counted only.
	if len(rows) != 5 || suppressed != 3 {
		t.Fatalf("rows %d suppressed %d", len(rows), suppressed)
	}
	for i, r := range rows[:4] {
		want := 10
		if i >= 2 {
			want = 4
		}
		if len(r.Raw) != want || !r.Truncated || r.RawLength != 16 || !bytes.Equal(r.RawSHA256, sum[:]) || r.Stage != "json" {
			t.Errorf("row %d: %+v", i, r)
		}
	}
	if rows[4].Stage != "suppressed" || rows[4].Suppressed != 0 {
		t.Errorf("marker row: %+v", rows[4])
	}
	// The window's count arrives when it closes, and the next window starts fresh.
	later := now.Add(61 * time.Minute)
	r, s := q.admit(Rejection{TsNs: later.UnixNano(), Stage: "row", Reason: "x", Raw: []byte("ab")}, later)
	if s || len(r) != 2 || r[0].Stage != "suppressed" || r[0].Suppressed != 3 || !r[0].ReceivedAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("summary: %+v", r)
	}
	if string(r[1].Raw) != "ab" || r[1].Truncated {
		t.Errorf("fresh window row: %+v", r[1])
	}
}

func TestQuarantineReasonIsBounded(t *testing.T) {
	q := quarantine{b: defaultQuarantineBudget}
	r, _ := q.admit(Rejection{Reason: strings.Repeat("x", 10_000)}, time.Now())
	if len(r[0].Reason) > maxReasonLen+3 {
		t.Errorf("reason %d bytes", len(r[0].Reason))
	}
}

// ── sink: quarantined, never blocking templates ─────────────────────────────────────────────────────────────────

func TestUnstorableTemplateIsQuarantinedNotLost(t *testing.T) {
	db := &fakeDB{}
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return db, nil }).Start()
	s.Submit(testDoc(nil))
	s.Submit(testDoc(map[string]string{"prev_hash": `"zz"`}))
	if !waitFor(func() bool { return db.count("templates") == 1 && db.count("templates_rejected") == 1 }, 3*time.Second) {
		t.Fatalf("templates %d rejected %d", db.count("templates"), db.count("templates_rejected"))
	}
	db.mu.Lock()
	row := db.rows["templates_rejected"][0]
	db.mu.Unlock()
	if row[1] != int16(42) || row[2] != "row" || !strings.HasPrefix(row[3].(string), "prev_hash") ||
		!bytes.Contains(row[6].([]byte), []byte(`"zz"`)) {
		t.Errorf("quarantined row %v", row)
	}
	s.Close(time.Second)
	if st := s.Stats(); st["dropped_invalid"] != 1 || st["rejected"] != 1 || st["rejects_written"] != 1 {
		t.Errorf("stats %v", st)
	}
}

func TestQuarantineFailureNeverBlocksTemplates(t *testing.T) {
	db := &fakeDB{failRejects: true} // e.g. the collector runs before the migration
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return db, nil }).Start()
	for i := 0; i < 3; i++ {
		s.SubmitReject(Rejection{TsNs: time.Now().UnixNano(), Stage: "json", Reason: "invalid JSON", Raw: []byte("{")})
		s.Submit(testDoc(nil))
	}
	if !waitFor(func() bool { return db.count("templates") == 3 }, 3*time.Second) {
		t.Fatalf("templates %d", db.count("templates"))
	}
	s.Close(time.Second)
	if st := s.Stats(); st["rejects_db_errors"] == 0 || st["rejects_dropped"] != 3 || st["db_errors"] != 0 {
		t.Errorf("stats %v", st)
	}
}

func TestRejectsAloneAreWritten(t *testing.T) {
	db := &fakeDB{}
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return db, nil }).Start()
	s.SubmitReject(Rejection{TsNs: time.Now().UnixNano(), Stage: "line", Reason: "no newline", Raw: []byte("x")})
	if !waitFor(func() bool { return db.count("templates_rejected") == 1 }, 3*time.Second) {
		t.Fatal("not written")
	}
	s.Close(time.Second)
}

func TestRejectQueueIsBounded(t *testing.T) {
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return nil, errors.New("down") })
	s.maxRejQueue = 5
	for i := 0; i < 20; i++ { // not started: nothing drains
		s.SubmitReject(Rejection{Stage: "json", Reason: "x", Raw: []byte("y")})
	}
	if st := s.Stats(); len(s.rejQ) != 5 || st["rejects_dropped"] != 15 {
		t.Errorf("queue %d stats %v", len(s.rejQ), st)
	}
}

// ── end to end: a pool sending hostile lines ────────────────────────────────────────────────────────────────────

func TestHostilePoolLinesAreQuarantinedAndCollectionContinues(t *testing.T) {
	pool := newFakePool(t)
	c, docs, m, cancel := testCollector(t, poolURL(pool), nil)
	var mu sync.Mutex
	var rejected []Rejection
	c.Reject = func(r Rejection) { mu.Lock(); rejected = append(rejected, r); mu.Unlock() }
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	defer cancel()
	go c.Run(ctx)
	f := pool.accept(t)
	f.handshake(t)
	hostile := hostileLines()
	for _, name := range []string{"deep nesting", "array of zeros", "huge integer"} {
		f.send(t, string(hostile[name])+"\n")
	}
	f.send(t, "not json at all\n")
	f.send(t, `{"id": null, "method": "mining.notify", "params": ["short"]}`+"\n")
	f.send(t, notifyLine("after"))
	if d := nextDoc(t, docs); d.Params[pJobID].s != "after" {
		t.Fatalf("got %s", d.Params[pJobID].s)
	}
	mu.Lock()
	defer mu.Unlock()
	want := []string{"JSON limit exceeded: nesting_depth", "JSON limit exceeded: value_count",
		"JSON limit exceeded: integer_digits", "invalid JSON"}
	if len(rejected) != 5 {
		t.Fatalf("rejected %d: %+v", len(rejected), rejected)
	}
	for i, w := range want {
		if rejected[i].Stage != "json" || rejected[i].Reason != w || rejected[i].TsNs == 0 || len(rejected[i].Raw) == 0 {
			t.Errorf("rejection %d: stage %s reason %q", i, rejected[i].Stage, rejected[i].Reason)
		}
	}
	if rejected[4].Stage != "notify" || !strings.Contains(string(rejected[4].Raw), `"short"`) {
		t.Errorf("notify rejection: %+v", rejected[4])
	}
	if m.Rejected.Load() != 5 || m.NotifyMalformed.Load() != 1 || pool.count() != 1 {
		t.Errorf("rejected %d malformed %d connections %d", m.Rejected.Load(), m.NotifyMalformed.Load(), pool.count())
	}
}

func TestOverlongLineIsQuarantinedAndTheSessionReconnects(t *testing.T) {
	pool := newFakePool(t)
	c, docs, _, cancel := testCollector(t, poolURL(pool), nil)
	got := make(chan Rejection, 4)
	c.Reject = func(r Rejection) { got <- r }
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	defer cancel()
	go c.Run(ctx)
	f := pool.accept(t)
	f.handshake(t)
	f.send(t, strings.Repeat("x", maxLineBytes+4096)) // no newline
	select {
	case r := <-got:
		if r.Stage != "line" || len(r.Raw) != 256<<10 || !strings.HasPrefix(r.Reason, "no newline in") {
			t.Errorf("rejection %s %q %d", r.Stage, r.Reason, len(r.Raw))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no rejection")
	}
	f2 := pool.accept(t) // reconnected
	f2.handshake(t)
	f2.send(t, notifyLine("again"))
	if d := nextDoc(t, docs); d.Params[pJobID].s != "again" {
		t.Errorf("got %s", d.Params[pJobID].s)
	}
}
