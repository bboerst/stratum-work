package publish

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/bboerst/stratum-work/router/internal/router"
)

type fakePub struct {
	mu   sync.Mutex
	msgs [][]byte
	err  error
}

func (f *fakePub) Publish(status any) error {
	b, err := json.Marshal(status)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgs = append(f.msgs, b)
	return f.err
}

func (f *fakePub) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.msgs)
}

func sampleStatus(since time.Time) router.Status {
	return router.Status{
		Site:    "us-ash-1",
		TotalHs: 59.8e12,
		Targets: []router.TargetStatus{
			{ID: "antpool", Pool: "AntPool", TargetHs: 3e12, DeliveredHs: 2.9e12, Available: true},
		},
		Remainder: router.RemainderStatus{ID: "datum", DeliveredHs: 15.1e12},
		Workers: []router.WorkerStatus{
			{Name: "brian-avalon", Hs: 59.8e12, Since: since, WorkSeconds: 3600},
			{Name: "newbie", Hs: 1e12, Since: since, WorkSeconds: 60},
		},
		Connections: []router.ConnStatus{{ID: 1, Worker: "brian-avalon"}},
	}
}

func TestBuildRoutingJSON(t *testing.T) {
	now := time.Unix(1790000000, 123456789)
	since := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	msg := BuildRouting(sampleStatus(since), now, 10*time.Minute)

	fp := &fakePub{}
	if err := fp.Publish(msg); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(fp.msgs[0], &got); err != nil {
		t.Fatal(err)
	}
	if got["type"] != "routing" {
		t.Fatalf("type = %v", got["type"])
	}
	ts, _ := got["timestamp"].(string)
	n, err := strconv.ParseInt(ts, 16, 64)
	if err != nil || n != now.UnixNano() {
		t.Fatalf("timestamp %q parse=%d err=%v", ts, n, err)
	}
	if ts != strconv.FormatInt(now.UnixNano(), 16) {
		t.Fatalf("timestamp not lowercase hex: %q", ts)
	}
	if got["site"] != "us-ash-1" {
		t.Fatalf("site = %v", got["site"])
	}
	if got["total_ths"].(float64) != 59.8 {
		t.Fatalf("total_ths = %v", got["total_ths"])
	}
	tg := got["targets"].([]any)[0].(map[string]any)
	if tg["id"] != "antpool" || tg["pool"] != "AntPool" || tg["target_ths"].(float64) != 3 ||
		tg["delivered_ths"].(float64) != 2.9 || tg["available"] != true {
		t.Fatalf("target = %v", tg)
	}
	rem := got["remainder"].(map[string]any)
	if rem["id"] != "datum" || rem["delivered_ths"].(float64) != 15.1 || rem["fallback_active"] != false {
		t.Fatalf("remainder = %v", rem)
	}
	ws := got["workers"].([]any)
	if len(ws) != 1 {
		t.Fatalf("workers = %v (want only brian-avalon)", ws)
	}
	w := ws[0].(map[string]any)
	if w["name"] != "brian-avalon" || w["ths"].(float64) != 59.8 || w["since"] != "2026-09-29T12:00:00Z" {
		t.Fatalf("worker = %v", w)
	}
	if _, ok := got["connections"]; ok {
		t.Fatal("routing message must not include connections")
	}
}

func TestBuildRoutingEmptyArrays(t *testing.T) {
	msg := BuildRouting(router.Status{Site: "x"}, time.Now(), time.Minute)
	b, _ := json.Marshal(msg)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	if _, ok := got["targets"].([]any); !ok {
		t.Fatalf("targets should be [] not null: %s", b)
	}
	if _, ok := got["workers"].([]any); !ok {
		t.Fatalf("workers should be [] not null: %s", b)
	}
}

func TestLoopPublishesPeriodically(t *testing.T) {
	fp := &fakePub{err: errors.New("disconnected")} // errors must not stop the loop
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	src := func() router.Status { return sampleStatus(time.Now()) }
	go func() {
		Loop(ctx, src, fp, 10*time.Millisecond, time.Minute, slog.New(slog.NewTextHandler(io.Discard, nil)))
		close(done)
	}()
	deadline := time.After(2 * time.Second)
	for fp.count() < 3 {
		select {
		case <-deadline:
			t.Fatalf("only %d publishes", fp.count())
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Loop did not exit on cancel")
	}
}

func TestAMQPPublishWhileDisconnected(t *testing.T) {
	a := NewAMQP("amqp://user:secret@127.0.0.1:1/", "mining_notify_exchange", slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer a.Close()
	if err := a.Publish(map[string]string{"type": "routing"}); err == nil {
		t.Fatal("expected error while disconnected")
	}
}
