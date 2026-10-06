package sched

import (
	"math"
	"sort"
	"sync"
	"time"
)

type Target struct {
	ID        string
	TargetHs  float64
	Available bool
}

type Scheduler struct {
	mu         sync.Mutex
	targets    []Target
	remainder  string
	minSlice   time.Duration
	credit     map[string]float64
	current    string
	sliceStart time.Time
	last       time.Time
}

const creditCap = 60.0

func New(targets []Target, remainderID string, minSlice time.Duration) *Scheduler {
	return &Scheduler{targets: append([]Target(nil), targets...), remainder: remainderID, minSlice: minSlice, credit: map[string]float64{}}
}

func (s *Scheduler) SetAvailable(id string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.targets {
		if s.targets[i].ID == id {
			s.targets[i].Available = ok
		}
	}
}

func (s *Scheduler) Fractions(totalHs float64, delivered map[string]float64) map[string]float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	fr := map[string]float64{}
	sum := 0.0
	for _, t := range s.targets {
		if !t.Available || totalHs <= 0 {
			fr[t.ID] = 0
			continue
		}
		fr[t.ID] = t.TargetHs / totalHs
		sum += fr[t.ID]
	}
	scale := func() {
		if sum > 1 {
			for k := range fr {
				fr[k] /= sum
			}
			sum = 1
		}
	}
	scale()
	if delivered != nil {
		sum = 0
		for _, t := range s.targets {
			if d := delivered[t.ID]; d > 0 && fr[t.ID] > 0 {
				fr[t.ID] *= math.Max(0.5, math.Min(2, t.TargetHs/d))
			}
			sum += fr[t.ID]
		}
		scale()
	}
	fr[s.remainder] = math.Max(0, 1-sum)
	return fr
}

func (s *Scheduler) available(id string) bool {
	if id == s.remainder {
		return true
	}
	for _, t := range s.targets {
		if t.ID == id {
			return t.Available
		}
	}
	return false
}

func (s *Scheduler) Tick(now time.Time, fr map[string]float64) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.last.IsZero() {
		dt := now.Sub(s.last).Seconds()
		for id, f := range fr {
			s.credit[id] = math.Min(creditCap, s.credit[id]+f*dt)
		}
		if s.current != "" {
			s.credit[s.current] = math.Max(-creditCap, s.credit[s.current]-dt)
		}
	}
	s.last = now
	mustSwitch := s.current == "" || !s.available(s.current)
	canSwitch := now.Sub(s.sliceStart) >= s.minSlice && s.credit[s.current] <= 0
	if !mustSwitch && !canSwitch {
		return s.current, false
	}
	ids := make([]string, 0, len(fr))
	for id, f := range fr {
		if f > 0 && s.available(id) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		ids = []string{s.remainder}
	}
	sort.Strings(ids)
	best := ids[0]
	for _, id := range ids[1:] {
		if s.credit[id] > s.credit[best] {
			best = id
		}
	}
	if best == s.current {
		return s.current, false
	}
	s.current, s.sliceStart = best, now
	return best, true
}

func (s *Scheduler) Current() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
}
