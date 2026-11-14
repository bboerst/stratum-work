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

// Health and metrics over HTTP (off unless --http-port is set):
//   /livez    200 while the process serves HTTP
//   /readyz   200 when subscribed to the pool and a mining.notify arrived within --ready-max-notify-age
//   /metrics  Prometheus text format (0.0.4), written with the standard library: the client library would add
//             several MB of binary and resident memory to a process whose point is to be small.

type Metrics struct {
	Templates        atomic.Int64
	LastNotifyNs     atomic.Int64 // receipt time of the last mining.notify
	LastNotifyMono   atomic.Int64
	Reconnects       atomic.Int64
	NotifyMalformed  atomic.Int64
	Subscribed       atomic.Bool
	KernelTimestamps atomic.Bool
	TipUpdates       atomic.Int64

	rxDeltaMu    sync.Mutex
	rxDeltaSum   float64 // seconds the post-read clock trailed the receive timestamp
	rxDeltaCount int64
	rxDeltaMax   float64
}

func (m *Metrics) SetSubscribed(v bool) { m.Subscribed.Store(v) }

func (m *Metrics) Notify(tsNs, appNs int64) {
	m.Templates.Add(1)
	m.LastNotifyNs.Store(tsNs)
	m.LastNotifyMono.Store(monoNs())
	if appNs != tsNs {
		d := float64(appNs-tsNs) / 1e9
		m.rxDeltaMu.Lock()
		m.rxDeltaSum += d
		m.rxDeltaCount++
		m.rxDeltaMax = max(m.rxDeltaMax, d)
		m.rxDeltaMu.Unlock()
	}
}

// Ready: subscribed on the current connection and a mining.notify within maxAge.
func (m *Metrics) Ready(maxAge time.Duration) (bool, string) {
	if !m.Subscribed.Load() {
		return false, "not subscribed"
	}
	last := m.LastNotifyMono.Load()
	if last == 0 || m.Templates.Load() == 0 {
		return false, "no mining.notify yet"
	}
	if age := time.Duration(monoNs() - last); age > maxAge {
		return false, fmt.Sprintf("last mining.notify %s ago", age.Round(time.Second))
	}
	return true, "ok"
}

type HealthServer struct {
	Metrics    *Metrics
	MaxAge     time.Duration
	Labels     map[string]string // info labels: pool, site, replica, version
	PG         *PostgresSink
	RMQ        *RabbitMQPublisher
	Classifier *Classifier
	Tracker    *LatencyTracker
	Tip        *TipState
	log        *slog.Logger
}

func (h *HealthServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/livez", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		ok, why := h.Metrics.Ready(h.MaxAge)
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
	m := h.Metrics
	var p promWriter
	const ns = "stratum_collector_"
	p.metric(ns+"info", "gauge", "Collector identity.")
	p.sample(ns+"info", h.Labels, 1)
	p.metric(ns+"templates_received_total", "counter", "mining.notify messages received.")
	p.sample(ns+"templates_received_total", nil, float64(m.Templates.Load()))
	p.metric(ns+"last_notify_timestamp_seconds", "gauge", "Receipt time of the last mining.notify (unix seconds).")
	p.sample(ns+"last_notify_timestamp_seconds", nil, float64(m.LastNotifyNs.Load())/1e9)
	p.metric(ns+"notify_malformed_total", "counter", "mining.notify messages skipped as malformed.")
	p.sample(ns+"notify_malformed_total", nil, float64(m.NotifyMalformed.Load()))
	p.metric(ns+"reconnects_total", "counter", "Lost or failed pool connections.")
	p.sample(ns+"reconnects_total", nil, float64(m.Reconnects.Load()))
	p.metric(ns+"subscribed", "gauge", "1 while subscribed to the pool.")
	p.sample(ns+"subscribed", nil, b2f(m.Subscribed.Load()))
	ready, _ := m.Ready(h.MaxAge)
	p.metric(ns+"ready", "gauge", "1 while /readyz succeeds.")
	p.sample(ns+"ready", nil, b2f(ready))
	p.metric(ns+"kernel_rx_timestamps", "gauge", "1 if receipt times come from kernel receive timestamps.")
	p.sample(ns+"kernel_rx_timestamps", nil, b2f(m.KernelTimestamps.Load()))
	m.rxDeltaMu.Lock()
	sum, cnt, mx := m.rxDeltaSum, m.rxDeltaCount, m.rxDeltaMax
	m.rxDeltaMu.Unlock()
	p.metric(ns+"rx_clock_lag_seconds", "summary", "How far the post-read clock trailed the kernel receive timestamp.")
	p.sample(ns+"rx_clock_lag_seconds_sum", nil, sum)
	p.sample(ns+"rx_clock_lag_seconds_count", nil, float64(cnt))
	p.metric(ns+"rx_clock_lag_max_seconds", "gauge", "Largest post-read clock lag seen.")
	p.sample(ns+"rx_clock_lag_max_seconds", nil, mx)
	if h.Tracker != nil {
		p.metric(ns+"latency_estimate_ms", "gauge", "Current one-way latency estimate (RTT/2) by method.")
		if e := h.Tracker.Estimate(); e != nil {
			p.sample(ns+"latency_estimate_ms", map[string]string{"method": e.method}, e.ms)
		}
	}
	if h.Tip != nil {
		tip, ok := h.Tip.Current()
		p.metric(ns+"btc_tip_height", "gauge", "Bitcoin tip used for classification (0 = unknown or stale).")
		if !ok {
			tip = 0
		}
		p.sample(ns+"btc_tip_height", nil, float64(tip))
		p.metric(ns+"btc_tip_updates_total", "counter", "Tip updates from ZMQ block notifications.")
		p.sample(ns+"btc_tip_updates_total", nil, float64(m.TipUpdates.Load()))
	}
	if h.Classifier != nil {
		p.metric(ns+"bch_lookups_total", "counter", "BCH confirmation API lookups.")
		p.sample(ns+"bch_lookups_total", nil, float64(h.Classifier.Lookups.Load()))
		p.metric(ns+"bch_lookups_skipped_total", "counter", "Lookups skipped (queue full); classified unknown.")
		p.sample(ns+"bch_lookups_skipped_total", nil, float64(h.Classifier.SkippedFullQ.Load()))
	}
	p.metric(ns+"sink_queue_depth", "gauge", "Documents waiting in a sink queue.")
	p.metric(ns+"sink_events_total", "counter", "Sink counters (submitted, written, dropped by reason, errors).")
	var events []string
	if h.Classifier != nil {
		p.sample(ns+"sink_queue_depth", map[string]string{"sink": "bch_lookup"}, float64(h.Classifier.Queued()))
	}
	if h.PG != nil {
		p.sample(ns+"sink_queue_depth", map[string]string{"sink": "postgres"}, float64(h.PG.Queued()))
		st := h.PG.Stats()
		for _, k := range pgStatKeys {
			events = append(events, fmt.Sprintf("postgres\x00%s\x00%d", k, st[k]))
		}
	}
	if h.RMQ != nil {
		p.sample(ns+"sink_queue_depth", map[string]string{"sink": "rabbitmq"}, float64(h.RMQ.Queued()))
		st := h.RMQ.Stats()
		for _, k := range rmqStatKeys {
			events = append(events, fmt.Sprintf("rabbitmq\x00%s\x00%d", k, st[k]))
		}
	}
	for _, e := range events {
		parts := strings.SplitN(e, "\x00", 3)
		v, _ := strconv.ParseFloat(parts[2], 64)
		p.sample(ns+"sink_events_total", map[string]string{"sink": parts[0], "event": parts[1]}, v)
	}
	return p.b.String()
}
