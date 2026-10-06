// Package admin serves the router's health, status and Prometheus endpoints.
package admin

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/bboerst/stratum-work/router/internal/publish"
	"github.com/bboerst/stratum-work/router/internal/router"
)

// Conn is a per-connection entry in /status (no remote addresses).
type Conn struct {
	ID        uint64  `json:"id"`
	Worker    string  `json:"worker"`
	Hs        float64 `json:"hs"`
	Diff      float64 `json:"diff"`
	Target    string  `json:"target"`
	Accepted  uint64  `json:"accepted"`
	Invalid   uint64  `json:"invalid"`
	Stale     uint64  `json:"stale"`
	Duplicate uint64  `json:"duplicate"`
}

// StatusResponse is the /status body: the routing message plus connections.
// All workers are listed (no minimum-work filter).
type StatusResponse struct {
	publish.Routing
	Connections []Conn `json:"connections"`
}

// Handler returns the admin mux. src is called on every request/scrape.
func Handler(src func() router.Status) http.Handler {
	reg := prometheus.NewRegistry()
	reg.MustRegister(&collector{src: src})

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, _ *http.Request) {
		st := src()
		resp := StatusResponse{
			Routing:     publish.BuildRouting(st, time.Now(), 0),
			Connections: make([]Conn, 0, len(st.Connections)),
		}
		for _, c := range st.Connections {
			resp.Connections = append(resp.Connections, Conn{
				ID: c.ID, Worker: c.Worker, Hs: c.Hs, Diff: c.Diff, Target: c.Target,
				Accepted: c.Accepted, Invalid: c.Invalid, Stale: c.Stale, Duplicate: c.Duplicate,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	mux.Handle("GET /metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
	return mux
}

var (
	descConnections = prometheus.NewDesc("router_connections",
		"Current downstream connections.", nil, nil)
	descShares = prometheus.NewDesc("router_shares_total",
		"Downstream shares by result.", []string{"result"}, nil)
	descSubmits = prometheus.NewDesc("router_upstream_submits_total",
		"Upstream submits by target and result.", []string{"target", "result"}, nil)
	descDelivered = prometheus.NewDesc("router_target_delivered_hashrate",
		"Delivered hashrate per target (H/s).", []string{"target"}, nil)
	descConfigured = prometheus.NewDesc("router_target_configured_hashrate",
		"Configured hashrate per target (H/s).", []string{"target"}, nil)
	descTotal = prometheus.NewDesc("router_total_hashrate",
		"Total downstream hashrate (H/s).", nil, nil)
	descConnected = prometheus.NewDesc("router_upstream_connected",
		"1 if the target upstream is available.", []string{"target"}, nil)
	descFallback = prometheus.NewDesc("router_fallback_active",
		"1 if the remainder fallback is active.", nil, nil)
)

var shareResults = []string{"accepted", "invalid", "stale", "duplicate"}

type collector struct{ src func() router.Status }

func (c *collector) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{descConnections, descShares, descSubmits,
		descDelivered, descConfigured, descTotal, descConnected, descFallback} {
		ch <- d
	}
}

func b2f(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

func (c *collector) Collect(ch chan<- prometheus.Metric) {
	st := c.src()
	ch <- prometheus.MustNewConstMetric(descConnections, prometheus.GaugeValue, float64(len(st.Connections)))
	for _, r := range shareResults {
		ch <- prometheus.MustNewConstMetric(descShares, prometheus.CounterValue, float64(st.Counters.Shares[r]), r)
	}
	targets := make([]string, 0, len(st.Counters.UpstreamSubmits))
	for t := range st.Counters.UpstreamSubmits {
		targets = append(targets, t)
	}
	sort.Strings(targets)
	for _, t := range targets {
		for r, n := range st.Counters.UpstreamSubmits[t] {
			ch <- prometheus.MustNewConstMetric(descSubmits, prometheus.CounterValue, float64(n), t, r)
		}
	}
	for _, t := range st.Targets {
		ch <- prometheus.MustNewConstMetric(descDelivered, prometheus.GaugeValue, t.DeliveredHs, t.ID)
		ch <- prometheus.MustNewConstMetric(descConfigured, prometheus.GaugeValue, t.TargetHs, t.ID)
		ch <- prometheus.MustNewConstMetric(descConnected, prometheus.GaugeValue, b2f(t.Available), t.ID)
	}
	ch <- prometheus.MustNewConstMetric(descTotal, prometheus.GaugeValue, st.TotalHs)
	ch <- prometheus.MustNewConstMetric(descFallback, prometheus.GaugeValue, b2f(st.Remainder.FallbackActive))
}
