package downstream

import (
	"math"
	"time"
)

type VarDiff struct {
	cur, min, max, target float64
	windowStart           time.Time
	shares                int
}

func NewVarDiff(start, min, max, targetSharesPerSec float64) *VarDiff {
	return &VarDiff{cur: start, min: min, max: max, target: targetSharesPerSec}
}

func (v *VarDiff) Current() float64 { return v.cur }

func (v *VarDiff) Cap(maxDiff float64) float64 {
	if maxDiff > 0 && v.cur > maxDiff {
		v.cur = maxDiff
	}
	return v.cur
}

func (v *VarDiff) OnShare(now time.Time) (float64, bool) {
	if v.windowStart.IsZero() {
		v.windowStart = now
	}
	v.shares++
	el := now.Sub(v.windowStart).Seconds()
	if el < 30 && v.shares < 30 {
		return v.cur, false
	}
	if el <= 0 {
		return v.cur, false
	}
	rate := float64(v.shares) / el
	next := v.cur * rate / v.target
	next = math.Max(v.cur/4, math.Min(v.cur*4, next))
	next = math.Max(v.min, math.Min(v.max, next))
	v.windowStart, v.shares = now, 0
	if math.Abs(next-v.cur)/v.cur < 0.2 {
		return v.cur, false
	}
	v.cur = next
	return v.cur, true
}
