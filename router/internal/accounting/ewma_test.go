package accounting

import (
	"math"
	"testing"
	"time"
)

func TestRateConvergesToTrueHashrate(t *testing.T) {
	r := NewRate(10 * time.Minute)
	start := time.Unix(0, 0)
	const hs = 3e12
	diff := 4096.0
	interval := time.Duration(float64(time.Second) * diff * math.Pow(2, 32) / hs)
	now := start
	for now.Sub(start) < 30*time.Minute {
		now = now.Add(interval)
		r.Add(now, diff)
	}
	got := r.HashesPerSecond(now)
	if math.Abs(got-hs)/hs > 0.05 {
		t.Fatalf("got %.3g want %.3g", got, hs)
	}
}

func TestRateUnbiasedEarly(t *testing.T) {
	r := NewRate(10 * time.Minute)
	now := time.Unix(0, 0)
	for i := 0; i < 600; i++ {
		now = now.Add(100 * time.Millisecond)
		r.Add(now, 1)
	}
	want := math.Pow(2, 32) / 0.1
	if got := r.HashesPerSecond(now); math.Abs(got-want)/want > 0.1 {
		t.Fatalf("got %.3g want %.3g", got, want)
	}
}
