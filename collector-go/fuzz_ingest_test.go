package main

import (
	"strings"
	"testing"
	"time"
)

// FuzzIngest drives one received line through everything a pool's bytes reach before storage (#105): JSON decode
// with the pool limits, mining.notify extraction, document (BIP34 height), the Postgres row, the RabbitMQ JSON, and
// the quarantine for whatever is rejected on the way. Any panic or fatal error here is a pool-triggerable crash.
//
//	go test -run '^$' -fuzz FuzzIngest -fuzztime 5m .
func FuzzIngest(f *testing.F) {
	notify := `{"id": null, "method": "mining.notify", "params": ["job1", "` + strings.Repeat("11", 32) + `", ` +
		`"01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff2003a0bb0e", ` +
		`"ffffffff0100f2052a01000000", ["` + strings.Repeat("22", 32) + `"], "20000000", "17034219", "6745a1b2", true]}`
	for _, s := range []string{notify, `{"method":"mining.notify","params":[]}`, `[[[[`, `{"a":`, `"\ud800"`, `1e999`} {
		f.Add([]byte(s))
	}
	en1, en2 := pyString("abcd1234"), pyIntOf(8)
	f.Fuzz(func(t *testing.T, b []byte) {
		q := quarantine{b: defaultQuarantineBudget}
		now := time.Unix(1_700_000_000, 0)
		msg, err := pyLoadsWith(b, poolLimits)
		if err != nil {
			_, _ = q.admit(Rejection{TsNs: now.UnixNano(), Stage: "json", Reason: err.Error(), Raw: b}, now)
			return
		}
		params, ok := notifyParams(msg)
		if !ok {
			_, _ = q.admit(Rejection{TsNs: now.UnixNano(), Stage: "notify", Raw: pyDumps(msg)}, now)
			return
		}
		d := newDocument(params, "fuzz", en1, en2, 1_700_000_000_000_000_000, nil)
		_ = d.JSON()
		if row, err := toRow(d, 1); err == nil {
			_ = row.values()
		} else {
			raw := pyDumps(pyValue{kind: pyList, items: d.Params[:]})
			rows, _ := q.admit(Rejection{TsNs: d.TsNs, Stage: "row", Reason: err.Error(), Raw: raw}, now)
			for _, r := range rows {
				_ = r.values(1)
			}
		}
		_ = route(d.Height, d.ChainFamily, 900000, true)
	})
}
