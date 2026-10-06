package admin

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bboerst/stratum-work/router/internal/router"
)

func status() router.Status {
	return router.Status{
		Site:    "us-ash-1",
		TotalHs: 10e12,
		Targets: []router.TargetStatus{
			{ID: "antpool", Pool: "AntPool", TargetHs: 3e12, DeliveredHs: 2.9e12, Available: true},
		},
		Remainder: router.RemainderStatus{ID: "datum", DeliveredHs: 7e12, FallbackActive: true},
		Workers:   []router.WorkerStatus{{Name: "w1", Hs: 10e12, Since: time.Unix(0, 0), WorkSeconds: 9999}},
		Connections: []router.ConnStatus{
			{ID: 1, Worker: "w1", Hs: 10e12, Diff: 1024, Target: "antpool", Accepted: 5, Invalid: 1},
		},
		Counters: router.Counters{
			Shares:          map[string]uint64{"accepted": 5, "invalid": 1},
			UpstreamSubmits: map[string]map[string]uint64{"antpool": {"accepted": 4, "rejected": 1}},
		},
	}
}

func get(t *testing.T, h http.Handler, path string) (*http.Response, string) {
	t.Helper()
	srv := httptest.NewServer(h)
	defer srv.Close()
	resp, err := http.Get(srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func TestHealthz(t *testing.T) {
	resp, _ := get(t, Handler(status), "/healthz")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestMetrics(t *testing.T) {
	resp, body := get(t, Handler(status), "/metrics")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	for _, want := range []string{
		"router_connections 1",
		`router_shares_total{result="accepted"} 5`,
		`router_shares_total{result="stale"} 0`,
		`router_upstream_submits_total{result="rejected",target="antpool"} 1`,
		`router_target_delivered_hashrate{target="antpool"} 2.9e+12`,
		`router_target_configured_hashrate{target="antpool"} 3e+12`,
		"router_total_hashrate 1e+13",
		`router_upstream_connected{target="antpool"} 1`,
		"router_fallback_active 1",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics missing %q\n%s", want, body)
		}
	}
}

func TestStatusJSON(t *testing.T) {
	resp, body := get(t, Handler(status), "/status")
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type %q", ct)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("invalid json: %v\n%s", err, body)
	}
	if got["type"] != "routing" || got["site"] != "us-ash-1" {
		t.Fatalf("got %v", got)
	}
	conns, ok := got["connections"].([]any)
	if !ok || len(conns) != 1 {
		t.Fatalf("connections = %v", got["connections"])
	}
	c := conns[0].(map[string]any)
	if c["worker"] != "w1" || c["target"] != "antpool" || c["accepted"].(float64) != 5 {
		t.Fatalf("conn = %v", c)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	srv := httptest.NewServer(Handler(status))
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/status", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
