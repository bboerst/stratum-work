package main

import (
	"encoding/binary"
	"math"
	"strconv"
	"sync"
	"time"
)

// Port of collector/latency.py: pool -> collector latency, estimated as RTT/2.
//   - Direct connections: the kernel's smoothed TCP RTT (TCP_INFO tcpi_rtt), sampled right after we send data.
//   - SOCKS-proxied connections: application-level RTT of id-matched stratum requests (the kernel RTT would only
//     measure the hop to the local proxy); the minimum over the last 8 samples.

const maxReasonableRTTNs = 30_000_000_000 // 30 s

// tcpi_rtt (µs) is the 16th u32 after 8 leading u8 fields of struct tcp_info; 104 bytes are enough.
const (
	tcpInfoLen    = 8 + 24*4
	tcpInfoRTTOff = 8 + 15*4
)

func parseTCPInfoRTTUs(buf []byte) (int64, bool) {
	if len(buf) < tcpInfoLen {
		return 0, false
	}
	rtt := int64(binary.NativeEndian.Uint32(buf[tcpInfoRTTOff:]))
	return rtt, rtt > 0
}

var monoStart = time.Now()

// monoNs is a monotonic clock in ns (Python time.monotonic_ns()).
func monoNs() int64 { return int64(time.Since(monoStart)) }

type latencyEstimate struct {
	ms     float64
	method string
}

type LatencyTracker struct {
	proxied   bool
	appWindow int

	mu      sync.Mutex
	appRTT  []int64 // last appWindow samples, oldest first
	tcpRTT  int64   // 0 = none
	pending map[int64]int64
}

func NewLatencyTracker(proxied bool) *LatencyTracker {
	return &LatencyTracker{proxied: proxied, appWindow: 8, pending: map[int64]int64{}}
}

func (t *LatencyTracker) Reset() {
	t.mu.Lock()
	t.appRTT, t.tcpRTT, t.pending = nil, 0, map[int64]int64{}
	t.mu.Unlock()
}

func (t *LatencyTracker) RecordSend(id, sendMonoNs int64) {
	t.mu.Lock()
	t.pending[id] = sendMonoNs
	t.mu.Unlock()
}

// pyIDKey mirrors Python dict lookup/equality of a JSON "id" against our int request ids: ints and integral floats
// match by value, true == 1, false == 0; strings, null and containers never match.
func pyIDKey(v pyValue) (int64, bool) {
	switch v.kind {
	case pyInt:
		n, err := strconv.ParseInt(v.s, 10, 64)
		return n, err == nil
	case pyFloat:
		if v.f == math.Trunc(v.f) && math.Abs(v.f) < 1<<62 {
			return int64(v.f), true
		}
	case pyTrue:
		return 1, true
	case pyFalse:
		return 0, true
	}
	return 0, false
}

// TryResolve consumes a response to a tracked request id. True means msg answered one (it is not a notification).
func (t *LatencyTracker) TryResolve(msg pyValue, recvMonoNs int64) bool {
	if msg.kind != pyDict {
		return false
	}
	idv, ok := msg.get("id")
	if !ok || idv.kind == pyNull {
		return false
	}
	id, ok := pyIDKey(idv)
	if !ok {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	send, ok := t.pending[id]
	if !ok {
		return false
	}
	delete(t.pending, id)
	if rtt := recvMonoNs - send; rtt > 0 && rtt <= maxReasonableRTTNs {
		t.appRTT = append(t.appRTT, rtt)
		if len(t.appRTT) > t.appWindow {
			t.appRTT = t.appRTT[1:]
		}
	}
	return true
}

func (t *LatencyTracker) RecordTCPRTTUs(rttUs int64, ok bool) {
	if !ok {
		return
	}
	ns := rttUs * 1000
	if ns > 0 && ns <= maxReasonableRTTNs {
		t.mu.Lock()
		t.tcpRTT = ns
		t.mu.Unlock()
	}
}

func (t *LatencyTracker) PrunePending(nowMonoNs, maxAgeNs int64) {
	t.mu.Lock()
	for id, ts := range t.pending {
		if nowMonoNs-ts > maxAgeNs {
			delete(t.pending, id)
		}
	}
	t.mu.Unlock()
}

// Estimate is the best current one-way latency estimate, or nil. Same float arithmetic as Python (ns / 2 / 1e6).
func (t *LatencyTracker) Estimate() *latencyEstimate {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.proxied && t.tcpRTT != 0 {
		return &latencyEstimate{float64(t.tcpRTT) / 2 / 1e6, "tcp"}
	}
	if len(t.appRTT) > 0 {
		m := t.appRTT[0]
		for _, v := range t.appRTT[1:] {
			m = min(m, v)
		}
		return &latencyEstimate{float64(m) / 2 / 1e6, "app"}
	}
	return nil
}
