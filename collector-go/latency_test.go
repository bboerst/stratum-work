package main

import (
	"encoding/binary"
	"math"
	"testing"
)

// Ported from collector/tests/test_latency.py.

func ms(n int64) int64 { return n * 1_000_000 }

func idMsg(id int64) pyValue {
	return pyValue{kind: pyDict, keys: []string{"id"}, items: []pyValue{pyIntOf(id)}}
}

func approx(t *testing.T, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-7 {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestNoSamplesReturnsNone(t *testing.T) {
	if NewLatencyTracker(false).Estimate() != nil {
		t.Error("expected nil")
	}
}

func TestDirectPrefersTCPRTTHalf(t *testing.T) {
	tr := NewLatencyTracker(false)
	tr.RecordTCPRTTUs(20_000, true)
	tr.RecordSend(1, 0)
	tr.TryResolve(idMsg(1), ms(100))
	e := tr.Estimate()
	approx(t, e.ms, 10.0)
	if e.method != "tcp" {
		t.Error(e.method)
	}
}

func TestDirectFallsBackToAppWithoutTCPInfo(t *testing.T) {
	tr := NewLatencyTracker(false)
	tr.RecordSend(1, 0)
	tr.TryResolve(idMsg(1), ms(30))
	e := tr.Estimate()
	approx(t, e.ms, 15.0)
	if e.method != "app" {
		t.Error(e.method)
	}
}

func TestProxiedUsesAppMinOverWindowIgnoringTCP(t *testing.T) {
	tr := NewLatencyTracker(true)
	tr.RecordTCPRTTUs(1_000, true)
	for i, rtt := range []int64{80, 60, 120} {
		tr.RecordSend(int64(i), 0)
		tr.TryResolve(idMsg(int64(i)), ms(rtt))
	}
	e := tr.Estimate()
	approx(t, e.ms, 30.0)
	if e.method != "app" {
		t.Error(e.method)
	}
}

func TestProxiedWithoutAppSamplesReturnsNone(t *testing.T) {
	tr := NewLatencyTracker(true)
	tr.RecordTCPRTTUs(1_000, true)
	if tr.Estimate() != nil {
		t.Error("expected nil")
	}
}

func TestAppWindowKeepsLast8Samples(t *testing.T) {
	tr := NewLatencyTracker(true)
	tr.RecordSend(0, 0)
	tr.TryResolve(idMsg(0), ms(10))
	for i := int64(1); i < 9; i++ {
		tr.RecordSend(i, 0)
		tr.TryResolve(idMsg(i), ms(50))
	}
	approx(t, tr.Estimate().ms, 25.0)
}

func TestRejectsNonPositiveAndAbsurdSamples(t *testing.T) {
	tr := NewLatencyTracker(true)
	tr.RecordSend(1, ms(100))
	tr.TryResolve(idMsg(1), ms(100))
	tr.RecordSend(2, 0)
	tr.TryResolve(idMsg(2), ms(31_000))
	if tr.Estimate() != nil {
		t.Error("expected nil")
	}
	tr.RecordTCPRTTUs(0, true)
	direct := NewLatencyTracker(false)
	direct.RecordTCPRTTUs(31_000_000, true)
	if direct.Estimate() != nil {
		t.Error("expected nil")
	}
}

func TestTryResolveUnknownOrMalformedReturnsFalse(t *testing.T) {
	tr := NewLatencyTracker(false)
	notify, _ := pyLoads([]byte(`{"method": "mining.notify"}`))
	nullID, _ := pyLoads([]byte(`{"id": null}`))
	for _, m := range []pyValue{idMsg(99), notify, pyString("not-a-dict"), nullID} {
		if tr.TryResolve(m, 0) {
			t.Errorf("resolved %s", pyDumps(m))
		}
	}
}

func TestTryResolveConsumesPendingID(t *testing.T) {
	tr := NewLatencyTracker(false)
	tr.RecordSend(5, 0)
	if !tr.TryResolve(idMsg(5), ms(10)) || tr.TryResolve(idMsg(5), ms(20)) {
		t.Error("expected the first resolve to consume the id")
	}
}

func TestTryResolvePythonIDEquality(t *testing.T) {
	// Python dict lookup: 1.0 == 1 == True; "1" is a different key.
	for raw, want := range map[string]bool{`{"id": 1.0}`: true, `{"id": true}`: true, `{"id": "1"}`: false, `{"id": [1]}`: false} {
		tr := NewLatencyTracker(false)
		tr.RecordSend(1, 0)
		m, _ := pyLoads([]byte(raw))
		if got := tr.TryResolve(m, ms(1)); got != want {
			t.Errorf("%s: %v", raw, got)
		}
	}
}

func TestPrunePendingDropsStaleEntries(t *testing.T) {
	tr := NewLatencyTracker(false)
	tr.RecordSend(1, 0)
	tr.RecordSend(2, ms(500))
	tr.PrunePending(ms(1_000), ms(600))
	if tr.TryResolve(idMsg(1), ms(1_001)) || !tr.TryResolve(idMsg(2), ms(1_001)) {
		t.Error("prune")
	}
}

func TestResetClearsAllState(t *testing.T) {
	tr := NewLatencyTracker(false)
	tr.RecordTCPRTTUs(10_000, true)
	tr.RecordSend(1, 0)
	tr.TryResolve(idMsg(1), ms(10))
	tr.Reset()
	if tr.Estimate() != nil || tr.TryResolve(idMsg(1), ms(20)) {
		t.Error("reset")
	}
}

func tcpInfoBytes(rttUs uint32) []byte {
	b := make([]byte, tcpInfoLen)
	binary.NativeEndian.PutUint32(b[8+15*4:], rttUs)
	return b
}

func TestParsesRTTFromBuffer(t *testing.T) {
	if v, ok := parseTCPInfoRTTUs(tcpInfoBytes(12_345)); !ok || v != 12_345 {
		t.Error(v, ok)
	}
}

func TestShortBufferReturnsNone(t *testing.T) {
	if _, ok := parseTCPInfoRTTUs(make([]byte, 10)); ok {
		t.Error("expected none")
	}
}
