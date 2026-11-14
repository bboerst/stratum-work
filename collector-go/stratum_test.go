package main

import (
	"bufio"
	"context"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Fake Stratum server tests for the client (Python Watcher behavior plus #146 timeouts).

var testCB1 = "01000000" + "01" + strings.Repeat("00", 32) + "ffffffff" + "4b0393e20e" + strings.Repeat("00", 8)

func notifyLine(job string) string {
	return `{"id": null, "method": "mining.notify", "params": ["` + job + `", "` + strings.Repeat("11", 32) + `", "` +
		testCB1 + `", "ffffffff", [], "20000000", "1702e5b4", "69d72a43", true]}` + "\n"
}

type fakeConn struct {
	net.Conn
	r *bufio.Reader
}

// readReq reads one request and returns it decoded (fails the test on timeout).
func (f *fakeConn) readReq(t *testing.T) (pyValue, string) {
	t.Helper()
	_ = f.SetReadDeadline(time.Now().Add(5 * time.Second))
	l, err := f.r.ReadString('\n')
	if err != nil {
		t.Fatalf("fake pool: reading request: %v", err)
	}
	v, err := pyLoads([]byte(l))
	if err != nil {
		t.Fatalf("bad request %q", l)
	}
	return v, l
}

func (f *fakeConn) send(t *testing.T, s string) {
	t.Helper()
	if _, err := io.WriteString(f, s); err != nil {
		t.Fatalf("fake pool: write: %v", err)
	}
}

func reqID(v pyValue) string { id, _ := v.get("id"); return id.s }

func subResult(id string) string {
	return `{"id": ` + id + `, "result": [[["mining.notify", "x"]], "abcd1234", 8], "error": null}` + "\n"
}

func authResult(id string) string { return `{"id": ` + id + `, "result": true, "error": null}` + "\n" }

type fakePool struct {
	ln    net.Listener
	conns chan *fakeConn
	n     int
	mu    sync.Mutex
}

func newFakePool(t *testing.T) *fakePool {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &fakePool{ln: ln, conns: make(chan *fakeConn, 16)}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			p.mu.Lock()
			p.n++
			p.mu.Unlock()
			p.conns <- &fakeConn{c, bufio.NewReader(c)}
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return p
}

func (p *fakePool) count() int { p.mu.Lock(); defer p.mu.Unlock(); return p.n }

func (p *fakePool) accept(t *testing.T) *fakeConn {
	t.Helper()
	select {
	case c := <-p.conns:
		t.Cleanup(func() { c.Close() })
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("collector did not connect")
	}
	return nil
}

// handshake answers subscribe and authorize.
func (f *fakeConn) handshake(t *testing.T) {
	t.Helper()
	sub, _ := f.readReq(t)
	f.send(t, subResult(reqID(sub)))
	auth, _ := f.readReq(t)
	f.send(t, authResult(reqID(auth)))
}

func testCollector(t *testing.T, url string, mod func(*StratumConfig)) (*Collector, chan *Document, *Metrics, context.CancelFunc) {
	cfg := StratumConfig{URL: url, UserPass: "user.1:x", PoolName: "Fake", HandshakeTimeout: 2 * time.Second,
		ReadTimeout: 5 * time.Second, RetryDelay: 100 * time.Millisecond}
	if mod != nil {
		mod(&cfg)
	}
	docs := make(chan *Document, 100)
	m := &Metrics{}
	c, err := NewCollector(cfg, quietLog, m, func(d *Document) { docs <- d })
	if err != nil {
		t.Fatal(err)
	}
	return c, docs, m, func() {}
}

func nextDoc(t *testing.T, docs chan *Document) *Document {
	t.Helper()
	select {
	case d := <-docs:
		return d
	case <-time.After(5 * time.Second):
		t.Fatal("no document")
	}
	return nil
}

func poolURL(p *fakePool) string { return "stratum+tcp://" + p.ln.Addr().String() }

func TestHandshakeAndNotificationsInterleavedWithResponses(t *testing.T) {
	pool := newFakePool(t)
	c, docs, m, cancel := testCollector(t, poolURL(pool), nil)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	defer cancel()
	go c.Run(ctx)
	f := pool.accept(t)
	sub, raw := f.readReq(t)
	if raw != `{"id": 1, "method": "mining.subscribe", "params": []}`+"\n" {
		t.Errorf("subscribe bytes %q", raw)
	}
	f.send(t, notifyLine("early1")) // before the subscribe response
	f.send(t, subResult(reqID(sub)))
	auth, raw := f.readReq(t)
	if raw != `{"id": 2, "method": "mining.authorize", "params": ["user.1", "x"]}`+"\n" {
		t.Errorf("authorize bytes %q", raw)
	}
	f.send(t, `{"id": null, "method": "mining.set_difficulty", "params": [1024]}`+"\n"+notifyLine("early2"))
	f.send(t, authResult(reqID(auth)))
	f.send(t, notifyLine("live"))
	for _, want := range []string{"early1", "early2", "live"} {
		d := nextDoc(t, docs)
		if d.Params[pJobID].s != want || d.Extranonce1.s != "abcd1234" || d.Extranonce2Len.s != "8" || d.Height != 975507 {
			t.Errorf("got %s en1=%s", d.Params[pJobID].s, pyDumps(d.Extranonce1))
		}
	}
	if !m.Subscribed.Load() || m.Templates.Load() != 3 {
		t.Error("metrics", m.Subscribed.Load(), m.Templates.Load())
	}
}

func TestPartialLinesAndLinesSharingARead(t *testing.T) {
	pool := newFakePool(t)
	c, docs, m, cancel := testCollector(t, poolURL(pool), nil)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	defer cancel()
	go c.Run(ctx)
	f := pool.accept(t)
	f.handshake(t)
	a, b, cc := notifyLine("A"), notifyLine("B"), notifyLine("C")
	f.send(t, a[:40])
	time.Sleep(60 * time.Millisecond)
	f.send(t, a[40:]+b+cc[:50]) // completes A and B in one segment, starts C
	time.Sleep(60 * time.Millisecond)
	f.send(t, cc[50:])
	da, db, dc := nextDoc(t, docs), nextDoc(t, docs), nextDoc(t, docs)
	if da.Params[0].s != "A" || db.Params[0].s != "B" || dc.Params[0].s != "C" {
		t.Fatal("order")
	}
	if da.TsNs != db.TsNs {
		t.Errorf("A and B were completed by the same read but have different timestamps: %d %d", da.TsNs, db.TsNs)
	}
	if gap := time.Duration(dc.TsNs - db.TsNs); gap < 40*time.Millisecond {
		t.Errorf("C completed ~60 ms later, gap %v", gap)
	}
	if !m.KernelTimestamps.Load() {
		t.Log("kernel receive timestamps unavailable here; the clock fallback was used")
	}
	for _, d := range []*Document{da, db, dc} {
		if lag := time.Duration(d.AppTsNs - d.TsNs); lag < 0 || lag > 50*time.Millisecond {
			t.Errorf("receipt time vs post-read clock: %v", lag)
		}
	}
}

func TestReconnectsAfterThePoolClosesTheConnection(t *testing.T) {
	pool := newFakePool(t)
	c, docs, m, cancel := testCollector(t, poolURL(pool), nil)
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go c.Run(ctx)
	f := pool.accept(t)
	f.handshake(t)
	f.send(t, notifyLine("first"))
	nextDoc(t, docs)
	f.Close()
	f2 := pool.accept(t)
	sub, raw := f2.readReq(t)
	if !strings.Contains(raw, `"id": 3`) { // ids keep counting across reconnects, like Python
		t.Errorf("subscribe after reconnect: %q", raw)
	}
	f2.send(t, subResult(reqID(sub)))
	auth, _ := f2.readReq(t)
	f2.send(t, authResult(reqID(auth)))
	f2.send(t, notifyLine("second"))
	if d := nextDoc(t, docs); d.Params[0].s != "second" {
		t.Error(d.Params[0].s)
	}
	if m.Reconnects.Load() != 1 {
		t.Error("reconnects", m.Reconnects.Load())
	}
}

// #146: a pool that accepts the connection but never answers mining.subscribe is given up on quickly.
func TestHandshakeTimeoutRetries(t *testing.T) {
	pool := newFakePool(t)
	c, _, _, cancel := testCollector(t, poolURL(pool), func(s *StratumConfig) { s.HandshakeTimeout = 300 * time.Millisecond })
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	start := time.Now()
	go c.Run(ctx)
	f := pool.accept(t)
	f.readReq(t) // subscribe, never answered
	pool.accept(t)
	if el := time.Since(start); el > 1500*time.Millisecond {
		t.Errorf("retry took %v", el)
	}
}

// #146: once subscribed, a quiet pool keeps the connection (the read loop has the long timeout).
func TestQuietPoolAfterHandshakeDoesNotReconnect(t *testing.T) {
	pool := newFakePool(t)
	c, docs, _, cancel := testCollector(t, poolURL(pool), func(s *StratumConfig) {
		s.HandshakeTimeout = 200 * time.Millisecond
		s.ReadTimeout = 5 * time.Second
	})
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go c.Run(ctx)
	f := pool.accept(t)
	f.handshake(t)
	time.Sleep(time.Second)
	f.send(t, notifyLine("late"))
	if d := nextDoc(t, docs); d.Params[0].s != "late" || pool.count() != 1 {
		t.Error("reconnected", pool.count())
	}
}

func TestReadTimeoutReconnects(t *testing.T) {
	pool := newFakePool(t)
	c, _, m, cancel := testCollector(t, poolURL(pool), func(s *StratumConfig) { s.ReadTimeout = 300 * time.Millisecond })
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go c.Run(ctx)
	pool.accept(t).handshake(t)
	pool.accept(t)
	if m.Reconnects.Load() < 1 {
		t.Error("no reconnect")
	}
}

func TestLatencyProbesAreResolvedAndNotProcessed(t *testing.T) {
	pool := newFakePool(t)
	c, docs, m, cancel := testCollector(t, poolURL(pool), func(s *StratumConfig) { s.ProbeInterval = 200 * time.Millisecond })
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go c.Run(ctx)
	f := pool.accept(t)
	f.handshake(t)
	for i := 0; i < 2; i++ { // two probes: answered after 20 ms
		probe, raw := f.readReq(t)
		if !strings.Contains(raw, `"method": "mining.subscribe"`) {
			t.Fatalf("expected a probe, got %q", raw)
		}
		time.Sleep(20 * time.Millisecond)
		f.send(t, subResult(reqID(probe)))
	}
	f.send(t, notifyLine("after-probes"))
	d := nextDoc(t, docs)
	if d.Params[0].s != "after-probes" || !d.HasLatency {
		t.Fatalf("%s latency=%v", d.Params[0].s, d.HasLatency)
	}
	if d.LatencyMethod != "tcp" && d.LatencyMethod != "app" || d.LatencyMs <= 0 || d.LatencyMs > 1000 {
		t.Errorf("latency %v %s", d.LatencyMs, d.LatencyMethod)
	}
	if m.Templates.Load() != 1 {
		t.Error("probe responses were processed as notifications")
	}
}

func TestProbesUseAppLatencyThroughAProxyOnly(t *testing.T) {
	tr := NewLatencyTracker(true)
	tr.RecordTCPRTTUs(500, true)
	tr.RecordSend(1, 0)
	tr.TryResolve(idMsg(1), ms(40))
	if e := tr.Estimate(); e.method != "app" || e.ms != 20 {
		t.Error(e)
	}
}

func TestKeepAliveResubscribes(t *testing.T) {
	pool := newFakePool(t)
	c, docs, _, cancel := testCollector(t, poolURL(pool), func(s *StratumConfig) {
		s.KeepAlive, s.KeepAliveEvery = true, 300*time.Millisecond
	})
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go c.Run(ctx)
	f := pool.accept(t)
	f.handshake(t)
	ka, raw := f.readReq(t)
	if !strings.Contains(raw, "mining.subscribe") {
		t.Fatal(raw)
	}
	f.send(t, subResult(reqID(ka))) // consumed by id, not a notification
	f.send(t, notifyLine("n"))
	if d := nextDoc(t, docs); d.Params[0].s != "n" {
		t.Error(d.Params[0].s)
	}
}

func TestMalformedNotifyIsSkippedWithoutReconnecting(t *testing.T) {
	pool := newFakePool(t)
	c, docs, m, cancel := testCollector(t, poolURL(pool), nil)
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go c.Run(ctx)
	f := pool.accept(t)
	f.handshake(t)
	f.send(t, `{"id": null, "method": "mining.notify", "params": ["short"]}`+"\n"+"not json\n"+notifyLine("ok"))
	if d := nextDoc(t, docs); d.Params[0].s != "ok" || m.NotifyMalformed.Load() != 1 || pool.count() != 1 {
		t.Error("malformed handling")
	}
}

func TestUserAgentAndUserpassSplit(t *testing.T) {
	ua := "cgminer/4.12.1"
	pool := newFakePool(t)
	c, _, _, cancel := testCollector(t, poolURL(pool), func(s *StratumConfig) {
		s.UserAgent, s.UserPass = &ua, "worker.001"
	})
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go c.Run(ctx)
	f := pool.accept(t)
	sub, raw := f.readReq(t)
	if !strings.Contains(raw, `"params": ["cgminer/4.12.1"]`) {
		t.Error(raw)
	}
	f.send(t, subResult(reqID(sub)))
	_, raw = f.readReq(t)
	if !strings.Contains(raw, `"params": ["worker.001"]}`) { // Python: "worker.001".split(":") -> one element
		t.Error(raw)
	}
}

func TestParseStratumURL(t *testing.T) {
	for _, bad := range []string{"tcp://h:1", "stratum+tcp://h", "stratum+tcp://:1", "stratum+tcp://h:1/x", "stratum+tcp://h:99999"} {
		if _, _, err := parseStratumURL(bad); err == nil {
			t.Error(bad)
		}
	}
	if h, p, err := parseStratumURL("stratum+tcp://Pool.Example:3333"); err != nil || h != "Pool.Example" || p != 3333 {
		t.Error(h, p, err)
	}
}

// ── SOCKS5 ───────────────────────────────────────────────────────────────────────────────────────────────────────

// fakeSOCKS5 accepts one CONNECT, records the request and forwards to target.
func fakeSOCKS5(t *testing.T, target string, reqs chan []byte) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				buf := make([]byte, 3)
				if _, err := io.ReadFull(c, buf); err != nil {
					return
				}
				_, _ = c.Write([]byte{5, 0})
				hdr := make([]byte, 4)
				_, _ = io.ReadFull(c, hdr)
				var addr []byte
				switch hdr[3] {
				case 1:
					addr = make([]byte, 4)
				case 4:
					addr = make([]byte, 16)
				case 3:
					l := make([]byte, 1)
					_, _ = io.ReadFull(c, l)
					addr = append(l, make([]byte, l[0])...)
					_, _ = io.ReadFull(c, addr[1:])
					addr = addr[:]
				}
				if hdr[3] != 3 {
					_, _ = io.ReadFull(c, addr)
				}
				port := make([]byte, 2)
				_, _ = io.ReadFull(c, port)
				reqs <- append(append(hdr, addr...), port...)
				up, err := net.Dial("tcp", target)
				if err != nil {
					_, _ = c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
					return
				}
				defer up.Close()
				_, _ = c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
				go func() { _, _ = io.Copy(up, c) }()
				_, _ = io.Copy(c, up)
			}(c)
		}
	}()
	return ln.Addr().String()
}

func TestCollectsThroughASOCKS5Proxy(t *testing.T) {
	pool := newFakePool(t)
	reqs := make(chan []byte, 4)
	proxy := fakeSOCKS5(t, pool.ln.Addr().String(), reqs)
	ph, pp, _ := net.SplitHostPort(proxy)
	port, _ := strconv.Atoi(pp)
	_, poolPort, _ := net.SplitHostPort(pool.ln.Addr().String())
	c, docs, m, cancel := testCollector(t, "stratum+tcp://pool.invalid:"+poolPort, func(s *StratumConfig) {
		s.UseProxy, s.ProxyHost, s.ProxyPort = true, ph, port
	})
	defer cancel()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go c.Run(ctx)
	f := pool.accept(t)
	req := <-reqs
	if req[1] != 1 || req[3] != 3 || string(req[5:5+req[4]]) != "pool.invalid" { // CONNECT by name (rdns)
		t.Errorf("socks request % x", req)
	}
	f.handshake(t)
	f.send(t, notifyLine("via-proxy"))
	d := nextDoc(t, docs)
	if d.Params[0].s != "via-proxy" {
		t.Error(d.Params[0].s)
	}
	if !m.KernelTimestamps.Load() {
		t.Log("kernel timestamps unavailable on the proxied socket here")
	}
	if d.HasLatency && d.LatencyMethod != "app" { // tcp RTT would only measure the local hop
		t.Error("tcp latency through a proxy")
	}
}

func TestSOCKS5HandshakeErrors(t *testing.T) {
	for _, reply := range [][]byte{{5, 2}, {4, 0}, {5, 0, 5, 5, 0, 1, 0, 0, 0, 0, 0, 0}} {
		a, b := net.Pipe()
		go func() {
			buf := make([]byte, 64)
			_, _ = b.Read(buf)
			_, _ = b.Write(reply[:2])
			if len(reply) > 2 {
				_, _ = b.Read(buf)
				_, _ = b.Write(reply[2:])
			}
			b.Close()
		}()
		if err := socks5Handshake(a, "10.0.0.1", 3333); err == nil {
			t.Errorf("reply % x: expected an error", reply)
		}
		a.Close()
	}
}

// ── miner-relay mode ─────────────────────────────────────────────────────────────────────────────────────────────

func TestRelayBetweenMinerAndPool(t *testing.T) {
	pool := newFakePool(t)
	c, docs, m, cancel := testCollector(t, poolURL(pool), nil)
	defer cancel()
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = c.RunRelay(ctx, addr) }()
	var miner net.Conn
	var err error
	for i := 0; i < 50; i++ {
		if miner, err = net.Dial("tcp", addr); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer miner.Close()
	mr := bufio.NewReader(miner)
	readMiner := func() string {
		_ = miner.SetReadDeadline(time.Now().Add(5 * time.Second))
		l, err := mr.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		return l
	}
	f := pool.accept(t)
	// the miner does the handshake; the relay forwards it unchanged
	sub := `{"id": 7, "method": "mining.subscribe", "params": ["miner/1.0"]}` + "\n"
	_, _ = io.WriteString(miner, sub+"\n") // the empty line is not forwarded (Python skips empty lines)
	if _, raw := f.readReq(t); raw != sub {
		t.Errorf("pool got %q", raw)
	}
	f.send(t, `{"id": 7, "result": [[], "f00d", 4], "error": null}`+"\n")
	if l := readMiner(); !strings.Contains(l, `"f00d"`) {
		t.Error(l)
	}
	f.send(t, notifyLine("relayed")+"garbage line\n")
	if l := readMiner(); !strings.Contains(l, `"relayed"`) {
		t.Error(l)
	}
	if l := readMiner(); l != "garbage line\n" { // undecodable pool lines are still relayed
		t.Error(l)
	}
	d := nextDoc(t, docs)
	if d.Params[0].s != "relayed" || d.Extranonce1.s != "f00d" || d.Extranonce2Len.s != "4" || !m.Subscribed.Load() {
		t.Errorf("doc %s en1 %s", d.Params[0].s, pyDumps(d.Extranonce1))
	}
	share := `{"id": 8, "method": "mining.submit", "params": ["w", "j", "00", "00", "00"]}` + "\n"
	_, _ = io.WriteString(miner, share)
	if _, raw := f.readReq(t); raw != share {
		t.Error(raw)
	}
	// the miner leaves: the pool connection is closed too, and the next miner gets a fresh one
	miner.Close()
	_ = f.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := f.r.ReadString('\n'); err == nil {
		t.Error("pool connection not closed after the miner left")
	}
	miner2, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer miner2.Close()
	pool.accept(t)
}

// A miner that stops reading must not stall collection: the relay queue fills, the session ends, and the pool's
// notifications up to that point were all collected.
func TestRelayMinerNotReadingDoesNotBlockCollection(t *testing.T) {
	pool := newFakePool(t)
	c, docs, _, cancel := testCollector(t, poolURL(pool), nil)
	defer cancel()
	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go func() { _ = c.RunRelay(ctx, addr) }()
	var miner net.Conn
	for i := 0; i < 50; i++ {
		var err error
		if miner, err = net.Dial("tcp", addr); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer miner.Close()
	if tc, ok := miner.(*net.TCPConn); ok {
		_ = tc.SetReadBuffer(4096)
	}
	f := pool.accept(t)
	go func() {
		for i := 0; i < 20000; i++ {
			if _, err := io.WriteString(f, notifyLine(strconv.Itoa(i))); err != nil {
				return
			}
		}
	}()
	got := 0
	deadline := time.After(10 * time.Second)
	for got < 4096 {
		select {
		case <-docs:
			got++
		case <-deadline:
			t.Fatalf("collection stalled after %d documents", got)
		}
	}
}
