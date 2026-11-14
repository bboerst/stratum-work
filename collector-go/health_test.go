package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestReadiness(t *testing.T) {
	m := &Metrics{}
	if ok, _ := m.Ready(10 * time.Minute); ok {
		t.Error("ready before subscribing")
	}
	m.SetSubscribed(true)
	if ok, _ := m.Ready(10 * time.Minute); ok {
		t.Error("ready before the first mining.notify")
	}
	m.Notify(time.Now().UnixNano(), time.Now().UnixNano())
	if ok, why := m.Ready(10 * time.Minute); !ok {
		t.Error(why)
	}
	m.LastNotifyMono.Store(monoNs() - int64(11*time.Minute))
	if ok, _ := m.Ready(10 * time.Minute); ok {
		t.Error("ready with a stale notify")
	}
	m.Notify(time.Now().UnixNano(), time.Now().UnixNano())
	m.SetSubscribed(false)
	if ok, _ := m.Ready(10 * time.Minute); ok {
		t.Error("ready while disconnected")
	}
}

func get(t *testing.T, h http.Handler, path string) (int, string) {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	b, _ := io.ReadAll(rec.Body)
	return rec.Code, string(b)
}

func TestHealthEndpointsAndMetrics(t *testing.T) {
	m := &Metrics{}
	pg := NewPostgresSink(testPGCfg, "P", "", func() (int64, bool) { return 0, false }, quietLog)
	rmq := NewRabbitMQPublisher(testRMQCfg, quietLog)
	pg.Submit(testDoc(nil))
	rmq.Submit(testDoc(nil))
	tr := NewLatencyTracker(false)
	tr.RecordTCPRTTUs(20_000, true)
	hs := &HealthServer{Metrics: m, MaxAge: time.Minute, PG: pg, RMQ: rmq, Tracker: tr, Tip: NewTipState(time.Hour),
		Classifier: NewClassifier(NewTipState(time.Hour), 5, NewBCHConfirmer("http://x", time.Second), nil, quietLog),
		Labels:     map[string]string{"pool": `F2"Pool`, "site": "s", "replica": "b", "version": "dev"}, log: quietLog}
	h := hs.Handler()
	if code, _ := get(t, h, "/livez"); code != 200 {
		t.Error("livez", code)
	}
	if code, body := get(t, h, "/readyz"); code != 503 || !strings.Contains(body, "not subscribed") {
		t.Error("readyz", code, body)
	}
	m.SetSubscribed(true)
	now := time.Now().UnixNano()
	m.Notify(now, now+80_000)
	if code, _ := get(t, h, "/readyz"); code != 200 {
		t.Error("readyz", code)
	}
	_, body := get(t, h, "/metrics")
	// Text format: every sample belongs to the family of the closest preceding TYPE line.
	family := ""
	for _, l := range strings.Split(strings.TrimSpace(body), "\n") {
		if strings.HasPrefix(l, "# TYPE ") {
			family = strings.Fields(l)[2]
			continue
		}
		if strings.HasPrefix(l, "#") {
			continue
		}
		name := strings.FieldsFunc(l, func(r rune) bool { return r == '{' || r == ' ' })[0]
		if name != family && strings.TrimSuffix(strings.TrimSuffix(name, "_sum"), "_count") != family {
			t.Errorf("sample %q outside its family (%s)", name, family)
		}
	}
	for _, want := range []string{
		`stratum_collector_info{pool="F2\"Pool",replica="b",site="s",version="dev"} 1`,
		"stratum_collector_templates_received_total 1",
		"stratum_collector_subscribed 1",
		"stratum_collector_ready 1",
		`stratum_collector_sink_queue_depth{sink="postgres"} 1`,
		`stratum_collector_sink_queue_depth{sink="rabbitmq"} 1`,
		`stratum_collector_sink_events_total{event="submitted",sink="postgres"} 1`,
		`stratum_collector_sink_events_total{event="dropped_queue_full",sink="rabbitmq"} 0`,
		`stratum_collector_latency_estimate_seconds{method="tcp"} 0.01`,
		"stratum_collector_rx_clock_lag_seconds_count 1",
		"stratum_collector_rx_clock_lag_max_seconds 8e-05",
		"# TYPE stratum_collector_reconnects_total counter",
	} {
		if !strings.Contains(body, want+"\n") {
			t.Errorf("missing %q in\n%s", want, body)
		}
	}
}
