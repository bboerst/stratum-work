package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/bboerst/stratum-work/router/internal/stratum"
	"github.com/bboerst/stratum-work/router/internal/work"
)

const (
	idConfigure = 1
	idSubscribe = 2
	idAuthorize = 3
	requestMask = "1fffe000"
	nonceLimit  = 1 << 22 // nonces per en2 before moving to the next en2
)

type stats struct{ Submitted, Accepted, Rejected uint64 }

func (s *stats) add(o stats) {
	s.Submitted += o.Submitted
	s.Accepted += o.Accepted
	s.Rejected += o.Rejected
}

type miner struct {
	c    *stratum.Conn
	user string
	log  *slog.Logger
	done chan struct{} // closed when the read loop exits

	mu      sync.Mutex
	en1     string
	en2Size int
	mask    uint32
	diff    float64
	job     *job
	gen     int
	nextID  uint64
	en2Ctr  uint64
	pending map[uint64]bool
	st      stats
}

func dial(addr, user, pass string, log *slog.Logger) (*miner, error) {
	raw, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		return nil, err
	}
	m := &miner{c: stratum.NewConn(raw), user: user, log: log, done: make(chan struct{}),
		nextID: 100, pending: map[uint64]bool{}}
	subscribed := make(chan struct{})
	go m.readLoop(subscribed)
	for _, req := range []map[string]any{
		stratum.Request(idConfigure, "mining.configure", []string{"version-rolling"},
			map[string]any{"version-rolling.mask": requestMask, "version-rolling.min-bit-count": 2}),
		stratum.Request(idSubscribe, "mining.subscribe", "stratum-work-testminer/1"),
		stratum.Request(idAuthorize, "mining.authorize", user, pass),
	} {
		if err := m.c.Write(req); err != nil {
			_ = m.c.Close()
			return nil, err
		}
	}
	select {
	case <-subscribed:
	case <-m.done:
		return nil, fmt.Errorf("connection closed during handshake")
	case <-time.After(10 * time.Second):
		_ = m.c.Close()
		return nil, fmt.Errorf("no subscribe response")
	}
	m.mu.Lock()
	log.Info("subscribed", "addr", addr, "en1", m.en1, "en2size", m.en2Size, "mask", fmt.Sprintf("%08x", m.mask))
	m.mu.Unlock()
	return m, nil
}

func (m *miner) stats() stats { m.mu.Lock(); defer m.mu.Unlock(); return m.st }

func (m *miner) readLoop(subscribed chan struct{}) {
	defer close(m.done)
	for {
		msg, err := m.c.Read()
		if err != nil {
			return
		}
		var params []json.RawMessage
		_ = json.Unmarshal(msg.Params, &params)
		switch msg.Method {
		case "mining.set_difficulty":
			var d float64
			if len(params) > 0 && json.Unmarshal(params[0], &d) == nil && d > 0 {
				m.mu.Lock()
				m.diff = d
				m.mu.Unlock()
			}
		case "mining.set_version_mask":
			var s string
			var mask uint32
			if len(params) > 0 && json.Unmarshal(params[0], &s) == nil {
				if _, err := fmt.Sscanf(s, "%08x", &mask); err == nil {
					m.mu.Lock()
					m.mask = mask
					m.gen++
					m.mu.Unlock()
				}
			}
		case "mining.notify":
			j, err := parseNotify(params)
			if err != nil {
				m.log.Warn("bad notify", "err", err)
				continue
			}
			m.mu.Lock()
			m.job = &j
			m.gen++
			m.mu.Unlock()
		case "":
			m.onResponse(msg, subscribed)
		}
	}
}

func (m *miner) onResponse(msg *stratum.Message, subscribed chan struct{}) {
	var id uint64
	if json.Unmarshal(msg.ID, &id) != nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	switch id {
	case idConfigure:
		var res map[string]any
		if json.Unmarshal(msg.Result, &res) == nil {
			if s, ok := res["version-rolling.mask"].(string); ok {
				_, _ = fmt.Sscanf(s, "%08x", &m.mask)
			}
		}
	case idSubscribe:
		var res []json.RawMessage
		if json.Unmarshal(msg.Result, &res) == nil && len(res) >= 3 {
			_ = json.Unmarshal(res[1], &m.en1)
			_ = json.Unmarshal(res[2], &m.en2Size)
		}
		close(subscribed)
	case idAuthorize:
		var ok bool
		if json.Unmarshal(msg.Result, &ok) != nil || !ok {
			m.log.Warn("authorize rejected", "error", string(msg.Error))
		}
	default:
		if !m.pending[id] {
			return
		}
		delete(m.pending, id)
		var ok bool
		if json.Unmarshal(msg.Result, &ok) == nil && ok {
			m.st.Accepted++
		} else {
			m.st.Rejected++
			m.log.Info("share rejected", "error", string(msg.Error))
		}
	}
}

// snapshot returns the current work and its generation, or nil if not ready.
func (m *miner) snapshot() (*workUnit, int, uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.job == nil || m.diff <= 0 || m.en2Size <= 0 {
		return nil, m.gen, 0
	}
	m.en2Ctr++
	return &workUnit{j: *m.job, en1: m.en1, en2Len: m.en2Size, mask: m.mask,
		target: work.DiffToTarget(m.diff)}, m.gen, m.en2Ctr
}

func (m *miner) curGen() int { m.mu.Lock(); defer m.mu.Unlock(); return m.gen }

// run hashes until stop is closed or the connection drops.
func (m *miner) run(stop <-chan struct{}) {
	defer m.c.Close()
	lastLog := time.Now()
	for {
		select {
		case <-stop:
			return
		case <-m.done:
			return
		default:
		}
		w, gen, ctr := m.snapshot()
		if w == nil {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		abort := func() bool {
			select {
			case <-stop:
				return true
			case <-m.done:
				return true
			default:
			}
			return m.curGen() != gen
		}
		s, ok, err := search(w, ctr, nonceLimit, abort)
		if err != nil {
			m.log.Error("bad job", "job", w.j.ID, "err", err)
			time.Sleep(time.Second)
			continue
		}
		if ok {
			m.submit(s)
		}
		if time.Since(lastLog) > 30*time.Second {
			st := m.stats()
			m.log.Info("progress", "submitted", st.Submitted, "accepted", st.Accepted, "rejected", st.Rejected)
			lastLog = time.Now()
		}
	}
}

func (m *miner) submit(s share) {
	m.mu.Lock()
	m.nextID++
	id := m.nextID
	m.pending[id] = true
	m.st.Submitted++
	m.mu.Unlock()
	params := []any{m.user, s.JobID, s.En2, s.NTime, s.Nonce}
	if s.VersionBits != "" {
		params = append(params, s.VersionBits)
	}
	_ = m.c.Write(stratum.Request(id, "mining.submit", params...))
}
