package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// Golden test against the Python collector: testdata/golden.json holds, for each raw mining.notify line, what
// Python's json.loads + create_notification_document + json.dumps (the RabbitMQ body) and pgsink.to_row + route
// (the Postgres row) produce. Regenerate with testdata/gen_golden.py.

type goldenCase struct {
	Name       string     `json:"name"`
	Line       string     `json:"line"`
	Sub        *string    `json:"sub"`
	Latency    []any      `json:"latency"`
	Chain      *string    `json:"chain"`
	Tip        *int64     `json:"tip"`
	Ts         int64      `json:"ts"`
	Pool       string     `json:"pool"`
	LoadsError string     `json:"loads_error"`
	JSON       string     `json:"json"`
	Row        string     `json:"row"`
	RowError   string     `json:"row_error"`
	Route      [3]*string `json:"route"`
}

// Rows Python converts but Postgres would reject (Python then fails and retries the whole batch forever); the Go
// sink drops them as invalid instead.
var goldenGoRejects = map[string]bool{
	"job_id 12":         true, // lone surrogate: not encodable as UTF-8 text
	"job_id 20":         true, // NUL in text
	"encoded surrogate": true, // lone surrogate
}

// Python's _process_notification logs msg['params'][1][:16] before building the document; for a prev_hash that is
// neither a str nor a list that raises (and Python reconnects). notifyParams skips these notifications instead.
var goldenNotifyRejects = map[string]bool{"prev_hash 3": true, "prev_hash 8": true}

func rowJSON(r Row, d *Document) string {
	ts := r.ReceivedAt.Format("2006-01-02T15:04:05")
	if us := r.ReceivedAt.Nanosecond() / 1000; us != 0 {
		ts += "." + strings.TrimPrefix(itoaPad(us, 6), "")
	}
	ts += "+00:00"
	hx := func(b []byte) pyValue { return pyString("hex:" + hexLower(b)) }
	v := pyValue{kind: pyList, items: []pyValue{
		pyString("ts:" + ts), pyIntOf(int64(r.SourceID)), pyIntOf(int64(r.Height)), pyString(r.JobID),
		hx(r.PrevHash), hx(r.Coinbase1), hx(r.Coinbase2), hx(r.MerkleBranches),
		pyIntOf(r.Version), pyIntOf(r.Nbits), pyIntOf(r.Ntime), boolValue(r.CleanJobs), hx(r.Extranonce1),
		pyIntOf(int64(r.Extranonce2Len)),
	}}
	if d.HasLatency {
		v.items = append(v.items, pyString("f:"+pyFloatRepr(d.LatencyMs)))
	} else {
		v.items = append(v.items, pyValue{kind: pyNull})
	}
	if r.LatencyMethod != nil {
		v.items = append(v.items, pyString(*r.LatencyMethod))
	} else {
		v.items = append(v.items, pyValue{kind: pyNull})
	}
	return string(pyDumps(v))
}

func itoaPad(n, w int) string {
	s := ""
	for i := 0; i < w; i++ {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	return s
}

func boolValue(b bool) pyValue {
	if b {
		return pyValue{kind: pyTrue}
	}
	return pyValue{kind: pyFalse}
}

func TestGoldenAgainstPython(t *testing.T) {
	raw, err := os.ReadFile("testdata/golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []goldenCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 100 {
		t.Fatalf("only %d golden cases", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			line, _ := base64.StdEncoding.DecodeString(c.Line)
			msg, err := pyLoads(line)
			if c.LoadsError != "" {
				if err == nil {
					t.Fatalf("Python failed to decode (%s), Go decoded it", c.LoadsError)
				}
				return
			}
			if err != nil {
				t.Fatalf("Go failed to decode: %v", err)
			}
			en1, en2 := pyValue{kind: pyNull}, pyIntOf(-1)
			if c.Sub != nil {
				s, err := pyLoads([]byte(*c.Sub))
				if err != nil {
					t.Fatal(err)
				}
				if res, _ := s.get("result"); res.kind == pyList && len(res.items) >= 2 {
					en1, en2 = res.items[len(res.items)-2], res.items[len(res.items)-1]
				}
			}
			params, ok := notifyParams(msg)
			if goldenNotifyRejects[c.Name] {
				if ok {
					t.Error("expected notifyParams to skip this notification")
				}
				return
			}
			if !ok {
				t.Fatal("notifyParams rejected a notification Python processes")
			}
			var lat *latencyEstimate
			if c.Latency != nil {
				lat = &latencyEstimate{c.Latency[0].(float64), c.Latency[1].(string)}
			}
			d := newDocument(params, c.Pool, en1, en2, c.Ts, lat)
			d.ID = "00000000-0000-4000-8000-000000000000"
			if c.Chain != nil {
				d.ChainFamily = *c.Chain
			}
			if got := string(d.JSON()); got != c.JSON {
				t.Errorf("RabbitMQ JSON differs\n go: %s\n py: %s", got, c.JSON)
			}
			row, err := toRow(d, 7)
			if goldenGoRejects[c.Name] {
				if err == nil {
					t.Errorf("expected the Go sink to reject this row")
				}
				return
			}
			if c.RowError != "" {
				if err == nil {
					t.Errorf("Python to_row failed (%s), Go converted it: %s", c.RowError, rowJSON(row, d))
				}
				return
			}
			if err != nil {
				t.Fatalf("Go toRow failed: %v (Python: %s)", err, c.Row)
			}
			if got := rowJSON(row, d); got != c.Row {
				t.Errorf("row differs\n go: %s\n py: %s", got, c.Row)
			}
			var tip int64
			if c.Tip != nil {
				tip = *c.Tip
			}
			r := route(int64(row.Height), d.ChainFamily, tip, c.Tip != nil)
			want := Route{Table: *c.Route[0]}
			if c.Route[1] != nil {
				want.Chain, want.Reason = *c.Route[1], *c.Route[2]
			}
			if r != want {
				t.Errorf("route %+v, Python %+v", r, want)
			}
		})
	}
}
