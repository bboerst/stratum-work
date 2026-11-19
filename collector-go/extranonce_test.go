package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// extranonceCollector runs a direct-mode collector against a fake pool through the handshake (extranonce1
// "abcd1234", extranonce2_length 8) and returns the pool side and the extranonce events.
func extranonceCollector(t *testing.T, mod func(*StratumConfig)) (*fakeConn, chan *Document, chan IngestEvent) {
	t.Helper()
	pool := newFakePool(t)
	c, docs, _, _ := testCollector(t, poolURL(pool), mod)
	events := make(chan IngestEvent, 16)
	c.Event = func(e IngestEvent) {
		if e.Kind == "extranonce" {
			events <- e
		}
	}
	ctx, stop := context.WithCancel(context.Background())
	t.Cleanup(stop)
	go c.Run(ctx)
	f := pool.accept(t)
	f.handshake(t)
	return f, docs, events
}

func setExtranonceLine(params string) string {
	return `{"id": null, "method": "mining.set_extranonce", "params": ` + params + `}` + "\n"
}

func wantExtranonce(t *testing.T, d *Document, job, en1, en2 string) {
	t.Helper()
	if d.Params[0].s != job || string(pyDumps(d.Extranonce1)) != en1 || string(pyDumps(d.Extranonce2Len)) != en2 {
		t.Errorf("%s: extranonce1 %s extranonce2_length %s, want %s %s", d.Params[0].s, pyDumps(d.Extranonce1),
			pyDumps(d.Extranonce2Len), en1, en2)
	}
}

// noEvent: the events of a line are emitted before the next line is read, so after a later template has been
// handed off, an empty channel means none was recorded.
func noEvent(t *testing.T, events chan IngestEvent) {
	t.Helper()
	select {
	case e := <-events:
		t.Errorf("unexpected event %+v", e)
	default:
	}
}

func TestSetExtranonceAppliesToLaterTemplatesOnly(t *testing.T) {
	f, docs, events := extranonceCollector(t, nil)
	before := time.Now()
	f.send(t, notifyLine("j1")+setExtranonceLine(`["00ff00ff", 4]`)+notifyLine("j2")+notifyLine("j3"))
	wantExtranonce(t, nextDoc(t, docs), "j1", `"abcd1234"`, "8")
	wantExtranonce(t, nextDoc(t, docs), "j2", `"00ff00ff"`, "4")
	wantExtranonce(t, nextDoc(t, docs), "j3", `"00ff00ff"`, "4")

	e := nextEvent(t, events)
	if e.Start.Before(before) || !e.End.Equal(e.Start) || e.Templates != 0 || e.Detail["cause"] != "set_extranonce" ||
		e.Detail["applied"] != true {
		t.Fatalf("%+v", e)
	}
	row := e.values(3)
	if row[1] != "extranonce" || string(row[6].([]byte)) != `{"applied":true,"cause":"set_extranonce",`+
		`"new":{"extranonce1":"00ff00ff","extranonce2_length":4},"old":{"extranonce1":"abcd1234","extranonce2_length":8}}` {
		t.Errorf("row detail %s", row[6])
	}
	// The same values again change nothing and record nothing.
	f.send(t, setExtranonceLine(`["00ff00ff", 4]`)+notifyLine("j4"))
	wantExtranonce(t, nextDoc(t, docs), "j4", `"00ff00ff"`, "4")
	noEvent(t, events)
}

func TestInvalidSetExtranonceIsRecordedAndIgnored(t *testing.T) {
	f, docs, events := extranonceCollector(t, nil)
	for _, params := range []string{
		`["zz", 4]`,               // not hex
		`["abc", 4]`,              // odd length
		`[7, 4]`,                  // not a string
		`["abcd", 33]`,            // extranonce2 too large
		`["abcd", -1]`,            // negative
		`["abcd", "four"]`,        // not an integer
		`["abcd"]`,                // too few
		`["abcd", 4, 5]`,          // too many
		`{"extranonce1": "abcd"}`, // not a list
		`["` + strings.Repeat("ab", 33) + `", 4]`, // extranonce1 too long
		`["a\u0000b", 4]`,                         // hostile: NUL (refused by jsonb)
		`["abcd", "4\u0000"]`,                     // hostile: NUL in the size
	} {
		f.send(t, setExtranonceLine(params)+notifyLine("n"))
		wantExtranonce(t, nextDoc(t, docs), "n", `"abcd1234"`, "8")
		e := nextEvent(t, events)
		if e.Detail["cause"] != "set_extranonce" || e.Detail["applied"] != false || e.Detail["error"] == "" ||
			e.Detail["params"] == nil {
			t.Errorf("%s: %+v", params, e)
		}
		var detail any
		if err := json.Unmarshal(e.values(1)[6].([]byte), &detail); err != nil {
			t.Fatal(err)
		}
		if s := jsonStrings(detail); strings.ContainsRune(s, 0) {
			t.Errorf("%s: NUL in the event detail", params)
		}
	}
}

func jsonStrings(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case map[string]any:
		var b strings.Builder
		for k, x := range v {
			b.WriteString(k + jsonStrings(x))
		}
		return b.String()
	case []any:
		var b strings.Builder
		for _, x := range v {
			b.WriteString(jsonStrings(x))
		}
		return b.String()
	}
	return ""
}

func TestResubscribeWithOtherValuesIsRecordedNotApplied(t *testing.T) {
	f, docs, events := extranonceCollector(t, func(s *StratumConfig) { s.ProbeInterval = 200 * time.Millisecond })
	probe, raw := f.readReq(t)
	if !strings.Contains(raw, `"method": "mining.subscribe"`) {
		t.Fatalf("expected a probe, got %q", raw)
	}
	f.send(t, `{"id": `+reqID(probe)+`, "result": [[["mining.notify", "y"]], "beef0000", 4], "error": null}`+"\n")
	f.send(t, notifyLine("after-other"))
	wantExtranonce(t, nextDoc(t, docs), "after-other", `"abcd1234"`, "8")
	e := nextEvent(t, events)
	if e.Detail["cause"] != "resubscribe" || e.Detail["applied"] != false {
		t.Fatalf("%+v", e)
	}
	if string(e.values(1)[6].([]byte)) != `{"applied":false,"cause":"resubscribe",`+
		`"new":{"extranonce1":"beef0000","extranonce2_length":4},"old":{"extranonce1":"abcd1234","extranonce2_length":8}}` {
		t.Errorf("detail %s", e.values(1)[6])
	}

	// A response with the values in force records nothing.
	probe, _ = f.readReq(t)
	f.send(t, subResult(reqID(probe)))
	f.send(t, notifyLine("after-same"))
	wantExtranonce(t, nextDoc(t, docs), "after-same", `"abcd1234"`, "8")
	noEvent(t, events)
}

func TestKeepAliveResponseWithOtherValuesIsRecorded(t *testing.T) {
	f, docs, events := extranonceCollector(t, func(s *StratumConfig) {
		s.KeepAlive, s.KeepAliveEvery = true, 300*time.Millisecond
	})
	ka, _ := f.readReq(t)
	f.send(t, `{"id": `+reqID(ka)+`, "result": [[], "beef0000", 8], "error": null}`+"\n"+notifyLine("n"))
	wantExtranonce(t, nextDoc(t, docs), "n", `"abcd1234"`, "8")
	if e := nextEvent(t, events); e.Detail["cause"] != "resubscribe" || e.Detail["applied"] != false {
		t.Fatalf("%+v", e)
	}
}

func TestEventValueIsJSONBSafe(t *testing.T) {
	for _, tc := range []struct {
		v    pyValue
		want any
	}{
		{pyValue{kind: pyNull}, nil},
		{pyIntOf(-1), int64(-1)},
		{pyString("abcd"), "abcd"},
		{pyString("a\x00b"), `"a\u0000b"`},
		{pyValue{kind: pyInt, s: "123456789012345678901234567890"}, "123456789012345678901234567890"},
		{pyString(strings.Repeat("a", 129)), truncate(`"`+strings.Repeat("a", 129)+`"`, 200)},
	} {
		if got := eventValue(tc.v); got != tc.want {
			t.Errorf("eventValue(%s) = %#v, want %#v", pyDumps(tc.v), got, tc.want)
		}
	}
}
