package router

import (
	"fmt"
	"testing"
	"time"

	"github.com/bboerst/stratum-work/router/internal/work"
)

func entry(target, upID string) Entry {
	return Entry{
		Target:  target,
		Job:     work.Job{UpstreamID: upID},
		En1:     "aabbccdd",
		Fold:    work.Fold{PrefixLen: 4, DownEn2Size: 4},
		Diff:    512,
		Created: time.Now(),
	}
}

func TestRegistryPutGet(t *testing.T) {
	r := NewRegistry()
	r.Put("1", entry("a", "up1"))
	e, ok := r.Get("1")
	if !ok || e.Target != "a" || e.Job.UpstreamID != "up1" || e.Diff != 512 || e.En1 != "aabbccdd" {
		t.Fatalf("got %+v ok=%v", e, ok)
	}
	if _, ok := r.Get("missing"); ok {
		t.Fatal("missing id should not be found")
	}
}

func TestRegistryEvictsOldestPerTarget(t *testing.T) {
	r := NewRegistry()
	r.Put("b0", entry("b", "ub"))
	for i := 0; i < 65; i++ {
		r.Put(fmt.Sprintf("a%d", i), entry("a", "ua"))
	}
	if _, ok := r.Get("a0"); ok {
		t.Fatal("oldest entry of target a should be evicted")
	}
	for i := 1; i < 65; i++ {
		if _, ok := r.Get(fmt.Sprintf("a%d", i)); !ok {
			t.Fatalf("a%d should remain", i)
		}
	}
	if _, ok := r.Get("b0"); !ok {
		t.Fatal("other target's entry must not be evicted")
	}
}

func TestRegistryInvalidateTarget(t *testing.T) {
	r := NewRegistry()
	r.Put("a1", entry("a", "ua"))
	r.Put("a2", entry("a", "ua"))
	r.Put("b1", entry("b", "ub"))
	r.InvalidateTarget("a")
	if _, ok := r.Get("a1"); ok {
		t.Fatal("a1 should be invalidated")
	}
	if _, ok := r.Get("a2"); ok {
		t.Fatal("a2 should be invalidated")
	}
	if _, ok := r.Get("b1"); !ok {
		t.Fatal("b1 must survive")
	}
	// target can be reused after invalidation
	r.Put("a3", entry("a", "ua"))
	if _, ok := r.Get("a3"); !ok {
		t.Fatal("a3 should be stored")
	}
}

func TestRegistrySeenDuplicate(t *testing.T) {
	r := NewRegistry()
	r.Put("1", entry("a", "ua"))
	if r.Seen("1", "00000001", "5f000000", "deadbeef", 0x20000000) {
		t.Fatal("first submit is not a duplicate")
	}
	if !r.Seen("1", "00000001", "5f000000", "deadbeef", 0x20000000) {
		t.Fatal("second identical submit is a duplicate")
	}
	if r.Seen("1", "00000001", "5f000000", "deadbeef", 0x20002000) {
		t.Fatal("different version is not a duplicate")
	}
	if r.Seen("1", "00000002", "5f000000", "deadbeef", 0x20000000) {
		t.Fatal("different en2 is not a duplicate")
	}
}

func TestRegistrySeenClearedOnInvalidate(t *testing.T) {
	r := NewRegistry()
	r.Put("1", entry("a", "ua"))
	r.Seen("1", "00", "11", "22", 0)
	r.InvalidateTarget("a")
	if n := r.seenCount(); n != 0 {
		t.Fatalf("seen memory should be dropped, have %d", n)
	}
	r.Put("1", entry("a", "ua"))
	if r.Seen("1", "00", "11", "22", 0) {
		t.Fatal("after invalidate, share memory must be reset")
	}
}

func TestRegistrySeenClearedOnEvict(t *testing.T) {
	r := NewRegistry()
	r.Put("a0", entry("a", "ua"))
	r.Seen("a0", "00", "11", "22", 0)
	for i := 1; i <= 64; i++ {
		r.Put(fmt.Sprintf("a%d", i), entry("a", "ua"))
	}
	if n := r.seenCount(); n != 0 {
		t.Fatalf("seen memory for evicted job should be dropped, have %d", n)
	}
}

func TestRegistryConcurrent(t *testing.T) {
	r := NewRegistry()
	done := make(chan struct{})
	for g := 0; g < 4; g++ {
		go func(g int) {
			defer func() { done <- struct{}{} }()
			for i := 0; i < 200; i++ {
				id := fmt.Sprintf("%d-%d", g, i)
				r.Put(id, entry(fmt.Sprintf("t%d", g%2), "u"))
				r.Get(id)
				r.Seen(id, "00", "11", "22", 0)
				if i%50 == 0 {
					r.InvalidateTarget("t0")
				}
			}
		}(g)
	}
	for g := 0; g < 4; g++ {
		<-done
	}
}
