package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Ported from collector/tests/test_pgsink.py.

const testNS = int64(1_794_437_000_123_456_789)

var quietLog = slog.New(slog.NewTextHandler(io.Discard, nil))

func hexLower(b []byte) string { return hex.EncodeToString(b) }

// testDoc is test_pgsink.doc(): a valid template; over replaces raw JSON params by index or field name.
func testDoc(over map[string]string) *Document {
	raw := map[string]string{
		"job_id": `"abc1"`, "prev_hash": `"` + strings.Repeat("11", 32) + `"`,
		"coinbase1": `"01000000` + strings.Repeat("00", 8) + `"`, "coinbase2": `"ffffffff"`,
		"merkle_branches": `["` + strings.Repeat("aa", 32) + `", "` + strings.Repeat("bb", 32) + `"]`,
		"version":         `"20000000"`, "nbits": `"1702e5b4"`, "ntime": `"69d72a43"`, "clean_jobs": "true",
		"extranonce1": `"abcd"`, "extranonce2_length": "8",
	}
	for k, v := range over {
		raw[k] = v
	}
	mustLoad := func(s string) pyValue {
		v, err := pyLoads([]byte(s))
		if err != nil {
			panic(s)
		}
		return v
	}
	d := &Document{ID: uuid4(), TsNs: testNS, PoolName: "P", Height: 975_500, HasLatency: true, LatencyMs: 12.5,
		LatencyMethod: "tcp"}
	for i, k := range []string{"job_id", "prev_hash", "coinbase1", "coinbase2", "merkle_branches", "version", "nbits",
		"ntime", "clean_jobs"} {
		d.Params[i] = mustLoad(raw[k])
	}
	d.Extranonce1, d.Extranonce2Len = mustLoad(raw["extranonce1"]), mustLoad(raw["extranonce2_length"])
	if h, ok := over["height"]; ok {
		d.Height, _ = strconv.ParseInt(h, 10, 64)
	}
	if m, ok := over["lat_m"]; ok {
		d.LatencyMethod = m
	}
	if _, ok := over["no_latency"]; ok {
		d.HasLatency = false
	}
	if ts, ok := over["timestamp"]; ok {
		d.TsNs, _ = strconv.ParseInt(ts, 10, 64)
	}
	return d
}

func TestLosslessConversion(t *testing.T) {
	d := testDoc(nil)
	row, err := toRow(d, 7)
	if err != nil {
		t.Fatal(err)
	}
	if row.ReceivedAt.UnixMicro() != testNS/1000 || row.ReceivedAt.Nanosecond()/1000 != 123_456 {
		t.Error(row.ReceivedAt)
	}
	if row.SourceID != 7 || hexLower(row.PrevHash) != d.Params[pPrevHash].s ||
		hexLower(row.Coinbase1) != d.Params[pCoinbase1].s || hexLower(row.Coinbase2) != d.Params[pCoinbase2].s ||
		hexLower(row.MerkleBranches) != strings.Repeat("aa", 32)+strings.Repeat("bb", 32) ||
		fmt.Sprintf("%08x %08x %08x", row.Version, row.Nbits, row.Ntime) != "20000000 1702e5b4 69d72a43" ||
		hexLower(row.Extranonce1) != "abcd" || *row.LatencyMs != 12.5 || *row.LatencyMethod != "tcp" {
		t.Errorf("%+v", row)
	}
}

func TestEmptyBranchesAndUnknownLatencyMethod(t *testing.T) {
	row, err := toRow(testDoc(map[string]string{"merkle_branches": "[]", "lat_m": "bogus", "no_latency": ""}), 1)
	if err != nil || len(row.MerkleBranches) != 0 || row.MerkleBranches == nil || row.LatencyMs != nil || row.LatencyMethod != nil {
		t.Errorf("%+v %v", row, err)
	}
	row, _ = toRow(testDoc(map[string]string{"lat_m": "bogus"}), 1)
	if row.LatencyMs == nil || row.LatencyMethod != nil {
		t.Error("lat_ms kept, unknown method dropped")
	}
}

func TestMalformedInputRaises(t *testing.T) {
	for _, over := range []map[string]string{{"coinbase1": `"zz"`}, {"prev_hash": `"abc"`}, {"version": `"1ffffffff"`},
		{"timestamp": "-5"}} {
		if _, err := toRow(testDoc(over), 1); err == nil {
			t.Errorf("%v: expected an error", over)
		}
	}
}

// Values Postgres refuses would make Python fail the whole batch forever; Go rejects just the row.
func TestRowsPostgresWouldRefuseAreInvalid(t *testing.T) {
	for _, over := range []map[string]string{{"job_id": `"a\u0000b"`}, {"job_id": `"\ud800"`},
		{"extranonce2_length": "40000"}, {"height": "4294967296"}} {
		if _, err := toRow(testDoc(over), 1); err == nil {
			t.Errorf("%v: expected an error", over)
		}
	}
}

// ── sink with a fake database ────────────────────────────────────────────────────────────────────────────────────

type fakeDB struct {
	mu          sync.Mutex
	failWrites  bool
	failRejects bool
	failEvents  bool
	upserts     [][4]string
	rows        map[string][][]any
	closed      int
}

func (f *fakeDB) UpsertSource(_ context.Context, name, site, replica, url string) (int16, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upserts = append(f.upserts, [4]string{name, site, replica, url})
	return 42, nil
}

func (f *fakeDB) WriteBatch(_ context.Context, rows [][]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failWrites {
		return errors.New("db down")
	}
	if f.rows == nil {
		f.rows = map[string][][]any{}
	}
	f.rows["templates"] = append(f.rows["templates"], rows...)
	return nil
}

func (f *fakeDB) WriteRejects(_ context.Context, rows [][]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failWrites || f.failRejects {
		return errors.New("templates_rejected unavailable")
	}
	if f.rows == nil {
		f.rows = map[string][][]any{}
	}
	f.rows["templates_rejected"] = append(f.rows["templates_rejected"], rows...)
	return nil
}

func (f *fakeDB) WriteEvents(_ context.Context, rows [][]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failWrites || f.failEvents {
		return errors.New("ingest_events unavailable")
	}
	if f.rows == nil {
		f.rows = map[string][][]any{}
	}
	f.rows["ingest_events"] = append(f.rows["ingest_events"], rows...)
	return nil
}

func (f *fakeDB) count(table string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.rows[table])
}

func (f *fakeDB) Close() { f.mu.Lock(); f.closed++; f.mu.Unlock() }

func waitFor(cond func() bool, timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for time.Now().Before(end) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

var testPGCfg = PGConfig{Host: "h", Port: "5432", Database: "d", User: "u", Password: "secret-pw", Site: "test", Replica: "b"}

func newTestSink(connect func(context.Context, PGConfig) (pgConn, error)) *PostgresSink {
	s := NewPostgresSink(testPGCfg, "P", "stratum+tcp://x:3333", quietLog)
	s.connect = connect
	return s
}

// Every template lands in templates, including another chain's height and an unparseable one (0): which chain a
// row belongs to is decided at read time (docs/design/one-templates-table.md).
func TestSinkWritesEveryTemplateAndRegistersSource(t *testing.T) {
	db := &fakeDB{}
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return db, nil }).Start()
	s.Submit(testDoc(nil))
	s.Submit(testDoc(map[string]string{"height": "6976415"}))
	s.Submit(testDoc(map[string]string{"height": "0"}))
	if !waitFor(func() bool { return s.Stats()["written"] == 3 }, 5*time.Second) {
		t.Fatal(s.Stats())
	}
	s.Close(time.Second)
	var heights []string
	for _, r := range db.rows["templates"] {
		heights = append(heights, strconv.Itoa(int(r[2].(int32))))
	}
	if strings.Join(heights, ",") != "975500,6976415,0" {
		t.Error(heights)
	}
	if len(db.rows) != 1 {
		t.Error("rows outside templates:", db.rows)
	}
	if db.upserts[0] != [4]string{"P", "test", "b", "stratum+tcp://x:3333"} {
		t.Error(db.upserts)
	}
	if db.rows["templates"][0][1] != int16(42) {
		t.Error("source id")
	}
}

func TestDatabaseDownNeverBlocksOrRaisesAndRecovers(t *testing.T) {
	var attempts int
	var mu sync.Mutex
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) {
		mu.Lock()
		defer mu.Unlock()
		attempts++
		if attempts < 3 {
			return nil, errors.New("connection refused")
		}
		return &fakeDB{}, nil
	}).Start()
	t0 := time.Now()
	for i := 0; i < 1000; i++ {
		s.Submit(testDoc(map[string]string{"job_id": strconv.Quote(strconv.Itoa(i))}))
	}
	if time.Since(t0) > 500*time.Millisecond {
		t.Error("submit waited on the database")
	}
	if !waitFor(func() bool { return s.Stats()["written"] == 1000 }, 10*time.Second) {
		t.Fatal(s.Stats())
	}
	if s.Stats()["db_errors"] < 2 {
		t.Error(s.Stats())
	}
	s.Close(time.Second)
}

func TestBoundedQueueDropsOldestAndCounts(t *testing.T) {
	gate := make(chan struct{})
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) {
		<-gate
		return nil, errors.New("down")
	})
	s.maxQueue, s.batchSize = 10, 1 // one in flight at most, like Python's first take of a near-empty queue
	s.Start()
	for i := 0; i < 25; i++ {
		s.Submit(testDoc(map[string]string{"job_id": strconv.Quote(strconv.Itoa(i))}))
	}
	if s.Queued() > 10 || s.Stats()["dropped_queue_full"] < 14 {
		t.Error(s.Queued(), s.Stats())
	}
	close(gate)
	s.Close(100 * time.Millisecond)
}

func TestQueueOverflowKeepsTheNewest(t *testing.T) {
	s := newTestSink(nil) // not started
	s.maxQueue = 10
	for i := 0; i < 25; i++ {
		s.Submit(testDoc(map[string]string{"job_id": strconv.Quote(strconv.Itoa(i))}))
	}
	if s.Queued() != 10 || s.Stats()["dropped_queue_full"] != 15 || pyStrOf(s.queue[0].Params[0]) != "15" {
		t.Error(s.Queued(), s.Stats())
	}
}

func TestMalformedDocumentsAreDroppedNotFatal(t *testing.T) {
	db := &fakeDB{}
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return db, nil }).Start()
	s.Submit(testDoc(map[string]string{"coinbase1": `"not-hex"`}))
	s.Submit(testDoc(nil))
	if !waitFor(func() bool { return s.Stats()["written"] == 1 }, 5*time.Second) {
		t.Fatal(s.Stats())
	}
	if s.Stats()["dropped_invalid"] != 1 {
		t.Error(s.Stats())
	}
	s.Close(time.Second)
}

func TestCloseFlushesWhatIsQueued(t *testing.T) {
	db := &fakeDB{}
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return db, nil })
	for i := 0; i < 1200; i++ {
		s.Submit(testDoc(nil))
	}
	s.Start()
	s.Close(5 * time.Second)
	if s.Stats()["written"] != 1200 || db.closed != 1 {
		t.Error(s.Stats(), db.closed)
	}
}

func TestPasswordIsNeverInTheConnectionString(t *testing.T) {
	// pgxConnect builds a keyword DSN without the password; a parse error must not echo the settings either.
	_, err := pgxConnect(context.Background(), PGConfig{Host: "h", Port: "x", Password: "secret-pw"})
	if err == nil || strings.Contains(err.Error(), "secret-pw") {
		t.Error(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err = pgxConnect(ctx, PGConfig{Host: "127.0.0.1", Port: "1", Database: "d", User: "u", Password: "secret-pw",
		SSLMode: "disable", ConnectTimeout: time.Second})
	if err == nil || strings.Contains(err.Error(), "secret-pw") {
		t.Error(err)
	}
}

// Against a real, migrated database, connected as a user in the stratum_collector role (least privilege).
// Set PG_TEST_HOST, PG_TEST_USER, PG_TEST_PASSWORD (and PG_TEST_ADMIN_* to verify the rows).
func TestPostgresIntegration(t *testing.T) {
	host := os.Getenv("PG_TEST_HOST")
	if host == "" {
		t.Skip("set PG_TEST_HOST etc. to run against a migrated Postgres")
	}
	cfg := PGConfig{Host: host, Port: envOr("PG_TEST_PORT", "5432"), Database: envOr("PG_TEST_DATABASE", "stratum"),
		User: os.Getenv("PG_TEST_USER"), Password: os.Getenv("PG_TEST_PASSWORD"), SSLMode: "disable", Site: "ci",
		Replica: "b", ConnectTimeout: 5 * time.Second}
	name := fmt.Sprintf("itest-go-%d", time.Now().UnixMilli())
	s := NewPostgresSink(cfg, name, "stratum+tcp://example:3333", quietLog)
	s.quar.b = QuarantineBudget{Window: time.Hour, FullRows: 3, MaxRaw: 1 << 10, MetaRows: 0, MetaPrefix: 0}
	s.Start()
	s.Submit(testDoc(nil))
	s.Submit(testDoc(map[string]string{"job_id": `"bad"`, "ntime": `"not-hex"`})) // quarantined (stage row)
	s.SubmitReject(Rejection{TsNs: testNS, Stage: "json", Reason: "invalid JSON", Raw: []byte("{\x00\xff")})
	s.SubmitReject(Rejection{TsNs: testNS, Stage: "json", Reason: "invalid JSON", Raw: []byte("{")})
	if !waitFor(func() bool { return s.Stats()["rejects_written"] == 3 }, 15*time.Second) { // budget now spent
		t.Fatal(s.Stats())
	}
	s.SubmitReject(Rejection{TsNs: testNS, Stage: "json", Reason: "invalid JSON", Raw: []byte("[")}) // marker row
	evStart := time.Unix(0, testNS).UTC().Truncate(time.Second)
	s.SubmitEvent(IngestEvent{Kind: "burst", Start: evStart, End: evStart.Add(2 * time.Second), Templates: 3100, Peak: 2900,
		Detail: map[string]any{"per_second": []int{200, 2900}, "first_job_id": "j\"1"}})
	s.SubmitEvent(startEvent("node-ci", "test", evStart))
	s.SubmitEvent(IngestEvent{Kind: "session", Start: evStart, End: evStart.Add(time.Minute), Templates: 2,
		Detail: map[string]any{"subscribed_at": evStart.Add(time.Second).Format(time.RFC3339Nano), "end": "EOF"}})
	// Another chain's height and an unparseable one (0) go to templates like every other template.
	s.Submit(testDoc(map[string]string{"job_id": `"other"`, "height": "6976415"}))
	s.Submit(testDoc(map[string]string{"job_id": `"noheight"`, "height": "0"}))
	noLat := testDoc(map[string]string{"job_id": `"nolat"`, "no_latency": ""})
	s.Submit(noLat)
	if !waitFor(func() bool {
		st := s.Stats()
		return st["written"] == 4 && st["rejects_written"] == 4 && st["events_written"] == 3
	}, 15*time.Second) {
		t.Fatal(s.Stats())
	}
	s.Close(time.Second)
	adminUser := os.Getenv("PG_TEST_ADMIN_USER")
	if adminUser == "" {
		return
	}
	acfg := cfg
	acfg.User, acfg.Password = adminUser, os.Getenv("PG_TEST_ADMIN_PASSWORD")
	conn, err := pgxConnect(context.Background(), acfg)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	c := conn.(*pgxConn).c
	var sid int16
	var replica string
	if err := c.QueryRow(context.Background(), `SELECT id, replica FROM sources WHERE name = $1 AND site = 'ci'`, name).Scan(&sid, &replica); err != nil || replica != "b" {
		t.Fatal(err, replica)
	}
	var prev, cb1, br, ver, lm string
	var h int32
	var lat float32
	var rcv time.Time
	err = c.QueryRow(context.Background(), `SELECT encode(prev_hash,'hex'), encode(coinbase1,'hex'),
		encode(merkle_branches,'hex'), lpad(to_hex(version),8,'0'), height, latency_ms, latency_method::text, received_at
		FROM templates WHERE source_id = $1 AND job_id = 'abc1'`, sid).Scan(&prev, &cb1, &br, &ver, &h, &lat, &lm, &rcv)
	d := testDoc(nil)
	if err != nil || prev != d.Params[pPrevHash].s || cb1 != d.Params[pCoinbase1].s ||
		br != strings.Repeat("aa", 32)+strings.Repeat("bb", 32) || ver != "20000000" || h != 975_500 || lat != 12.5 ||
		lm != "tcp" || rcv.UnixMicro() != testNS/1000 {
		t.Error(err, prev, h, lat, lm, rcv)
	}
	var node, sessEnd string
	if err := c.QueryRow(context.Background(), `SELECT (SELECT detail->>'node' FROM ingest_events WHERE source_id = $1 AND kind = 'start'),
		(SELECT detail->>'end' FROM ingest_events WHERE source_id = $1 AND kind = 'session' AND templates = 2)`, sid).Scan(&node, &sessEnd); err != nil ||
		node != "node-ci" || sessEnd != "EOF" {
		t.Error("start/session events:", err, node, sessEnd)
	}
	var other, noHeight, total int32
	if err := c.QueryRow(context.Background(), `SELECT
		(SELECT height FROM templates WHERE source_id = $1 AND job_id = 'other'),
		(SELECT height FROM templates WHERE source_id = $1 AND job_id = 'noheight'),
		(SELECT count(*) FROM templates WHERE source_id = $1)`, sid).Scan(&other, &noHeight, &total); err != nil ||
		other != 6_976_415 || noHeight != 0 || total != 4 {
		t.Error("templates:", err, other, noHeight, total)
	}
	var nulls int
	if err := c.QueryRow(context.Background(), `SELECT count(*) FROM templates WHERE source_id = $1 AND job_id = 'nolat' AND latency_ms IS NULL AND latency_method IS NULL`, sid).Scan(&nulls); err != nil || nulls != 1 {
		t.Error(err, nulls)
	}
	// Quarantine: the unstorable template and both undecodable lines with raw and hash; then, budget spent, the
	// marker row and (written by Close) the window's count, both without raw or hash.
	type rr struct {
		stage, reason string
		n, suppressed int32
		raw           []byte
		noSum, trunc  bool
	}
	var got []rr
	rows, err := c.Query(context.Background(), `SELECT stage, reason, raw_length, suppressed, raw, raw_sha256 IS NULL,
		raw_truncated FROM templates_rejected WHERE source_id = $1`, sid)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var r rr
		if err := rows.Scan(&r.stage, &r.reason, &r.n, &r.suppressed, &r.raw, &r.noSum, &r.trunc); err != nil {
			t.Fatal(err)
		}
		got = append(got, r)
	}
	var row, nulBytes, brace, marker, summary int
	for _, r := range got {
		switch {
		case r.stage == "row" && strings.HasPrefix(r.reason, "ntime") && strings.Contains(string(r.raw), `"not-hex"`) && !r.noSum:
			row++
		case r.stage == "json" && string(r.raw) == "{\x00\xff" && r.n == 3 && !r.noSum && !r.trunc:
			nulBytes++
		case r.stage == "json" && string(r.raw) == "{" && r.n == 1:
			brace++
		case r.stage == "suppressed" && r.raw == nil && r.noSum && r.suppressed == 0:
			marker++
		case r.stage == "suppressed" && r.raw == nil && r.noSum && r.suppressed == 1:
			summary++
		}
	}
	if len(got) != 5 || row != 1 || nulBytes != 1 || brace != 1 || marker != 1 || summary != 1 {
		t.Errorf("quarantine rows %+v", got)
	}
	// Ingest event: jsonb detail round-trips.
	var kind, firstJob string
	var tmpl, peak, sec2 int32
	var dur time.Duration
	if err := c.QueryRow(context.Background(), `SELECT kind, templates, peak_per_second, (detail->'per_second'->>1)::int,
		detail->>'first_job_id', extract(epoch from ended_at - started_at)::int * interval '1 second'
		FROM ingest_events WHERE source_id = $1`, sid).Scan(&kind, &tmpl, &peak, &sec2, &firstJob, &dur); err != nil ||
		kind != "burst" || tmpl != 3100 || peak != 2900 || sec2 != 2900 || firstJob != `j"1` || dur != 2*time.Second {
		t.Error(err, kind, tmpl, peak, sec2, firstJob, dur)
	}
}
