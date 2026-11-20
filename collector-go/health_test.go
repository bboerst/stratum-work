package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
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
	pg := NewPostgresSink(testPGCfg, "P", "", quietLog)
	rmq := NewRabbitMQPublisher(testRMQCfg, quietLog)
	pg.Submit(testDoc(nil))
	rmq.Submit(testDoc(nil))
	tr := NewLatencyTracker(false)
	tr.RecordTCPRTTUs(20_000, true)
	hs := &HealthServer{Metrics: m, MaxAge: time.Minute, PG: pg, RMQ: rmq, Tracker: tr,
		Labels: map[string]string{"pool": `F2"Pool`, "site": "s", "replica": "b", "version": "dev"}, log: quietLog}
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
	// The collector no longer follows a tip or classifies chains (docs/design/one-templates-table.md).
	for _, gone := range []string{"btc_tip", "bch_", "written_other"} {
		if strings.Contains(body, gone) {
			t.Errorf("unexpected %q in\n%s", gone, body)
		}
	}
}

// sampleValue is the value of the unlabelled sample `name` in a /metrics body.
func sampleValue(t *testing.T, body, name string) float64 {
	t.Helper()
	for _, l := range strings.Split(body, "\n") {
		if f := strings.Fields(l); len(f) == 2 && f[0] == name {
			v, err := strconv.ParseFloat(f[1], 64)
			if err != nil {
				t.Fatalf("%s: %v", l, err)
			}
			return v
		}
	}
	t.Fatalf("no sample %s in\n%s", name, body)
	return 0
}

// The "no template for N s" alert reads these two gauges: the last template's receipt time, and the process start
// for a collector that has had none since it started (README "Metrics").
func TestLastTemplateAndStartTimeGauges(t *testing.T) {
	m := &Metrics{}
	hs := &HealthServer{Metrics: m, MaxAge: time.Minute, log: quietLog}
	h := hs.Handler()
	_, body := get(t, h, "/metrics")
	for _, want := range []string{
		"# TYPE stratum_collector_last_notify_timestamp_seconds gauge",
		"# TYPE stratum_collector_start_time_seconds gauge",
	} {
		if !strings.Contains(body, want+"\n") {
			t.Errorf("missing %q", want)
		}
	}
	if v := sampleValue(t, body, "stratum_collector_last_notify_timestamp_seconds"); v != 0 {
		t.Errorf("last notify before any template = %v, want 0", v)
	}
	start := sampleValue(t, body, "stratum_collector_start_time_seconds")
	if now := float64(time.Now().Unix()); start <= 0 || start > now+1 {
		t.Errorf("start time %v, now %v", start, now)
	}

	ts := time.Date(2026, 11, 20, 12, 0, 0, 250_000_000, time.UTC).UnixNano()
	m.Notify(ts, ts+1000)
	_, body = get(t, h, "/metrics")
	if v, want := sampleValue(t, body, "stratum_collector_last_notify_timestamp_seconds"), float64(ts)/1e9; v != want {
		t.Errorf("last notify = %v, want %v (the receipt time)", v, want)
	}
	if v := sampleValue(t, body, "stratum_collector_start_time_seconds"); v != start {
		t.Errorf("start time moved: %v -> %v", start, v)
	}
	m.Notify(ts+int64(time.Second), ts+int64(time.Second))
	_, body = get(t, h, "/metrics")
	if v, want := sampleValue(t, body, "stratum_collector_last_notify_timestamp_seconds"), float64(ts+int64(time.Second))/1e9; v != want {
		t.Errorf("last notify = %v, want %v", v, want)
	}
}

// Scrapes while templates arrive (go test -race).
func TestMetricsRenderConcurrentWithNotify(t *testing.T) {
	m := &Metrics{}
	hs := &HealthServer{Metrics: m, MaxAge: time.Minute, log: quietLog}
	h := hs.Handler()
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 500; i++ {
			now := time.Now().UnixNano()
			m.Notify(now, now+int64(i))
		}
	}()
	for i := 0; i < 50; i++ {
		get(t, h, "/metrics")
	}
	<-done
	_, body := get(t, h, "/metrics")
	if v := sampleValue(t, body, "stratum_collector_templates_received_total"); v != 500 {
		t.Errorf("templates = %v, want 500", v)
	}
	if v := sampleValue(t, body, "stratum_collector_last_notify_timestamp_seconds"); v <= 0 {
		t.Errorf("last notify = %v", v)
	}
}
