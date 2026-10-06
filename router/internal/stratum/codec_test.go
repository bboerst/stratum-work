package stratum

import (
	"net"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	a, b := net.Pipe()
	ca, cb := NewConn(a), NewConn(b)
	go func() { _ = ca.Write(Request(1, "mining.subscribe", "agent/1.0")) }()
	m, err := cb.Read()
	if err != nil {
		t.Fatal(err)
	}
	if m.Method != "mining.subscribe" || string(m.ID) != "1" || !m.IsRequest() || m.IsNotification() {
		t.Fatalf("bad message: %+v", m)
	}
	go func() { _ = cb.Write(Notify("mining.set_difficulty", 1024)) }()
	n, err := ca.Read()
	if err != nil {
		t.Fatal(err)
	}
	if !n.IsNotification() || string(n.Params) != "[1024]" {
		t.Fatalf("bad notify: %+v %s", n, n.Params)
	}
}

func TestRejectsOversizedLine(t *testing.T) {
	a, b := net.Pipe()
	cb := NewConn(b)
	go func() {
		buf := make([]byte, 70*1024)
		for i := range buf {
			buf[i] = 'a'
		}
		_, _ = a.Write(buf)
	}()
	if _, err := cb.Read(); err == nil {
		t.Fatal("expected error for oversized line")
	}
}
