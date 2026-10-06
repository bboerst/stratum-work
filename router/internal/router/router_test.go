package router

import (
	"context"
	"io"
	"log/slog"
	"net"
	"testing"
	"time"

	"github.com/bboerst/stratum-work/router/internal/config"
)

// A -race CPU miner measures ~9e4 H/s (~20 shares/s at diff 1e-6).
// TargetThs 3e-8 asks for 3e4 H/s on target "a" (about a third of the
// miner), so the remainder "datum" keeps a real share of slices too. If the
// target exceeded the miner's rate its fraction would cap at 1 and the
// remainder would starve. Assertions only need > 0 per pool.
const (
	// Measured: a -race CPU miner does ~1e5 H/s (~20 router shares/s at
	// diff 1e-6). Pool diff is 2x router diff so about half of router shares
	// are forwarded; with 10x, too few reached a pool and the test flaked.
	poolDiff   = 0.000002
	routerDiff = 0.000001
)

func testConfig(targetAddr, remainderAddr string, perIP int) *config.Config {
	cfg := &config.Config{Site: "test-site", Listen: "127.0.0.1:0"}
	cfg.Slice.MinSliceMs = 200
	cfg.Targets = []config.TargetConfig{{ID: "a", Pool: "PoolA", Upstream: targetAddr, TargetThs: 3e-8}}
	cfg.Remainder = config.UpstreamConfig{ID: "datum", Upstream: remainderAddr, Username: "rem-user", Password: "rem-pass"}
	cfg.Limits.MaxConnectionsPerIP = perIP
	cfg.Limits.MaxConnections = 100
	cfg.Limits.InvalidShareBanRatio = 0.2
	cfg.Limits.IdleTimeoutS = 60
	cfg.VarDiff.Start, cfg.VarDiff.Min, cfg.VarDiff.Max = routerDiff, routerDiff, routerDiff
	cfg.VarDiff.SharesPerSec = 5
	cfg.ThanksMinWorkMinutes = 60
	return cfg
}

type testEnv struct {
	poolA, poolD *fakePool
	r            *Router
	addr         string
}

func startRouter(t *testing.T, perIP int) *testEnv {
	t.Helper()
	pa := newFakePool(t, "aaaa0001", poolDiff)
	pd := newFakePool(t, "dddd0002", poolDiff)
	cfg := testConfig(pa.Addr(), pd.Addr(), perIP)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	r := New(cfg, "work-token", nil, log)
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() { errc <- r.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-errc:
		case <-time.After(3 * time.Second):
			t.Error("router Run did not return after cancel")
		}
	})
	var addr net.Addr
	deadline := time.Now().Add(3 * time.Second)
	for addr == nil && time.Now().Before(deadline) {
		addr = r.Addr()
		if addr == nil {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if addr == nil {
		t.Fatal("router never started listening")
	}
	env := &testEnv{poolA: pa, poolD: pd, r: r, addr: addr.String()}
	// Wait until both upstreams are authorized so jobs are available.
	waitFor(t, 3*time.Second, "upstreams authorized", func() bool {
		return len(pa.Usernames()) > 0 && len(pd.Usernames()) > 0
	})
	return env
}

func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

func TestEndToEndSharesReachBothPools(t *testing.T) {
	env := startRouter(t, 4)
	m := dialMiner(t, env.addr)
	if len(m.En1()) != 8 {
		t.Fatalf("downstream en1 should be 4 bytes, got %q", m.En1())
	}
	m.Mine()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if env.poolA.Accepted() > 0 && env.poolD.Accepted() > 0 && m.CleanSeen() > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	m.Stop()
	if env.poolA.Accepted() == 0 || env.poolD.Accepted() == 0 {
		t.Fatalf("both pools must accept shares: a=%d datum=%d (miner accepted=%d)",
			env.poolA.Accepted(), env.poolD.Accepted(), m.Result(0))
	}
	if r := env.poolA.Rejected() + env.poolD.Rejected(); r != 0 {
		t.Fatalf("pools rejected %d folded shares", r)
	}
	if m.CleanSeen() == 0 {
		t.Fatal("miner never received a clean_jobs=true switch")
	}
	if n := m.Result(23); n != 0 {
		t.Fatalf("router rejected %d valid shares as low difficulty", n)
	}
	var invalid uint64
	for _, c := range env.r.Status().Connections {
		invalid += c.Invalid
	}
	if invalid != 0 {
		t.Fatalf("router counted %d invalid shares", invalid)
	}
	if u := env.poolA.Usernames(); u[0] != "test-site" {
		t.Fatalf("target should authorize with site name, got %q", u[0])
	}
	if u := env.poolD.Usernames(); u[0] != "rem-user" {
		t.Fatalf("remainder should authorize with configured user, got %q", u[0])
	}
}

func TestStaleAfterClean(t *testing.T) {
	env := startRouter(t, 4)
	m := dialMiner(t, env.addr)
	j, _ := m.WaitJob(0, 3*time.Second)
	s, ok := m.FindShare(j, -1)
	if !ok {
		t.Fatal("no share found")
	}
	_, gen, _ := m.Job()
	// The miner may be on either target; clean both so the old job is gone.
	env.poolA.PushJob(true)
	env.poolD.PushJob(true)
	m.WaitJob(gen, 3*time.Second)
	time.Sleep(50 * time.Millisecond)
	m.Submit(s)
	if !m.WaitResult(21, 1, 3*time.Second) {
		t.Fatalf("expected error 21 for stale job; results accepted=%d 22=%d 23=%d",
			m.Result(0), m.Result(22), m.Result(23))
	}
}

func TestDuplicateRejected(t *testing.T) {
	env := startRouter(t, 4)
	m := dialMiner(t, env.addr)
	j, _ := m.WaitJob(0, 3*time.Second)
	s, ok := m.FindShare(j, -1)
	if !ok {
		t.Fatal("no share found")
	}
	m.Submit(s)
	if !m.WaitResult(0, 1, 3*time.Second) {
		t.Fatalf("first submit should be accepted; 21=%d 23=%d", m.Result(21), m.Result(23))
	}
	m.Submit(s)
	if !m.WaitResult(22, 1, 3*time.Second) {
		t.Fatalf("second identical submit should get error 22; accepted=%d", m.Result(0))
	}
}

// A remainder without version rolling must not turn a rolling miner's valid
// shares into low-difficulty rejects (which would count toward a ban), and
// must never be sent rolled bits it did not agree to.
func TestNoRollRemainderAcceptsRolledShares(t *testing.T) {
	pd := newFakePoolOpts(t, "dddd0002", poolDiff, true)
	cfg := testConfig("", pd.Addr(), 4)
	cfg.Targets = nil
	r := New(cfg, "work-token", nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = r.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	waitFor(t, 3*time.Second, "listening", func() bool { return r.Addr() != nil })
	waitFor(t, 3*time.Second, "remainder authorized", func() bool { return len(pd.Usernames()) > 0 })

	m := dialMiner(t, r.Addr().String())
	j, _ := m.WaitJob(0, 3*time.Second)
	for i := 0; i < 3; i++ {
		s, ok := m.FindShare(j, -1)
		if !ok {
			t.Fatal("no share found")
		}
		if s.VersionBits == "" {
			t.Fatal("miner should be rolling version bits")
		}
		m.Submit(s)
	}
	if !m.WaitResult(0, 3, 3*time.Second) {
		t.Fatalf("rolled shares should be accepted downstream; 23=%d", m.Result(23))
	}
	if n := pd.Rejected(); n != 0 {
		t.Fatalf("no-roll pool was sent %d shares it rejected", n)
	}
	// Work the pool could never use must not count as delivered to it.
	if d := r.Status().Remainder.DeliveredHs; d != 0 {
		t.Fatalf("unforwardable shares credited %v H/s to the remainder", d)
	}
}

func TestPerIPLimit(t *testing.T) {
	env := startRouter(t, 4)
	for i := 0; i < 4; i++ {
		dialMiner(t, env.addr) // each waits for its subscribe reply
	}
	c, err := net.DialTimeout("tcp", env.addr, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = c.Write([]byte(`{"id":1,"method":"mining.subscribe","params":[]}` + "\n"))
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, 512)
	n, err := c.Read(buf)
	if err == nil {
		t.Fatalf("5th connection should be closed without reply, got %q", buf[:n])
	}
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("5th connection was left open (read timed out) instead of being closed")
	}
}
