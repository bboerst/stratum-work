package router

import (
	"fmt"
	"time"

	"github.com/bboerst/stratum-work/router/internal/stratum"
	"github.com/bboerst/stratum-work/router/internal/work"
)

// sendWork sends the latest job of the session's current target (picking
// one if none yet). clean forces clean_jobs=true.
func (s *session) sendWork(clean bool) {
	s.sendMu.Lock() // keep job registration and notify order consistent
	defer s.sendMu.Unlock()
	s.mu.Lock()
	if !s.authorized {
		s.mu.Unlock()
		return
	}
	cur, mask := s.current, s.mask
	s.mu.Unlock()
	fb := s.r.fallback()
	if cur == "" {
		cur = s.r.remainder.id
		s.mu.Lock()
		s.current = cur
		s.mu.Unlock()
	}
	t := s.r.target(cur)
	if t == nil {
		return
	}
	v := t.view(fb, mask)
	if !v.ok {
		return
	}
	s.sendJob(t.id, v, v.st.Jobs[0], clean)
}

// sendJob registers and sends one job to the miner.
func (s *session) sendJob(targetID string, v jobView, job work.Job, clean bool) {
	fold, err := work.PlanFold(v.st.En2Size, prefixLen, downEn2Size)
	if err != nil {
		return
	}
	s.mu.Lock()
	diff := s.vd.Current()
	if up := v.st.Difficulty; up > 0 && diff > up {
		diff = up // never ask the miner for more than the pool accepts
	}
	sendDiff := diff != s.sentDiff
	s.sentDiff = diff
	mask := s.mask // validation mask; upstream compatibility is checked at forwarding
	s.mu.Unlock()

	id := s.r.newJobID()
	s.r.reg.Put(id, Entry{Target: targetID, Job: job, En1: v.st.En1, Fold: fold,
		Diff: diff, Created: time.Now(), Mask: mask, client: v.client})
	cb1, cb2 := work.DownstreamCoinbase(job, v.st.En1, fold)
	if sendDiff {
		_ = s.c.Write(stratum.Notify("mining.set_difficulty", diff))
	}
	_ = s.c.Write(stratum.Notify("mining.notify", id, job.PrevHash, cb1, cb2, job.Branches,
		fmt.Sprintf("%08x", job.Version), job.NBits, job.NTime, clean || job.Clean))
}

// onUpstreamJob forwards a new job when the session is on that target.
func (s *session) onUpstreamJob(targetID string, clean bool) {
	s.mu.Lock()
	on := s.authorized && s.current == targetID
	s.mu.Unlock()
	if on {
		s.sendWork(clean)
	}
}

func (r *Router) fallback() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.fallbackActive
}
