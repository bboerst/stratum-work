package downstream

import (
	"testing"
	"time"
)

func TestVarDiffRaisesForFastShares(t *testing.T) {
	v := NewVarDiff(1000, 1, 1e9, 5)
	now := time.Unix(0, 0)
	var changed bool
	for i := 0; i < 600 && !changed; i++ {
		now = now.Add(20 * time.Millisecond)
		_, changed = v.OnShare(now)
	}
	if !changed || v.Current() <= 1000 || v.Current() > 4000 {
		t.Fatalf("diff = %f changed=%v", v.Current(), changed)
	}
}

func TestVarDiffCap(t *testing.T) {
	v := NewVarDiff(1000, 1, 1e9, 5)
	if v.Cap(500) != 500 {
		t.Fatal("cap must lower difficulty")
	}
}
