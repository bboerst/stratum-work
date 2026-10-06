package router

import (
	"time"

	"github.com/bboerst/stratum-work/router/internal/sched"
)

// schedule runs one scheduler tick for this connection. connHs/totalHs give
// its proportional share of each target's configured hashrate.
func (s *session) schedule(now time.Time, connHs, totalHs float64, fb, fbChanged bool) {
	s.mu.Lock()
	authorized, mask, cur := s.authorized, s.mask, s.current
	s.mu.Unlock()
	if !authorized {
		return
	}

	goals := make([]sched.Target, 0, len(s.r.targets))
	anyAvail := false
	for _, t := range s.r.targets {
		if t.remainder {
			continue
		}
		ok := t.view(fb, mask).ok
		s.sch.SetAvailable(t.id, ok)
		anyAvail = anyAvail || ok
		g := 0.0
		if ok && totalHs > 0 {
			g = t.targetHs * connHs / totalHs
		}
		goals = append(goals, sched.Target{ID: t.id, TargetHs: g, Available: ok})
	}
	remOK := s.r.remainder.view(fb, mask).ok
	if !anyAvail && !remOK {
		return // nothing usable; stay put
	}

	// Fractions of this connection's own hashrate per target.
	fr := map[string]float64{}
	sum := 0.0
	for _, g := range goals {
		f := 0.0
		if g.Available && connHs > 0 {
			f = g.TargetHs / connHs
		}
		fr[g.ID] = f
		sum += f
	}
	if sum > 1 {
		for k := range fr {
			fr[k] /= sum
		}
		sum = 1
	}
	if remOK {
		fr[s.r.remainder.id] = 1 - sum
	}
	// Before any hashrate is measured, give targets a nominal share so the
	// connection explores them rather than sitting on the remainder.
	if connHs == 0 {
		for _, g := range goals {
			if g.Available {
				fr[g.ID] = 0.5 / float64(len(goals))
			}
		}
	}

	next, switched := s.sch.Tick(now, fr)
	if next == "" {
		return
	}
	if switched || next != cur {
		s.mu.Lock()
		s.current = next
		s.mu.Unlock()
		s.sendWork(true)
		return
	}
	if fbChanged && cur == s.r.remainder.id {
		s.sendWork(true)
	}
}
