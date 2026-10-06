package sched

import (
	"fmt"
	"math"
	"testing"
	"time"
)

func TestTimeSharesMatchTargets(t *testing.T) {
	var targets []Target
	for i := 0; i < 15; i++ {
		targets = append(targets, Target{ID: fmt.Sprintf("p%02d", i), TargetHs: 3e12, Available: true})
	}
	s := New(targets, "datum", 2*time.Second)
	fr := s.Fractions(60e12, nil)
	if math.Abs(fr["datum"]-0.25) > 1e-9 {
		t.Fatalf("remainder fraction = %f", fr["datum"])
	}
	now := time.Unix(0, 0)
	spent := map[string]time.Duration{}
	cur, _ := s.Tick(now, fr)
	minRun := time.Hour
	runStart := now
	for i := 0; i < 4*3600*4; i++ { // 4 h in 250 ms ticks
		next := now.Add(250 * time.Millisecond)
		spent[cur] += next.Sub(now)
		now = next
		c, sw := s.Tick(now, fr)
		if sw {
			if d := now.Sub(runStart); d < minRun {
				minRun = d
			}
			runStart = now
			cur = c
		}
	}
	total := 4 * time.Hour
	for id, want := range fr {
		got := spent[id].Seconds() / total.Seconds()
		if math.Abs(got-want) > 0.01 {
			t.Errorf("%s: share %.4f want %.4f", id, got, want)
		}
	}
	if minRun < 2*time.Second {
		t.Fatalf("slice shorter than minSlice: %v", minRun)
	}
}

func TestUnavailableTargetGoesToRemainder(t *testing.T) {
	s := New([]Target{{ID: "a", TargetHs: 10e12, Available: true}}, "datum", time.Second)
	s.SetAvailable("a", false)
	fr := s.Fractions(60e12, nil)
	if fr["a"] != 0 || fr["datum"] != 1 {
		t.Fatalf("fractions = %v", fr)
	}
}

func TestOversubscribedScalesDown(t *testing.T) {
	s := New([]Target{{ID: "a", TargetHs: 50e12, Available: true}, {ID: "b", TargetHs: 50e12, Available: true}}, "datum", time.Second)
	fr := s.Fractions(60e12, nil)
	if math.Abs(fr["a"]-0.5) > 1e-9 || fr["datum"] != 0 {
		t.Fatalf("fractions = %v", fr)
	}
}

func TestFeedbackBoostsUnderDelivered(t *testing.T) {
	s := New([]Target{{ID: "a", TargetHs: 3e12, Available: true}}, "datum", time.Second)
	fr := s.Fractions(60e12, map[string]float64{"a": 2e12})
	if fr["a"] <= 0.05 {
		t.Fatalf("expected boost above 0.05, got %f", fr["a"])
	}
}
