package upstream

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/bboerst/stratum-work/router/internal/stratum"
	"github.com/bboerst/stratum-work/router/internal/work"
)

const waitTimeout = 3 * time.Second

type submitRes struct {
	reqID    uint64
	accepted bool
	reason   string
}

type recEvents struct {
	jobs    chan work.Job
	diffs   chan float64
	states  chan bool
	submits chan submitRes
}

func newRec() *recEvents {
	return &recEvents{
		jobs:    make(chan work.Job, 64),
		diffs:   make(chan float64, 64),
		states:  make(chan bool, 64),
		submits: make(chan submitRes, 64),
	}
}

func (r *recEvents) OnJob(_ string, j work.Job)       { r.jobs <- j }
func (r *recEvents) OnDifficulty(_ string, d float64) { r.diffs <- d }
func (r *recEvents) OnState(_ string, connected bool) { r.states <- connected }
func (r *recEvents) OnSubmitResult(_ string, id uint64, ok bool, reason string) {
	r.submits <- submitRes{id, ok, reason}
}

func recv[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(waitTimeout):
		t.Fatalf("timeout waiting for %s", what)
	}
	var zero T
	return zero
}

type fakePool struct {
	ln    net.Listener
	conns chan *stratum.Conn
	reqs  chan *stratum.Message
	mu    sync.Mutex
	order []string
	// sessions counts accepted connections. When failConfigureFrom > 0,
	// sessions numbered >= it answer configure with an error and subscribe
	// with en1 "0badf00d", en2size 6.
	sessions          int
	failConfigureFrom int
}

func newFakePool(t *testing.T) *fakePool {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &fakePool{ln: ln, conns: make(chan *stratum.Conn, 8), reqs: make(chan *stratum.Message, 64)}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			sc := stratum.NewConn(c)
			p.conns <- sc
			go p.serve(sc)
		}
	}()
	return p
}

func (p *fakePool) addr() string { return p.ln.Addr().String() }

func (p *fakePool) setFailConfigureFrom(n int) {
	p.mu.Lock()
	p.failConfigureFrom = n
	p.mu.Unlock()
}

func (p *fakePool) serve(c *stratum.Conn) {
	defer c.Close()
	p.mu.Lock()
	p.sessions++
	degraded := p.failConfigureFrom > 0 && p.sessions >= p.failConfigureFrom
	p.mu.Unlock()
	for {
		m, err := c.Read()
		if err != nil {
			return
		}
		p.mu.Lock()
		p.order = append(p.order, m.Method)
		p.mu.Unlock()
		switch m.Method {
		case "mining.configure":
			if degraded {
				_ = c.Write(stratum.Response(m.ID, nil, []any{20, "Method not found", nil}))
				continue
			}
			_ = c.Write(stratum.Response(m.ID, map[string]any{"version-rolling": true, "version-rolling.mask": "1fffe000"}, nil))
		case "mining.subscribe":
			if degraded {
				_ = c.Write(stratum.Response(m.ID, []any{[]any{}, "0badf00d", 6}, nil))
				continue
			}
			_ = c.Write(stratum.Response(m.ID, []any{[]any{[]any{"mining.notify", "sub1"}}, "a1b2c3d4", 8}, nil))
		case "mining.authorize":
			_ = c.Write(stratum.Response(m.ID, true, nil))
		case "mining.submit":
			p.reqs <- m
			var params []any
			_ = json.Unmarshal(m.Params, &params)
			if len(params) > 4 && params[4] == "bad" {
				_ = c.Write(stratum.Response(m.ID, nil, []any{23, "Low difficulty share", nil}))
			} else {
				_ = c.Write(stratum.Response(m.ID, true, nil))
			}
		}
	}
}

func notifyMsg(jobID string, clean bool) map[string]any {
	prev := "00000000000000000000000000000000000000000000000000000000000000ab"
	return stratum.Notify("mining.notify", jobID, prev, "01000000", "ffffffff", []string{}, "20000000", "1703a30c", "66000000", clean)
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func startClient(t *testing.T, addr string, ev Events) *Client {
	t.Helper()
	c := New("t1", addr, "user.worker", "s3cret", ev, quietLog())
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.Run(ctx); close(done) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(waitTimeout):
			t.Error("Run did not return after cancel")
		}
	})
	return c
}

func TestClientHandshakeNotifySubmit(t *testing.T) {
	pool := newFakePool(t)
	ev := newRec()
	c := startClient(t, pool.addr(), ev)

	conn := recv(t, pool.conns, "connection")
	if !recv(t, ev.states, "state") {
		t.Fatal("expected connected=true")
	}
	pool.mu.Lock()
	order := append([]string(nil), pool.order...)
	pool.mu.Unlock()
	want := []string{"mining.configure", "mining.subscribe", "mining.authorize"}
	if len(order) != 3 {
		t.Fatalf("order = %v", order)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}

	if err := conn.Write(stratum.Notify("mining.set_difficulty", 65536)); err != nil {
		t.Fatal(err)
	}
	if d := recv(t, ev.diffs, "difficulty"); d != 65536 {
		t.Fatalf("diff = %v", d)
	}
	if err := conn.Write(notifyMsg("j1", false)); err != nil {
		t.Fatal(err)
	}
	j := recv(t, ev.jobs, "job")
	if j.UpstreamID != "j1" || j.Version != 0x20000000 || j.NBits != "1703a30c" || j.Coinb1 != "01000000" {
		t.Fatalf("job = %+v", j)
	}

	st := c.State()
	if st.En1 != "a1b2c3d4" || st.En2Size != 8 || st.VersionMask != 0x1fffe000 || st.Difficulty != 65536 || !st.Connected {
		t.Fatalf("state = %+v", st)
	}
	if len(st.Jobs) != 1 {
		t.Fatalf("jobs = %d", len(st.Jobs))
	}

	_ = conn.Write(notifyMsg("j2", false))
	recv(t, ev.jobs, "job j2")
	if st := c.State(); len(st.Jobs) != 2 || st.Jobs[0].UpstreamID != "j2" {
		t.Fatalf("jobs after j2 = %+v", st.Jobs)
	}
	_ = conn.Write(notifyMsg("j3", true))
	recv(t, ev.jobs, "job j3")
	if st := c.State(); len(st.Jobs) != 1 || st.Jobs[0].UpstreamID != "j3" || !st.Jobs[0].Clean {
		t.Fatalf("jobs after clean = %+v", st.Jobs)
	}

	v := uint32(0x00002000)
	id, err := c.Submit("user.worker", "j3", "0000000000000001", "66000000", "deadbeef", &v)
	if err != nil {
		t.Fatal(err)
	}
	sub := recv(t, pool.reqs, "submit request")
	var params []any
	if err := json.Unmarshal(sub.Params, &params); err != nil {
		t.Fatal(err)
	}
	if len(params) != 6 || params[0] != "user.worker" || params[1] != "j3" || params[5] != "00002000" {
		t.Fatalf("submit params = %v", params)
	}
	res := recv(t, ev.submits, "submit result")
	if res.reqID != id || !res.accepted {
		t.Fatalf("submit result = %+v (id %d)", res, id)
	}

	id2, err := c.Submit("user.worker", "j3", "0000000000000002", "66000000", "bad", nil)
	if err != nil {
		t.Fatal(err)
	}
	sub = recv(t, pool.reqs, "submit request 2")
	params = nil
	_ = json.Unmarshal(sub.Params, &params)
	if len(params) != 5 {
		t.Fatalf("submit params without version = %v", params)
	}
	res = recv(t, ev.submits, "submit result 2")
	if res.reqID != id2 || res.accepted || res.reason != "Low difficulty share" {
		t.Fatalf("rejected result = %+v", res)
	}
}

func TestClientSetExtranonceAndVersionMask(t *testing.T) {
	pool := newFakePool(t)
	ev := newRec()
	c := startClient(t, pool.addr(), ev)
	conn := recv(t, pool.conns, "connection")
	recv(t, ev.states, "state")

	_ = conn.Write(stratum.Notify("mining.set_extranonce", "ffee", 4))
	_ = conn.Write(stratum.Notify("mining.set_version_mask", "00ffe000"))
	// A difficulty notification after both acts as a barrier: messages are processed in order.
	_ = conn.Write(stratum.Notify("mining.set_difficulty", 2))
	recv(t, ev.diffs, "difficulty")
	st := c.State()
	if st.En1 != "ffee" || st.En2Size != 4 || st.VersionMask != 0x00ffe000 {
		t.Fatalf("state = %+v", st)
	}
}

func TestClientReconnectClearsState(t *testing.T) {
	pool := newFakePool(t)
	ev := newRec()
	c := startClient(t, pool.addr(), ev)
	conn := recv(t, pool.conns, "connection")
	recv(t, ev.states, "state")
	_ = conn.Write(notifyMsg("j1", false))
	recv(t, ev.jobs, "job")

	conn.Close()
	if recv(t, ev.states, "disconnect state") {
		t.Fatal("expected connected=false")
	}
	if st := c.State(); st.Connected || len(st.Jobs) != 0 {
		t.Fatalf("state after disconnect = %+v", st)
	}
	if _, err := c.Submit("w", "j1", "00", "00", "00", nil); err == nil {
		t.Fatal("expected submit error when disconnected")
	}
	// Reconnects after ~1s backoff.
	recv(t, pool.conns, "reconnection")
	if !recv(t, ev.states, "reconnected state") {
		t.Fatal("expected connected=true after reconnect")
	}
}

func TestClientReconnectResetsNegotiatedState(t *testing.T) {
	pool := newFakePool(t)
	ev := newRec()
	c := startClient(t, pool.addr(), ev)
	conn := recv(t, pool.conns, "connection")
	recv(t, ev.states, "state")
	_ = conn.Write(stratum.Notify("mining.set_difficulty", 1024))
	recv(t, ev.diffs, "difficulty")
	if st := c.State(); st.VersionMask != 0x1fffe000 || st.En1 != "a1b2c3d4" || st.Difficulty != 1024 {
		t.Fatalf("first session state = %+v", st)
	}

	pool.setFailConfigureFrom(2)
	conn.Close()
	if recv(t, ev.states, "disconnect") {
		t.Fatal("expected connected=false")
	}
	if st := c.State(); st.Connected || len(st.Jobs) != 0 || (st.VersionMask != 0 || st.En1 != "" || st.En2Size != 0 || st.Difficulty != 0) {
		t.Fatalf("state after disconnect = %+v", st)
	}
	recv(t, pool.conns, "reconnection")
	if !recv(t, ev.states, "re-authorized") {
		t.Fatal("expected connected=true")
	}
	st := c.State()
	if st.VersionMask != 0 || st.En1 != "0badf00d" || st.En2Size != 6 || st.Difficulty != 0 || !st.Connected {
		t.Fatalf("second session state = %+v", st)
	}
}

func TestClientJobCap(t *testing.T) {
	pool := newFakePool(t)
	ev := newRec()
	c := startClient(t, pool.addr(), ev)
	conn := recv(t, pool.conns, "connection")
	recv(t, ev.states, "state")
	for i := 0; i < 20; i++ {
		_ = conn.Write(notifyMsg(fmt.Sprintf("j%d", i), false))
		recv(t, ev.jobs, "job")
	}
	st := c.State()
	if len(st.Jobs) != 16 {
		t.Fatalf("jobs = %d, want 16", len(st.Jobs))
	}
	if st.Jobs[0].UpstreamID != "j19" || st.Jobs[15].UpstreamID != "j4" {
		t.Fatalf("job order: first %s last %s", st.Jobs[0].UpstreamID, st.Jobs[15].UpstreamID)
	}
}

// Submits racing a disconnect: every id handed back by Submit gets exactly one
// OnSubmitResult, and no result is ever reported for a Submit that returned an error.
func TestClientSubmitDisconnectExactlyOnce(t *testing.T) {
	pool := newFakePool(t)
	ev := newRec()
	c := startClient(t, pool.addr(), ev)
	conn := recv(t, pool.conns, "connection")
	recv(t, ev.states, "state")

	const n = 50
	var mu sync.Mutex
	returned := map[uint64]bool{}
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			id, err := c.Submit("w", "j", "00", "00", "00000000", nil)
			if err == nil {
				mu.Lock()
				returned[id] = true
				mu.Unlock()
			}
		}()
	}
	close(start)
	conn.Close()
	wg.Wait()
	// OnState(false) fires after pending submits are drained.
	for {
		if !recv(t, ev.states, "disconnect") {
			break
		}
	}
	seen := map[uint64]int{}
	for done := false; !done; {
		select {
		case r := <-ev.submits:
			seen[r.reqID]++
		default:
			done = true
		}
	}
	for id, k := range seen {
		if k != 1 {
			t.Fatalf("id %d reported %d times", id, k)
		}
		if !returned[id] {
			t.Fatalf("id %d reported but Submit returned an error", id)
		}
	}
	for id := range returned {
		if seen[id] != 1 {
			t.Fatalf("id %d returned by Submit but reported %d times", id, seen[id])
		}
	}
}
