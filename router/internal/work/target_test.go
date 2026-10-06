package work

import "testing"

func TestDiff1Target(t *testing.T) {
	want := "ffff0000000000000000000000000000000000000000000000000000"
	if got := DiffToTarget(1).Text(16); got != want {
		t.Fatalf("got %s", got)
	}
}

func TestMeetsTargetAndDifficulty(t *testing.T) {
	var h [32]byte // all zero hash meets any target
	if !MeetsTarget(h, DiffToTarget(1e12)) {
		t.Fatal("zero hash must meet target")
	}
	h[31] = 0xff // most significant byte (little-endian integer) -> huge hash
	if MeetsTarget(h, DiffToTarget(1)) {
		t.Fatal("huge hash must not meet diff 1")
	}
	var e [32]byte
	e[26], e[27] = 0xff, 0xff // hash == diff1 target
	if d := HashDifficulty(e); d < 0.999 || d > 1.001 {
		t.Fatalf("difficulty = %f", d)
	}
}

func TestFractionalDifficulty(t *testing.T) {
	if DiffToTarget(0.5).Cmp(DiffToTarget(1)) <= 0 {
		t.Fatal("lower difficulty must mean larger target")
	}
}
