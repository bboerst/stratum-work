package main

import (
	"context"
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

func TestRouteBitcoinWithAndWithoutAKnownTip(t *testing.T) {
	for _, c := range []struct {
		h, tip int64
		ok     bool
	}{{975_500, 975_499, true}, {975_493, 975_499, true}, {975_501, 975_499, true}, {975_500, 0, false}} {
		if r := route(c.h, "", c.tip, c.ok); r != routeBTC {
			t.Errorf("%+v -> %+v", c, r)
		}
	}
}

func TestRouteOtherTables(t *testing.T) {
	cases := []struct {
		h     int64
		chain string
		tip   int64
		tipOK bool
		want  Route
	}{
		{0, "", 975_499, true, Route{"templates_other", "unknown", "height_parse_failed"}},
		{0, "", 0, false, Route{"templates_other", "unknown", "height_parse_failed"}},
		{930_000, "bch", 975_499, true, Route{"templates_other", "bch", "bch"}},
		{975_500, "unknown", 975_499, true, Route{"templates_other", "unknown", "unknown_chain"}},
		{6_976_415, "", 975_499, true, Route{"templates_other", "unknown", "height_implausible"}},
		{975_492, "", 975_499, true, Route{"templates_other", "unknown", "height_implausible"}},
		{975_502, "", 975_499, true, Route{"templates_other", "unknown", "height_implausible"}},
	}
	for _, c := range cases {
		if r := route(c.h, c.chain, c.tip, c.tipOK); r != c.want {
			t.Errorf("%+v -> %+v", c, r)
		}
	}
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
	mu         sync.Mutex
	failWrites bool
	upserts    [][4]string
	rows       map[string][][]any
	closed     int
}

func (f *fakeDB) UpsertSource(_ context.Context, name, site, replica, url string) (int16, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.upserts = append(f.upserts, [4]string{name, site, replica, url})
	return 42, nil
}

func (f *fakeDB) WriteBatch(_ context.Context, btc, other [][]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failWrites {
		return errors.New("db down")
	}
	if f.rows == nil {
		f.rows = map[string][][]any{}
	}
	f.rows["templates"] = append(f.rows["templates"], btc...)
	f.rows["templates_other"] = append(f.rows["templates_other"], other...)
	return nil
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

func newTestSink(connect func(context.Context, PGConfig) (pgConn, error), tip func() (int64, bool)) *PostgresSink {
	if tip == nil {
		tip = func() (int64, bool) { return 0, false }
	}
	s := NewPostgresSink(testPGCfg, "P", "stratum+tcp://x:3333", tip, quietLog)
	s.connect = connect
	return s
}

func TestSinkWritesRoutedRowsAndRegistersSource(t *testing.T) {
	db := &fakeDB{}
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return db, nil },
		func() (int64, bool) { return 975_499, true }).Start()
	s.Submit(testDoc(nil))
	s.Submit(testDoc(map[string]string{"height": "6976415"}))
	s.Submit(testDoc(map[string]string{"height": "0"}))
	if !waitFor(func() bool { st := s.Stats(); return st["written"]+st["written_other"] == 3 }, 5*time.Second) {
		t.Fatal(s.Stats())
	}
	s.Close(time.Second)
	if len(db.rows["templates"]) != 1 {
		t.Error(len(db.rows["templates"]))
	}
	var reasons []string
	for _, r := range db.rows["templates_other"] {
		reasons = append(reasons, r[len(r)-1].(string))
	}
	if strings.Join(reasons, ",") != "height_implausible,height_parse_failed" {
		t.Error(reasons)
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
	}, nil).Start()
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
	}, nil)
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
	s := newTestSink(nil, nil) // not started
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
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return db, nil }, nil).Start()
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
	s := newTestSink(func(context.Context, PGConfig) (pgConn, error) { return db, nil }, nil)
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
	s := NewPostgresSink(cfg, name, "stratum+tcp://example:3333", func() (int64, bool) { return 975_499, true }, quietLog).Start()
	s.Submit(testDoc(nil))
	other := testDoc(map[string]string{"job_id": `"other"`, "height": "6976415"})
	other.ChainFamily = "unknown"
	s.Submit(other)
	noLat := testDoc(map[string]string{"job_id": `"nolat"`, "no_latency": ""})
	s.Submit(noLat)
	if !waitFor(func() bool { st := s.Stats(); return st["written"]+st["written_other"] == 3 }, 15*time.Second) {
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
	var oh int32
	var chain, reason string
	if err := c.QueryRow(context.Background(), `SELECT height, chain::text, reason FROM templates_other WHERE source_id = $1`, sid).Scan(&oh, &chain, &reason); err != nil || oh != 6_976_415 || chain != "unknown" || reason != "unknown_chain" {
		t.Error(err, oh, chain, reason)
	}
	var nulls int
	if err := c.QueryRow(context.Background(), `SELECT count(*) FROM templates WHERE source_id = $1 AND job_id = 'nolat' AND latency_ms IS NULL AND latency_method IS NULL`, sid).Scan(&nulls); err != nil || nulls != 1 {
		t.Error(err, nulls)
	}
}
