package main

import (
	"context"
	"testing"
	"time"
)

// A connection that ends is recorded as a "session" ingest event: connect and subscribe times, the templates it
// delivered and why it ended. A shutdown ends the last one with "shutdown".
func TestSessionsAreRecordedWithTheirTemplatesAndEnd(t *testing.T) {
	pool := newFakePool(t)
	c, docs, _, _ := testCollector(t, poolURL(pool), nil)
	got := make(chan IngestEvent, 8)
	c.Event = func(e IngestEvent) { got <- e }
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	before := time.Now()
	go c.Run(ctx)

	f := pool.accept(t)
	f.handshake(t)
	f.send(t, notifyLine("j1")+notifyLine("j2"))
	nextDoc(t, docs)
	nextDoc(t, docs)
	f.Close() // the pool drops the connection

	e := nextEvent(t, got)
	if e.Kind != "session" || e.Templates != 2 || e.Start.Before(before) || e.End.Before(e.Start) {
		t.Fatalf("first session: %+v", e)
	}
	sub, _ := e.Detail["subscribed_at"].(string)
	if at, err := time.Parse(time.RFC3339Nano, sub); err != nil || at.Before(e.Start) || at.After(e.End) {
		t.Errorf("subscribed_at %q not within the session", sub)
	}
	if end, _ := e.Detail["end"].(string); end == "" || end == "shutdown" {
		t.Errorf("end = %q, want the read error", end)
	}

	f2 := pool.accept(t) // reconnects
	f2.handshake(t)
	f2.send(t, notifyLine("j3"))
	nextDoc(t, docs)
	stop()
	e = nextEvent(t, got)
	if e.Kind != "session" || e.Templates != 1 || e.Detail["end"] != "shutdown" {
		t.Fatalf("second session: %+v", e)
	}
}

// A connection whose subscribe never succeeds is still a session, with no subscribed_at.
func TestSessionWithoutSubscribeHasNoSubscribedAt(t *testing.T) {
	pool := newFakePool(t)
	c, _, _, _ := testCollector(t, poolURL(pool), nil)
	got := make(chan IngestEvent, 8)
	c.Event = func(e IngestEvent) { got <- e }
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	go c.Run(ctx)
	f := pool.accept(t)
	f.readReq(t) // the subscribe, never answered
	f.Close()
	e := nextEvent(t, got)
	if e.Kind != "session" || e.Templates != 0 || e.Detail["subscribed_at"] != nil {
		t.Fatalf("%+v", e)
	}
}

func TestStartEventRecordsTheNode(t *testing.T) {
	at := time.Date(2026, 11, 18, 2, 0, 0, 0, time.UTC)
	e := startEvent("node-a", "v1", at)
	if e.Kind != "start" || !e.Start.Equal(at) || !e.End.Equal(at) || e.Templates != 0 ||
		e.Detail["node"] != "node-a" || e.Detail["version"] != "v1" {
		t.Fatalf("%+v", e)
	}
	if e := startEvent("", "v1", at); e.Detail["node"] != nil {
		t.Errorf("unset node should be null, got %v", e.Detail["node"])
	}
	row := e.values(7)
	if row[0] != int16(7) || row[1] != "start" {
		t.Errorf("row %v", row)
	}
}

func nextEvent(t *testing.T, ch chan IngestEvent) IngestEvent {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(5 * time.Second):
		t.Fatal("no event")
	}
	return IngestEvent{}
}
