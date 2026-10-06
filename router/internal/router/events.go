package router

import (
	"time"

	"github.com/bboerst/stratum-work/router/internal/work"
)

// Router implements upstream.Events for primary clients.

func (r *Router) OnJob(target string, job work.Job) { r.onJob(target, job, false) }

func (r *Router) OnDifficulty(target string, diff float64) {}

func (r *Router) OnState(target string, connected bool) {
	if !connected && (target != r.remainder.id || !r.fallback()) {
		r.reg.InvalidateTarget(target) // jobs from the dead session are unusable
	}
	if target != r.remainder.id {
		return
	}
	now := time.Now()
	r.mu.Lock()
	if connected {
		r.remUpSince, r.remDownSince = now, time.Time{}
	} else {
		r.remDownSince, r.remUpSince = now, time.Time{}
	}
	r.mu.Unlock()
}

func (r *Router) OnSubmitResult(target string, reqID uint64, accepted bool, reason string) {
	res := "rejected"
	if accepted {
		res = "accepted"
	} else {
		r.log.Debug("upstream rejected share", "target", target, "reason", reason)
	}
	r.mu.Lock()
	m := r.upSubmits[target]
	if m == nil {
		m = map[string]uint64{}
		r.upSubmits[target] = m
	}
	m[res]++
	r.mu.Unlock()
}

// onJob forwards a new upstream job to sessions currently on that target,
// but only when the reporting client is the active one for it.
func (r *Router) onJob(target string, job work.Job, fromFallback bool) {
	r.mu.Lock()
	if target == r.remainder.id && fromFallback != r.fallbackActive {
		r.mu.Unlock()
		return
	}
	if job.Clean {
		r.reg.InvalidateTarget(target)
	}
	sessions := make([]*session, 0, len(r.sessions))
	for _, s := range r.sessions {
		sessions = append(sessions, s)
	}
	r.mu.Unlock()
	for _, s := range sessions {
		s.onUpstreamJob(target, job.Clean)
	}
}

// fallbackEvents routes fallback-client events, which share the remainder id.
type fallbackEvents struct{ r *Router }

func (f *fallbackEvents) OnJob(target string, job work.Job)        { f.r.onJob(target, job, true) }
func (f *fallbackEvents) OnDifficulty(target string, diff float64) {}
func (f *fallbackEvents) OnState(target string, connected bool)    {}
func (f *fallbackEvents) OnSubmitResult(target string, id uint64, ok bool, reason string) {
	f.r.OnSubmitResult(target, id, ok, reason)
}

// updateFallback flips fallback on after the remainder has been down for
// fallbackAfter, and off once it has been back up for fallbackAfter.
func (r *Router) updateFallback(now time.Time) (changed bool) {
	if r.remainder.fallback == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	switch {
	case !r.fallbackActive && !r.remDownSince.IsZero() && now.Sub(r.remDownSince) > r.fallbackAfter:
		r.fallbackActive = true
		changed = true
	case r.fallbackActive && !r.remUpSince.IsZero() && now.Sub(r.remUpSince) > r.fallbackAfter:
		r.fallbackActive = false
		changed = true
	}
	if changed {
		r.log.Warn("remainder fallback", "active", r.fallbackActive)
		r.reg.InvalidateTarget(r.remainder.id)
	}
	return changed
}
