package main

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"os"
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
	"time"
	"unsafe"
)

// TestMemory150k measures the recorder's resident memory with a synthetic 150k-transaction mempool (2.5 inputs per
// transaction on average, like mainnet), followed through ZMQ events and then resynced from a snapshot (the peak:
// the old and new tracked sets coexist briefly). Opt-in, since it takes a few seconds and prints numbers:
//
//	MEMPOOL_MEMORY_TEST=1 go test -run TestMemory150k -v
func TestMemory150k(t *testing.T) {
	if os.Getenv("MEMPOOL_MEMORY_TEST") == "" {
		t.Skip("set MEMPOOL_MEMORY_TEST=1")
	}
	const n = 150_000
	base := rss(t)
	node := newFakeNode()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ops := 0
	r := NewRecorder(DefaultRecorderConfig(), node, nil, func(Op) { ops++ }, nil, nil, &Metrics{}, log)
	r.cfg.RawWait = 0
	if err := r.Resync(context.Background()); err != nil {
		t.Fatal(err)
	}
	txs := make([]*Tx, n)
	for i := range txs {
		k := 1 + i%2 + (i%4)/3 // 1, 2, 1, 3 ... avg ~2.5 with the extra below
		if i%2 == 1 {
			k++
		}
		var ins [][]byte
		for j := range k {
			ins = append(ins, coin(i*4+j))
		}
		txs[i] = mkTx("m", ins...)
		txs[i].Txid = hashOf("mem", i)
	}
	start := time.Now()
	cpu0 := cpuTime()
	var z uint32
	for i, tx := range txs {
		z++
		r.HandleRaw(RawEvent{Tx: tx, ZSeq: z, At: int64(i)})
		r.HandleSeq(context.Background(), SeqEvent{Kind: 'A', Hash: tx.Txid, MSeq: uint64(i + 1), ZSeq: z, At: int64(i)})
	}
	addTook, addCPU := time.Since(start), cpuTime()-cpu0
	txs = nil
	// The snapshot the fake node will serve at the resync below (a real node streams it; built now so it's in
	// the steady-state number, not the resync's).
	for txid := range r.txs {
		node.snap = append(node.snap, MempoolEntry{Txid: txid, Time: 0})
	}
	node.snapSeq = n + 1
	snapBytes := int64(cap(node.snap)) * int64(unsafe.Sizeof(MempoolEntry{}))
	runtime.GC()
	debug.FreeOSMemory()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	steady := rss(t)
	inputs := 0
	for _, st := range r.txs {
		inputs += len(st.inputs) / OutpointLen
	}
	t.Logf("tracked %d txs, %d inputs (%.2f per tx); %d ops emitted", len(r.txs), inputs, float64(inputs)/float64(len(r.txs)), ops)
	t.Logf("A events: %s wall, %s CPU (%.1f µs per tx)", addTook.Round(time.Millisecond), addCPU.Round(time.Millisecond),
		float64(addCPU.Microseconds())/n)
	steady -= snapBytes
	t.Logf("heap in use %.1f MiB (incl. the fake node's %.1f MiB snapshot); recorder RSS %.1f MiB above the %.1f MiB baseline (%.0f bytes per tx)",
		float64(ms.HeapInuse)/(1<<20), float64(snapBytes)/(1<<20), float64(steady-base)/(1<<20), float64(base)/(1<<20), float64(steady-base)/n)

	// Resync with all of them in the snapshot (all kept, so no inserts): peak memory.
	peak := peakRSS{t: t}
	stop := peak.watch()
	cpu0 = cpuTime()
	start = time.Now()
	if err := r.Resync(context.Background()); err != nil {
		t.Fatal(err)
	}
	took, cpu := time.Since(start), cpuTime()-cpu0
	stop()
	t.Logf("resync of %d txs: %s wall, %s CPU; peak recorder RSS %.1f MiB above baseline (GOMEMLIMIT %q)", len(r.txs),
		took.Round(time.Millisecond), cpu.Round(time.Millisecond), float64(peak.max-snapBytes-base)/(1<<20), os.Getenv("GOMEMLIMIT"))
	if len(r.txs) != n {
		t.Fatalf("tracked %d after resync", len(r.txs))
	}
}

func rss(t *testing.T) int64 {
	f, err := os.Open("/proc/self/status")
	if err != nil {
		t.Skip("no /proc")
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		if v, ok := strings.CutPrefix(s.Text(), "VmRSS:"); ok {
			var kb int64
			for _, c := range strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(v), "kB")) {
				kb = kb*10 + int64(c-'0')
			}
			return kb * 1024
		}
	}
	return 0
}

type peakRSS struct {
	t   *testing.T
	max int64
}

func (p *peakRSS) watch() func() {
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			p.max = max(p.max, rss(p.t))
			select {
			case <-done:
				return
			case <-time.After(5 * time.Millisecond):
			}
		}
	}()
	return func() { close(done); <-stopped; p.max = max(p.max, rss(p.t)) }
}

func cpuTime() time.Duration {
	b, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b)[strings.LastIndexByte(string(b), ')')+2:])
	var ticks int64
	for _, i := range []int{11, 12} { // utime, stime (fields 14, 15)
		var v int64
		for _, c := range f[i] {
			v = v*10 + int64(c-'0')
		}
		ticks += v
	}
	return time.Duration(ticks) * 10 * time.Millisecond // USER_HZ = 100
}
