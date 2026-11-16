package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeEnricher struct {
	entries map[Hash]MempoolEntry
	raws    map[Hash]*Tx
	calls   int
}

func (f *fakeEnricher) MempoolEntries(_ context.Context, txids []Hash) (map[Hash]MempoolEntry, error) {
	f.calls++
	out := map[Hash]MempoolEntry{}
	for _, t := range txids {
		if e, ok := f.entries[t]; ok {
			out[t] = e
		}
	}
	return out, nil
}

func (f *fakeEnricher) RawTransactions(_ context.Context, txids []Hash, _ bool) (map[Hash]*Tx, error) {
	out := map[Hash]*Tx{}
	for _, t := range txids {
		if tx, ok := f.raws[t]; ok {
			out[t] = tx
		}
	}
	return out, nil
}

type fakeWriter struct {
	mu      sync.Mutex
	ops     []Op
	failN   int
	written chan struct{}
}

func (w *fakeWriter) Write(_ context.Context, ops []Op, _ bool) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.failN > 0 {
		w.failN--
		return errors.New("database down")
	}
	w.ops = append(w.ops, ops...)
	select {
	case w.written <- struct{}{}:
	default:
	}
	return nil
}

func (w *fakeWriter) Close() {}

func TestPipelineEnrichesInOrder(t *testing.T) {
	a, b, c := mkTx("a", coin(1)), mkTx("b", coin(2)), mkTx("c", coin(3))
	en := &fakeEnricher{entries: map[Hash]MempoolEntry{a.Txid: entry(a, 1), c.Txid: entry(c, 1)}, raws: map[Hash]*Tx{c.Txid: c}}
	w := &fakeWriter{written: make(chan struct{}, 10), failN: 1}
	p := NewPipeline(PipelineConfig{EnrichQueue: 100, WriteQueue: 100, EnrichBatch: 10, WriteBatch: 10, Linger: 10 * time.Millisecond},
		en, w, slog.New(slog.NewTextHandler(io.Discard, nil))).Start()
	p.Submit(Op{Insert: &TxRow{Txid: a.Txid, NeedFees: true}})
	p.Submit(Op{Insert: &TxRow{Txid: b.Txid, NeedFees: true}}) // left before getmempoolentry
	p.Submit(Op{Remove: &Removal{Txid: b.Txid, Reason: reasonReplaced}})
	p.Submit(Op{Insert: &TxRow{Txid: c.Txid, NeedFees: true, NeedRaw: true}})
	p.Close(5 * time.Second)
	if len(w.ops) != 4 {
		t.Fatalf("%d ops written (one failed write must be retried)", len(w.ops))
	}
	if w.ops[0].Insert.Entry == nil || w.ops[1].Insert.Entry != nil || w.ops[2].Remove == nil {
		t.Fatalf("order or fees wrong: %+v", w.ops)
	}
	if r := w.ops[3].Insert; r.Entry == nil || len(r.Inputs) != OutpointLen || !r.HaveWtxid || r.Size != 200 {
		t.Fatalf("raw enrichment: %+v", r)
	}
	st := p.Stats()
	if st["db_errors"] != 1 || st["fees_missing"] != 1 || st["fees_enriched"] != 2 || st["raw_enriched"] != 1 || st["inserts_written"] != 3 {
		t.Fatalf("stats %v", st)
	}
}

func TestQueueDropsOldest(t *testing.T) {
	q := newQueue(3)
	for i := range 5 {
		q.push(Op{Remove: &Removal{Height: i}})
	}
	ops, _ := q.take(10, 0)
	if len(ops) != 3 || ops[0].Remove.Height != 2 || q.dropped != 2 {
		t.Fatalf("got %d ops, first %d, dropped %d", len(ops), ops[0].Remove.Height, q.dropped)
	}
	q.push(Op{Remove: &Removal{Height: 9}})
	q.pushFront(ops) // only 2 of 3 fit: the newest are kept
	ops, _ = q.take(10, 0)
	if len(ops) != 3 || ops[0].Remove.Height != 3 || ops[2].Remove.Height != 9 || q.dropped != 3 {
		t.Fatalf("pushFront: %d ops, dropped %d", len(ops), q.dropped)
	}
}

func TestConfig(t *testing.T) {
	t.Setenv("PG_HOST", "db")
	t.Setenv("PG_USER", "u")
	t.Setenv("BITCOIN_RPC_PASSWORD", "secret")
	c, err := parseConfig([]string{"--store-raw", "--http-port", "9"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if !c.StoreRaw || c.HTTPPort != 9 || c.RPCPassword != "secret" || c.Expiry != 336*time.Hour || c.PGDatabase != "stratum" {
		t.Fatalf("%+v", c)
	}
	for _, args := range [][]string{{"--bitcoin-rpc-password", "x"}, {"--pg-password", "x"}} {
		if _, err := parseConfig(args, io.Discard); err == nil || !strings.Contains(err.Error(), "environment") {
			t.Errorf("%v: %v", args, err)
		}
	}
	t.Setenv("PG_HOST", "")
	if _, err := parseConfig(nil, io.Discard); err == nil {
		t.Error("missing PG_HOST accepted")
	}
}

func TestMetricsRender(t *testing.T) {
	m := &Metrics{}
	m.Removed.Add(reasonMined, 3)
	m.Synced.Store(true)
	m.LastEventUs.Store(time.Now().UnixMicro())
	h := &HealthServer{M: m, MaxSilence: time.Minute}
	out := h.render()
	for _, want := range []string{`stratum_mempool_txs_removed_total{reason="mined"} 3`, `stratum_mempool_txs_removed_total{reason="evicted"} 0`,
		"stratum_mempool_ready 1", `stratum_mempool_resyncs_total{cause="gap"} 0`} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	m.LastEventUs.Store(time.Now().Add(-2 * time.Minute).UnixMicro())
	if ok, _ := h.Ready(); ok {
		t.Error("ready despite silence")
	}
	m.Synced.Store(false)
	if ok, _ := h.Ready(); ok {
		t.Error("ready while unsynced")
	}
}

func TestInputRows(t *testing.T) {
	a := mkTx("a", coin(1), outpoint(hashOf("x", 0), 7))
	r := &TxRow{Txid: a.Txid, FirstSeen: 5, Inputs: a.Inputs}
	rows := r.inputRows()
	x := hashOf("x", 0)
	if len(rows) != 2 || rows[1][2] != int32(1) || rows[1][4] != int64(7) || string(rows[1][3].([]byte)) != string(x[:]) {
		t.Fatalf("%v", rows)
	}
	if v := r.values(); v[len(v)-1] != int32(2) {
		t.Fatalf("input_count %v", v[len(v)-1])
	}
	if v := (&TxRow{}).values(); v[len(v)-1] != nil {
		t.Fatal("unknown inputs must be NULL")
	}
}
