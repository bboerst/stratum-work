package accounting

import (
	"math"
	"sync"
	"time"
)

type Rate struct {
	mu    sync.Mutex
	tau   float64
	value float64 // EWMA of hashes per second
	last  time.Time
	start time.Time
}

func NewRate(tau time.Duration) *Rate { return &Rate{tau: tau.Seconds()} }

func (r *Rate) decay(now time.Time) {
	if r.last.IsZero() {
		r.last, r.start = now, now
		return
	}
	dt := now.Sub(r.last).Seconds()
	if dt > 0 {
		r.value *= math.Exp(-dt / r.tau)
		r.last = now
	}
}

func (r *Rate) Add(now time.Time, difficulty float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.decay(now)
	r.value += difficulty * math.Pow(2, 32) / r.tau
}

func (r *Rate) HashesPerSecond(now time.Time) float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.last.IsZero() {
		return 0
	}
	r.decay(now)
	elapsed := now.Sub(r.start).Seconds()
	if elapsed <= 0 {
		return 0
	}
	return r.value / (1 - math.Exp(-elapsed/r.tau))
}
