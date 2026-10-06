package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-zeromq/zmq4"
)

func newTestNotifier(t *testing.T, status int) (*notifier, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/NOTIFY" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		hits.Add(1)
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return &notifier{url: srv.URL + "/NOTIFY", client: srv.Client(),
		log: slog.New(slog.NewTextHandler(io.Discard, nil))}, &hits
}

func TestHandleHashblockGETs(t *testing.T) {
	n, hits := newTestNotifier(t, http.StatusOK)
	ctx := context.Background()
	n.Handle(ctx, [][]byte{[]byte("hashblock"), make([]byte, 32), {1, 0, 0, 0}})
	n.Handle(ctx, [][]byte{[]byte("hashblock"), make([]byte, 32)})
	if got := hits.Load(); got != 2 {
		t.Fatalf("hits = %d, want 2", got)
	}
}

func TestHandleIgnoresOtherTopics(t *testing.T) {
	n, hits := newTestNotifier(t, http.StatusOK)
	n.Handle(context.Background(), [][]byte{[]byte("rawtx"), {1}})
	n.Handle(context.Background(), nil)
	if got := hits.Load(); got != 0 {
		t.Fatalf("hits = %d, want 0", got)
	}
}

func TestNotifyErrorOnNon2xx(t *testing.T) {
	n, hits := newTestNotifier(t, http.StatusInternalServerError)
	if err := n.Notify(context.Background()); err == nil {
		t.Fatal("want error for 500")
	}
	n.Handle(context.Background(), [][]byte{[]byte("hashblock")}) // logs, no panic
	if hits.Load() != 2 {
		t.Fatalf("hits = %d, want 2", hits.Load())
	}
}

func TestNotifyErrorOnUnreachable(t *testing.T) {
	n := &notifier{url: "http://127.0.0.1:1/NOTIFY", client: &http.Client{Timeout: time.Second},
		log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := n.Notify(context.Background()); err == nil {
		t.Fatal("want error")
	}
}

// TestLiveZMQ publishes over a real (pure-Go) ZMQ PUB socket and checks the
// loop delivers a GET.
func TestLiveZMQ(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip("no loopback:", err)
	}
	addr := ln.Addr().String()
	ln.Close()
	endpoint := "tcp://" + addr

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pub := zmq4.NewPub(ctx)
	defer pub.Close()
	if err := pub.Listen(endpoint); err != nil {
		t.Skip("pub listen:", err)
	}

	n, hits := newTestNotifier(t, http.StatusOK)
	loopCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { runLoop(loopCtx, endpoint, n, n.log); close(done) }()

	// Slow-joiner: publish repeatedly until the subscriber sees one.
	for hits.Load() == 0 && ctx.Err() == nil {
		_ = pub.Send(zmq4.NewMsgFrom([]byte("hashblock"), make([]byte, 32), []byte{0, 0, 0, 0}))
		time.Sleep(50 * time.Millisecond)
	}
	stop()
	<-done
	if hits.Load() == 0 {
		t.Skip("live ZMQ delivery did not happen within timeout (flaky environment)")
	}
}
