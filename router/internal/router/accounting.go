package router

import (
	"time"

	"github.com/bboerst/stratum-work/router/internal/accounting"
	"github.com/bboerst/stratum-work/router/internal/stratum"
)

// count bumps per-session and global counters for a non-accepted result.
func (s *session) count(result string) {
	s.mu.Lock()
	switch result {
	case "stale":
		s.stale++
	case "duplicate":
		s.duplicate++
	case "invalid":
		s.invalid++
	}
	s.mu.Unlock()
	s.r.countShare(result)
}

// reject answers error 23, counts it invalid and applies the ban rule.
func (s *session) reject(m *stratum.Message, result string) bool {
	s.count(result)
	_ = s.c.Write(stratum.Response(m.ID, nil, stratum.ErrLowDiff))
	if s.mark(time.Now(), true) {
		s.r.ban(s.ip)
		return false
	}
	return true
}

// mark records a share outcome and reports whether the ban threshold is hit:
// invalid ratio > limit over >= banMinShares shares within banWindow.
func (s *session) mark(now time.Time, invalid bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.window = append(s.window, shareMark{at: now, invalid: invalid})
	i := 0
	for i < len(s.window) && now.Sub(s.window[i].at) > banWindow {
		i++
	}
	s.window = s.window[i:]
	if len(s.window) < banMinShares {
		return false
	}
	bad := 0
	for _, w := range s.window {
		if w.invalid {
			bad++
		}
	}
	return float64(bad)/float64(len(s.window)) > s.r.cfg.Limits.InvalidShareBanRatio
}

// credit accounts an accepted share to the connection and worker, and to the
// target only when toTarget (the pool could use it), then applies vardiff
// (the new difficulty is sent with the next job).
func (s *session) credit(e Entry, worker string, toTarget bool) {
	now := time.Now()
	s.rate.Add(now, e.Diff)
	if t := s.r.target(e.Target); t != nil && toTarget {
		t.delivered.Add(now, e.Diff)
	}
	s.mark(now, false)
	s.mu.Lock()
	s.accepted++
	_, changed := s.vd.OnShare(now)
	s.mu.Unlock()
	s.r.countShare("accepted")

	s.r.mu.Lock()
	w := s.r.workers[worker]
	if w == nil {
		w = &workerAcct{rate: accounting.NewRate(rateTau), since: now}
		s.r.workers[worker] = w
	}
	w.last = now
	s.r.mu.Unlock()
	w.rate.Add(now, e.Diff)

	if changed {
		s.sendWork(false) // new difficulty applies to the next job; keep in-flight work
	}
}
