package main

import (
	"context"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-zeromq/zmq4"
)

// Tip state: initial RPC + ZMQ-triggered getblockcount (Python listen_for_btc_tip_updates), https with a CA file.

func rpcServer(t *testing.T, height *atomic.Int64, tlsSrv bool) (*httptest.Server, *atomic.Value) {
	var auth atomic.Value
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, _ := r.BasicAuth()
		auth.Store(u + ":" + p)
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"getblockcount"`) {
			w.WriteHeader(500)
			return
		}
		_, _ = w.Write([]byte(`{"result": ` + itoa(height.Load()) + `, "error": null, "id": "tip"}`))
	})
	var srv *httptest.Server
	if tlsSrv {
		srv = httptest.NewTLSServer(h)
	} else {
		srv = httptest.NewServer(h)
	}
	t.Cleanup(srv.Close)
	return srv, &auth
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestRPCBlockCountHTTP(t *testing.T) {
	var h atomic.Int64
	h.Store(975_506)
	srv, auth := rpcServer(t, &h, false)
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	rpc, err := NewRPC("http", host, port, "rpcuser", "rpcpass", "", 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := rpc.BlockCount(context.Background()); err != nil || got != 975_506 || auth.Load() != "rpcuser:rpcpass" {
		t.Error(got, err)
	}
}

func TestRPCHTTPSVerifiesAgainstTheCAFile(t *testing.T) {
	var h atomic.Int64
	h.Store(202)
	srv, _ := rpcServer(t, &h, true)
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "https://"))
	ca := filepath.Join(t.TempDir(), "ca.pem")
	_ = os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}), 0o600)
	rpc, err := NewRPC("https", host, port, "u", "p", ca, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := rpc.BlockCount(context.Background()); err != nil || got != 202 {
		t.Error(got, err)
	}
	// without the CA file: the system trust store doesn't know the test CA, so verification fails (never skipped)
	rpc2, _ := NewRPC("https", host, port, "u", "p", "", 3*time.Second)
	if _, err := rpc2.BlockCount(context.Background()); err == nil {
		t.Error("expected a certificate verification error")
	}
	if _, err := NewRPC("https", host, port, "u", "p", filepath.Join(t.TempDir(), "missing.pem"), time.Second); err == nil {
		t.Error("expected an error for a missing CA file")
	}
}

func TestTipStaleness(t *testing.T) {
	ts := NewTipState(60 * time.Second)
	if _, ok := ts.Current(); ok {
		t.Error("unknown tip must not be usable")
	}
	ts2 := tipAt(100, 60*time.Second, 60*time.Second)
	if h, ok := ts2.Current(); !ok || h != 100 { // age == stale_after: still usable (Python <=)
		t.Error("boundary")
	}
	if _, ok := tipAt(100, 61*time.Second, 60*time.Second).Current(); ok {
		t.Error("stale tip used")
	}
}

func freePort(t *testing.T) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().String()
}

// ZMQ block notifications trigger getblockcount, and the subscription survives a node restart.
func TestZMQBlockNotificationsUpdateTheTip(t *testing.T) {
	var h atomic.Int64
	h.Store(100)
	srv, _ := rpcServer(t, &h, false)
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	rpc, _ := NewRPC("http", host, port, "u", "p", "", 2*time.Second)
	endpoint := "tcp://" + freePort(t)
	tip := NewTipState(time.Hour)
	var updates atomic.Int64
	f := &TipFollower{Tip: tip, RPC: rpc, Endpoint: endpoint, Retry: 200 * time.Millisecond, log: quietLog,
		Updates: func() { updates.Add(1) }}
	f.Init(context.Background())
	if got, ok := tip.Current(); !ok || got != 100 {
		t.Fatal("initial tip", got)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	publishUntil := func(height int64) {
		t.Helper()
		pctx, pcancel := context.WithCancel(context.Background())
		defer pcancel()
		pub := zmq4.NewPub(pctx)
		defer pub.Close()
		if err := pub.Listen(endpoint); err != nil {
			t.Fatal(err)
		}
		h.Store(height)
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			_ = pub.Send(zmq4.NewMsgFrom([]byte("hashblock"), make([]byte, 32), []byte{1, 0, 0, 0}))
			if got, _ := tip.Current(); got == height {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("tip not updated to %d", height)
	}
	go f.Run(ctx)
	publishUntil(101)
	publishUntil(102) // a new publisher on the same endpoint: the node restarted
	if updates.Load() < 2 {
		t.Error(updates.Load())
	}
}

// Each RPC call uses its own connection: a kept-alive one may have been closed by the node (-rpcservertimeout) without
// the client seeing it, behind NAT or a proxy.
func TestRPCDoesNotReuseConnections(t *testing.T) {
	var h atomic.Int64
	h.Store(1)
	var conns atomic.Int64
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"result": 1, "error": null, "id": "tip"}`))
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			conns.Add(1)
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	rpc, _ := NewRPC("http", host, port, "u", "p", "", 2*time.Second)
	for i := 0; i < 3; i++ {
		if _, err := rpc.BlockCount(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if got := conns.Load(); got != 3 {
		t.Errorf("connections = %d, want 3 (one per call)", got)
	}
}

// A failed getblockcount after a block is retried, so the tip doesn't stay stale until the next block.
func TestTipUpdateRetriesAfterFailure(t *testing.T) {
	old := tipRetryDelays
	tipRetryDelays = []time.Duration{10 * time.Millisecond, 10 * time.Millisecond, 10 * time.Millisecond}
	t.Cleanup(func() { tipRetryDelays = old })
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) <= 2 {
			w.WriteHeader(500)
			return
		}
		_, _ = w.Write([]byte(`{"result": 200, "error": null, "id": "tip"}`))
	}))
	t.Cleanup(srv.Close)
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	rpc, _ := NewRPC("http", host, port, "u", "p", "", 2*time.Second)
	tip := NewTipState(time.Hour)
	f := &TipFollower{Tip: tip, RPC: rpc, log: quietLog}
	f.update(context.Background())
	if got, ok := tip.Current(); !ok || got != 200 || calls.Load() != 3 {
		t.Errorf("tip %d ok=%v calls=%d", got, ok, calls.Load())
	}

	// Every attempt fails: give up after the last delay (the next block tries again).
	calls.Store(-100)
	tip2 := NewTipState(time.Hour)
	f2 := &TipFollower{Tip: tip2, RPC: rpc, log: quietLog}
	f2.update(context.Background())
	if _, ok := tip2.Current(); ok || calls.Load() != -100+int64(len(tipRetryDelays))+1 {
		t.Errorf("ok=%v calls=%d", ok, calls.Load())
	}
}
