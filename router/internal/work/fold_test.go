package work

import (
	"bytes"
	"testing"
)

func TestFoldReconstructsTargetCoinbase(t *testing.T) {
	job := Job{Coinb1: "01000000010000", Coinb2: "ffffffff0100"}
	targetEn1, prefix, downEn2 := "a1b2c3d4", "07", "11223344556677"
	for _, en2Size := range []int{8, 12} {
		f, err := PlanFold(en2Size, 1, 7)
		if err != nil {
			t.Fatal(err)
		}
		c1, c2 := DownstreamCoinbase(job, targetEn1, f)
		downstream, _ := BuildCoinbase(c1, prefix, downEn2, c2)
		upEn2 := UpstreamEn2(prefix, downEn2, f)
		if len(upEn2) != en2Size*2 {
			t.Fatalf("upstream en2 len %d want %d", len(upEn2), en2Size*2)
		}
		upstream, _ := BuildCoinbase(job.Coinb1, targetEn1, upEn2, job.Coinb2)
		if !bytes.Equal(downstream, upstream) {
			t.Fatalf("coinbase mismatch for en2Size %d", en2Size)
		}
	}
}

func TestPlanFoldRejectsSmallEn2(t *testing.T) {
	if _, err := PlanFold(4, 1, 7); err == nil {
		t.Fatal("expected error")
	}
}

func TestDownEn2Size(t *testing.T) {
	if n, _ := DownEn2Size([]int{8, 4, 8}, 1); n != 3 {
		t.Fatalf("got %d", n)
	}
	if _, err := DownEn2Size([]int{2}, 1); err == nil {
		t.Fatal("expected error when < 2")
	}
}
