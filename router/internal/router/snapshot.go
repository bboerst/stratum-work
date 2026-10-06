package router

import (
	"sort"
	"time"
)

// Status returns a point-in-time snapshot. It contains no IP addresses.
func (r *Router) Status() Status {
	now := time.Now()
	fb := r.fallback()
	st := Status{Site: r.cfg.Site}
	for _, t := range r.targets {
		d := t.delivered.HashesPerSecond(now)
		if t.remainder {
			st.Remainder = RemainderStatus{ID: t.id, DeliveredHs: d, FallbackActive: fb}
			continue
		}
		st.Targets = append(st.Targets, TargetStatus{ID: t.id, Pool: t.pool,
			TargetHs: t.targetHs, DeliveredHs: d, Available: t.view(fb, 0).ok})
	}

	r.mu.Lock()
	ss := make([]*session, 0, len(r.sessions))
	for _, s := range r.sessions {
		ss = append(ss, s)
	}
	st.Counters = Counters{Shares: map[string]uint64{}, UpstreamSubmits: map[string]map[string]uint64{}}
	for k, v := range r.shares {
		st.Counters.Shares[k] = v
	}
	for t, m := range r.upSubmits {
		c := map[string]uint64{}
		for k, v := range m {
			c[k] = v
		}
		st.Counters.UpstreamSubmits[t] = c
	}
	type wk struct {
		name string
		a    *workerAcct
	}
	ws := make([]wk, 0, len(r.workers))
	for n, a := range r.workers {
		ws = append(ws, wk{n, a})
	}
	r.mu.Unlock()

	for _, w := range ws {
		st.Workers = append(st.Workers, WorkerStatus{Name: w.name, Hs: w.a.rate.HashesPerSecond(now),
			Since: w.a.since, WorkSeconds: w.a.last.Sub(w.a.since).Seconds()})
	}
	sort.Slice(st.Workers, func(i, j int) bool { return st.Workers[i].Name < st.Workers[j].Name })

	for _, s := range ss {
		hs := s.rate.HashesPerSecond(now)
		st.TotalHs += hs
		s.mu.Lock()
		st.Connections = append(st.Connections, ConnStatus{ID: s.id, Worker: s.worker, Hs: hs,
			Diff: s.vd.Current(), Target: s.current, Accepted: s.accepted, Invalid: s.invalid,
			Stale: s.stale, Duplicate: s.duplicate})
		s.mu.Unlock()
	}
	sort.Slice(st.Connections, func(i, j int) bool { return st.Connections[i].ID < st.Connections[j].ID })
	return st
}
