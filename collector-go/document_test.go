package main

import (
	"math"
	"regexp"
	"strings"
	"testing"
)

// Ported from collector/tests/test_latency_integration.py and the create_notification_document cases of
// test_chain_detection.py (the full field-by-field comparison with Python is golden_test.go).

func docFromLine(t *testing.T, line string, lat *latencyEstimate) *Document {
	msg, err := pyLoads([]byte(line))
	if err != nil {
		t.Fatal(err)
	}
	p, ok := notifyParams(msg)
	if !ok {
		t.Fatal("params")
	}
	return newDocument(p, "test-pool", pyString("aa"), pyIntOf(4), 0x17abc, lat)
}

func TestDocumentIncludesLatencyWhenEstimated(t *testing.T) {
	d := docFromLine(t, notifyLine("job1"), &latencyEstimate{12.5, "tcp"})
	j := string(d.JSON())
	if !strings.Contains(j, `"lat_ms": 12.5, "lat_m": "tcp"`) || strings.Contains(j, "latency_ms") {
		t.Error(j)
	}
}

func TestDocumentOmitsLatencyWhenUnknown(t *testing.T) {
	if j := string(docFromLine(t, notifyLine("job1"), nil).JSON()); strings.Contains(j, "lat_") {
		t.Error(j)
	}
}

func TestDocumentFieldOrderAndTypes(t *testing.T) {
	d := docFromLine(t, notifyLine("job1"), nil)
	j := string(d.JSON())
	re := regexp.MustCompile(`^\{"_id": "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", "timestamp": "17abc", "pool_name": "test-pool", "height": 975507, "job_id": "job1", "prev_hash": "1{64}", "coinbase1": "[0-9a-f]+", "coinbase2": "ffffffff", "merkle_branches": \[\], "version": "20000000", "nbits": "1702e5b4", "ntime": "69d72a43", "clean_jobs": true, "extranonce1": "aa", "extranonce2_length": 4\}$`)
	if !re.MatchString(j) {
		t.Error(j)
	}
}

func TestChainFamilyOnlyWhenClassified(t *testing.T) {
	d := docFromLine(t, notifyLine("job1"), nil)
	if strings.Contains(string(d.JSON()), "chain_family") {
		t.Error("BTC default must omit chain_family")
	}
	for _, fam := range []string{"bch", "unknown"} {
		d.ChainFamily = fam
		if !strings.HasSuffix(string(d.JSON()), `, "chain_family": "`+fam+`"}`) {
			t.Error(string(d.JSON()))
		}
	}
}

func TestHeightParseFailureIsZero(t *testing.T) {
	line := strings.Replace(notifyLine("j"), testCB1, "coinbase1", 1)
	if d := docFromLine(t, line, nil); d.Height != 0 {
		t.Error(d.Height)
	}
}

func TestPyFloatRepr(t *testing.T) {
	for f, want := range map[float64]string{1: "1.0", 0.5: "0.5", 1e16: "1e+16", 1e15: "1000000000000000.0",
		0.0001: "0.0001", 0.00001: "1e-05", 12.3455: "12.3455", 1.5e300: "1.5e+300", 5e-324: "5e-324",
		123456789.123: "123456789.123"} {
		if got := pyFloatRepr(f); got != want {
			t.Errorf("%v: %s, want %s", f, got, want)
		}
	}
	if got := pyFloatRepr(math.Copysign(0, -1)); got != "-0.0" {
		t.Error(got)
	}
}

func TestUUID4(t *testing.T) {
	a, b := uuid4(), uuid4()
	if a == b || !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(a) {
		t.Error(a, b)
	}
}
