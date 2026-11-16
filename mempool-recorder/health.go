package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Health and metrics over HTTP (off unless --http-port is set), like collector-go:
//   /livez    200 while the process serves HTTP
//   /readyz   200 when synced with the node's mempool, the last reconciliation RPC succeeded recently, and (unless
//             --ready-max-silence is 0) a sequence event arrived recently
//   /metrics  Prometheus text format (0.0.4), written with the standard library (no client library: smaller binary
//             and resident memory)

// Labeled is a set of counters keyed by one label value.
type Labeled struct {
	mu sync.Mutex
	m  map[string]int64
}

func (l *Labeled) Add(k string, n int64) {
	l.mu.Lock()
	if l.m == nil {
		l.m = map[string]int64{}
	}
	l.m[k] += n
	l.mu.Unlock()
}

func (l *Labeled) Get(k string) int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.m[k]
}

func (l *Labeled) snapshot(keys []string) map[string]int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := map[string]int64{}
	for _, k := range keys {
		out[k] = 0
	}
	for k, v := range l.m {
		out[k] = v
	}
	return out
}

type Metrics struct {
	Events               Labeled // sequence messages by type (A, R, C, D)
	Gaps                 Labeled // ZMQ message counter gaps by topic
	Added                Labeled // rows created, by first_seen source
	Removed              Labeled // removals by reason
	Blocks               Labeled // connect / disconnect
	Resyncs              Labeled // by cause
	Stale                atomic.Int64
	Duplicates           atomic.Int64
	RawMissing           atomic.Int64
	RawUnparsable        atomic.Int64
	UnknownRemovals      atomic.Int64
	OffMempoolCandidates atomic.Int64
	LastEventUs          atomic.Int64
	NodeTxs              atomic.Int64
	NodeBytes            atomic.Int64
	Synced               atomic.Bool
}

type HealthServer struct {
	M           *Metrics
	Rec         *Recorder
	Pipe        *Pipeline
	RPC         *RPC
	MaxSilence  time.Duration
	MaxRPCAge   time.Duration
	Labels      map[string]string
	ZMQUp       func() map[string]bool
	ZMQMessages func() map[string]int64
	log         *slog.Logger
}

func (h *HealthServer) Ready() (bool, string) {
	if !h.M.Synced.Load() {
		return false, "not synced with the node's mempool"
	}
	if h.ZMQUp != nil {
		for topic, up := range h.ZMQUp() {
			if !up {
				return false, "ZMQ " + topic + " not connected"
			}
		}
	}
	if h.Rec != nil && h.MaxRPCAge > 0 {
		if t := h.Rec.lastReconcileOK.Load(); t == 0 || time.Since(time.UnixMicro(t)) > h.MaxRPCAge {
			return false, "no successful reconciliation with the node recently"
		}
	}
	if h.MaxSilence > 0 {
		last := h.M.LastEventUs.Load()
		if last == 0 {
			return false, "no sequence event yet"
		}
		if age := time.Since(time.UnixMicro(last)); age > h.MaxSilence {
			return false, fmt.Sprintf("last sequence event %s ago", age.Round(time.Second))
		}
	}
	return true, "ok"
}

func (h *HealthServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/livez", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		ok, why := h.Ready()
		if !ok {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		fmt.Fprintln(w, why)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(h.render()))
	})
	return mux
}

func (h *HealthServer) Serve(ctx context.Context, addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: h.Handler(), ReadHeaderTimeout: 5 * time.Second}
	context.AfterFunc(ctx, func() { _ = srv.Close() })
	h.log.Info("health/metrics server listening", "addr", ln.Addr().String())
	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			h.log.Error("health server stopped", "err", err)
		}
	}()
	return nil
}

type promWriter struct{ b strings.Builder }

func (p *promWriter) metric(name, typ, help string) {
	fmt.Fprintf(&p.b, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, typ)
}

func (p *promWriter) sample(name string, labels map[string]string, v float64) {
	p.b.WriteString(name)
	if len(labels) > 0 {
		keys := make([]string, 0, len(labels))
		for k := range labels {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		p.b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				p.b.WriteByte(',')
			}
			p.b.WriteString(k + `="` + promEscape(labels[k]) + `"`)
		}
		p.b.WriteByte('}')
	}
	p.b.WriteByte(' ')
	p.b.WriteString(strconv.FormatFloat(v, 'g', -1, 64))
	p.b.WriteByte('\n')
}

func (p *promWriter) labeled(name, typ, help, label string, l *Labeled, keys []string) {
	p.metric(name, typ, help)
	snap := l.snapshot(keys)
	ks := make([]string, 0, len(snap))
	for k := range snap {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	for _, k := range ks {
		p.sample(name, map[string]string{label: k}, float64(snap[k]))
	}
}

func promEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, "\n", `\n`, `"`, `\"`).Replace(s)
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func (h *HealthServer) render() string {
	m := h.M
	var p promWriter
	const ns = "stratum_mempool_"
	p.metric(ns+"info", "gauge", "Recorder identity.")
	p.sample(ns+"info", h.Labels, 1)
	p.labeled(ns+"events_total", "counter", "ZMQ sequence messages received, by type (A add, R remove, C connect, D disconnect).",
		"type", &m.Events, []string{"A", "R", "C", "D"})
	p.labeled(ns+"txs_added_total", "counter", "Transaction rows created, by first_seen source (zmq: A event; mempool: node entry time at a sync).",
		"source", &m.Added, []string{srcZMQ, srcMempool})
	p.labeled(ns+"txs_removed_total", "counter", "Transactions that left the mempool, by inferred reason.",
		"reason", &m.Removed, removalReasons)
	p.labeled(ns+"blocks_total", "counter", "Blocks connected / disconnected.", "event", &m.Blocks, []string{"connect", "disconnect"})
	p.labeled(ns+"resyncs_total", "counter", "Full mempool syncs, by cause (startup, gap, drift, block_fetch).",
		"cause", &m.Resyncs, []string{"startup", "gap", "drift", "block_fetch"})
	p.labeled(ns+"zmq_gaps_total", "counter", "Gaps in a topic's ZMQ message counter (dropped messages).",
		"topic", &m.Gaps, []string{"sequence", "rawtx"})
	if h.ZMQMessages != nil {
		p.metric(ns+"zmq_messages_total", "counter", "ZMQ messages received, by topic.")
		msgs := h.ZMQMessages()
		keys := make([]string, 0, len(msgs))
		for k := range msgs {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			p.sample(ns+"zmq_messages_total", map[string]string{"topic": k}, float64(msgs[k]))
		}
	}
	if h.ZMQUp != nil {
		p.metric(ns+"zmq_connected", "gauge", "1 while the topic's ZMQ subscription is connected.")
		up := h.ZMQUp()
		keys := make([]string, 0, len(up))
		for k := range up {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			p.sample(ns+"zmq_connected", map[string]string{"topic": k}, b2f(up[k]))
		}
	}
	for _, c := range []struct {
		name, help string
		v          int64
	}{
		{"stale_events_total", "A/R events at or below the synced mempool sequence (already in the snapshot), skipped.", m.Stale.Load()},
		{"duplicate_adds_total", "A events for a transaction already tracked, skipped.", m.Duplicates.Load()},
		{"rawtx_missing_total", "A events whose rawtx message didn't arrive in time (fetched with getrawtransaction instead).", m.RawMissing.Load()},
		{"rawtx_unparsable_total", "rawtx messages that didn't parse as a transaction.", m.RawUnparsable.Load()},
		{"unknown_removals_total", "R events for transactions never tracked (e.g. trimmed right after acceptance, which publishes no A).", m.UnknownRemovals.Load()},
		{"offmempool_candidates_total", "Block transactions not in our mempool when the block connected (before the database check).", m.OffMempoolCandidates.Load()},
	} {
		p.metric(ns+c.name, "counter", c.help)
		p.sample(ns+c.name, nil, float64(c.v))
	}
	if h.RPC != nil {
		p.metric(ns+"rpc_errors_total", "counter", "Failed Bitcoin RPC calls (transport or RPC error; excludes transactions that already left).")
		p.sample(ns+"rpc_errors_total", nil, float64(h.RPC.Errors.Load()))
	}
	p.metric(ns+"synced", "gauge", "1 while synced with the node's mempool.")
	p.sample(ns+"synced", nil, b2f(m.Synced.Load()))
	ready, _ := h.Ready()
	p.metric(ns+"ready", "gauge", "1 while /readyz succeeds.")
	p.sample(ns+"ready", nil, b2f(ready))
	if h.Rec != nil {
		p.metric(ns+"tracked_txs", "gauge", "Transactions the recorder tracks as in the node's mempool.")
		p.sample(ns+"tracked_txs", nil, float64(h.Rec.Tracked()))
	}
	p.metric(ns+"node_txs", "gauge", "getmempoolinfo size at the last reconciliation.")
	p.sample(ns+"node_txs", nil, float64(m.NodeTxs.Load()))
	p.metric(ns+"node_bytes", "gauge", "getmempoolinfo bytes (sum of vsizes) at the last reconciliation.")
	p.sample(ns+"node_bytes", nil, float64(m.NodeBytes.Load()))
	p.metric(ns+"last_event_timestamp_seconds", "gauge", "Receipt time of the last sequence event (unix seconds).")
	p.sample(ns+"last_event_timestamp_seconds", nil, float64(m.LastEventUs.Load())/1e6)
	if h.Pipe != nil {
		p.metric(ns+"queue_depth", "gauge", "Operations waiting in a pipeline queue.")
		e, w := h.Pipe.Queued()
		p.sample(ns+"queue_depth", map[string]string{"queue": "enrich"}, float64(e))
		p.sample(ns+"queue_depth", map[string]string{"queue": "write"}, float64(w))
		p.metric(ns+"sink_events_total", "counter", "Pipeline counters (ops written, dropped, errors, enrichment results).")
		st := h.Pipe.Stats()
		for _, k := range pipeStatKeys {
			p.sample(ns+"sink_events_total", map[string]string{"event": k}, float64(st[k]))
		}
	}
	return p.b.String()
}
