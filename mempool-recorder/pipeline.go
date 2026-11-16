package main

import (
	"context"
	"log/slog"
	"strconv"
	"sync"
	"time"
)

// Pipeline: recorder ops -> enrich (getmempoolentry / getrawtransaction, batched) -> write (Postgres, batched).
// Both queues are bounded and drop their oldest op when full (counted), so neither a slow node nor a database
// outage can stall the recorder or grow memory without bound. Order is preserved end to end: a removal is never
// written before the row it closes.

type Enricher interface {
	MempoolEntries(ctx context.Context, txids []Hash) (map[Hash]MempoolEntry, error)
	RawTransactions(ctx context.Context, txids []Hash, keepRaw bool) (map[Hash]*Tx, error)
}

// Writer is what the pipeline needs from the database (pgstore.go; a fake in tests).
type Writer interface {
	Write(ctx context.Context, ops []Op, keepRaw bool) error
	Close()
}

type queue struct {
	mu      sync.Mutex
	cond    *sync.Cond
	ops     []Op
	max     int
	stop    bool
	dropped int64
}

func newQueue(max int) *queue {
	q := &queue{max: max}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *queue) push(ops ...Op) {
	q.mu.Lock()
	for _, op := range ops {
		if len(q.ops) >= q.max {
			q.ops[0] = Op{}
			q.ops = q.ops[1:]
			q.dropped++
		}
		q.ops = append(q.ops, op)
	}
	q.mu.Unlock()
	q.cond.Signal()
}

// pushFront puts a failed batch back ahead of newer ops, keeping the newest if they don't all fit.
func (q *queue) pushFront(ops []Op) {
	q.mu.Lock()
	defer q.mu.Unlock()
	room := q.max - len(q.ops)
	if room < len(ops) {
		q.dropped += int64(len(ops) - max(room, 0))
		ops = ops[len(ops)-max(room, 0):]
	}
	q.ops = append(append(make([]Op, 0, len(ops)+len(q.ops)), ops...), q.ops...)
}

// take waits up to linger for n ops (returns early when n are there), then takes what's there. ok is false once
// stopped and empty.
func (q *queue) take(n int, linger time.Duration) (ops []Op, ok bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.ops) == 0 && !q.stop {
		q.cond.Wait()
	}
	if len(q.ops) < n && !q.stop && linger > 0 {
		deadline := time.Now().Add(linger)
		t := time.AfterFunc(linger, q.cond.Broadcast)
		for len(q.ops) < n && !q.stop && time.Now().Before(deadline) {
			q.cond.Wait()
		}
		t.Stop()
	}
	if len(q.ops) == 0 {
		return nil, false
	}
	k := min(n, len(q.ops))
	ops = append([]Op(nil), q.ops[:k]...)
	clear(q.ops[:k])
	q.ops = q.ops[k:]
	return ops, true
}

func (q *queue) len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.ops)
}

func (q *queue) close() {
	q.mu.Lock()
	q.stop = true
	q.mu.Unlock()
	q.cond.Broadcast()
}

type PipelineConfig struct {
	EnrichQueue, WriteQueue int
	EnrichBatch, WriteBatch int
	Linger                  time.Duration // how long a batch waits to fill
	EnrichMinInterval       time.Duration // rate limit: at most one enrichment request per interval
	KeepRaw                 bool
}

type Pipeline struct {
	cfg    PipelineConfig
	node   Enricher
	db     Writer
	log    *slog.Logger
	enrich *queue
	write  *queue

	mu    sync.Mutex
	stats map[string]int64
	done  chan struct{}
}

var pipeStatKeys = []string{"submitted", "inserts_written", "removals_written", "blocks_written", "enrich_dropped",
	"write_dropped", "db_errors", "fees_enriched", "fees_missing", "raw_enriched", "raw_missing", "enrich_errors"}

func NewPipeline(cfg PipelineConfig, node Enricher, db Writer, log *slog.Logger) *Pipeline {
	p := &Pipeline{cfg: cfg, node: node, db: db, log: log, enrich: newQueue(cfg.EnrichQueue), write: newQueue(cfg.WriteQueue),
		stats: map[string]int64{}, done: make(chan struct{})}
	for _, k := range pipeStatKeys {
		p.stats[k] = 0
	}
	return p
}

func (p *Pipeline) count(k string, n int) {
	p.mu.Lock()
	p.stats[k] += int64(n)
	p.mu.Unlock()
}

func (p *Pipeline) Stats() map[string]int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make(map[string]int64, len(p.stats))
	for k, v := range p.stats {
		out[k] = v
	}
	p.enrich.mu.Lock()
	out["enrich_dropped"] = p.enrich.dropped
	p.enrich.mu.Unlock()
	p.write.mu.Lock()
	out["write_dropped"] = p.write.dropped
	p.write.mu.Unlock()
	return out
}

func (p *Pipeline) Queued() (enrich, write int) { return p.enrich.len(), p.write.len() }

// Submit never blocks on I/O.
func (p *Pipeline) Submit(op Op) {
	p.count("submitted", 1)
	p.enrich.push(op)
}

func (p *Pipeline) Start() *Pipeline {
	edone := make(chan struct{})
	go func() { defer close(edone); p.runEnrich() }()
	go func() {
		<-edone
		p.write.close()
	}()
	go func() { defer close(p.done); p.runWrite() }()
	return p
}

// Close drains both queues (best effort, at most timeout).
func (p *Pipeline) Close(timeout time.Duration) {
	p.enrich.close()
	select {
	case <-p.done:
	case <-time.After(timeout):
		p.log.Warn("pipeline: shutdown timed out with ops queued", "enrich", p.enrich.len(), "write", p.write.len())
	}
}

func (p *Pipeline) runEnrich() {
	ctx := context.Background()
	var last time.Time
	for {
		ops, ok := p.enrich.take(p.cfg.EnrichBatch, p.cfg.Linger)
		if !ok {
			return
		}
		var fees, raws []Hash
		for _, op := range ops {
			if r := op.Insert; r != nil {
				if r.NeedFees {
					fees = append(fees, r.Txid)
				}
				if r.NeedRaw {
					raws = append(raws, r.Txid)
				}
			}
		}
		if len(fees)+len(raws) > 0 {
			if wait := p.cfg.EnrichMinInterval - time.Since(last); wait > 0 {
				time.Sleep(wait)
			}
			last = time.Now()
			p.enrichOps(ctx, ops, fees, raws)
		}
		p.write.push(ops...)
	}
}

func (p *Pipeline) enrichOps(ctx context.Context, ops []Op, fees, raws []Hash) {
	var entries map[Hash]MempoolEntry
	var txs map[Hash]*Tx
	if len(fees) > 0 {
		var err error
		if entries, err = p.node.MempoolEntries(ctx, fees); err != nil {
			p.count("enrich_errors", 1)
			p.log.Warn("pipeline: getmempoolentry batch failed; rows are written without fees", "txs", len(fees), "err", err)
		}
	}
	if len(raws) > 0 {
		var err error
		if txs, err = p.node.RawTransactions(ctx, raws, p.cfg.KeepRaw); err != nil {
			p.count("enrich_errors", 1)
			p.log.Warn("pipeline: getrawtransaction batch failed", "txs", len(raws), "err", err)
		}
	}
	for _, op := range ops {
		r := op.Insert
		if r == nil {
			continue
		}
		if r.NeedFees {
			if e, ok := entries[r.Txid]; ok {
				r.Entry = &e
				p.count("fees_enriched", 1)
			} else {
				p.count("fees_missing", 1) // left the mempool before the lookup: recorded without fees
			}
			r.NeedFees = false
		}
		if r.NeedRaw {
			if tx, ok := txs[r.Txid]; ok {
				r.Wtxid, r.HaveWtxid, r.Size, r.Weight, r.VSize = tx.Wtxid, true, tx.Size, tx.Weight, tx.VSize()
				r.Inputs, r.Raw = tx.Inputs, tx.Raw
				p.count("raw_enriched", 1)
			} else {
				if r.Entry != nil { // sizes from the mempool entry at least
					r.Wtxid, r.HaveWtxid, r.Weight, r.VSize = r.Entry.Wtxid, true, r.Entry.Weight, r.Entry.VSize
				}
				p.count("raw_missing", 1)
			}
			r.NeedRaw = false
		}
	}
}

func (p *Pipeline) runWrite() {
	ctx := context.Background()
	defer p.db.Close()
	backoff := time.Second
	for {
		ops, ok := p.write.take(p.cfg.WriteBatch, p.cfg.Linger)
		if !ok {
			return
		}
		wctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		err := p.db.Write(wctx, ops, p.cfg.KeepRaw)
		cancel()
		if err == nil {
			backoff = time.Second
			var ins, rm, blk int
			for _, op := range ops {
				switch {
				case op.Insert != nil:
					ins++
				case op.Remove != nil:
					rm++
				case op.Block != nil:
					blk++
				}
			}
			p.count("inserts_written", ins)
			p.count("removals_written", rm)
			p.count("blocks_written", blk)
			continue
		}
		p.count("db_errors", 1)
		p.log.Error("postgres write failed, retrying", "ops", len(ops), "queued", p.write.len(), "in", backoff, "err", err)
		p.write.pushFront(ops) // retried even while shutting down: Close's timeout bounds the wait
		time.Sleep(backoff)
		backoff = min(backoff*2, 60*time.Second)
	}
}

func fmtStats(m map[string]int64, keys []string) string {
	out := "{"
	for i, k := range keys {
		if i > 0 {
			out += ", "
		}
		out += k + ": " + strconv.FormatInt(m[k], 10)
	}
	return out + "}"
}
