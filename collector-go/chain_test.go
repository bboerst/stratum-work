package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Ported from collector/tests/test_chain_detection.py (classifier, confirmer, cache), plus the off-read-path split.

const (
	prevBCH   = "40d9f2088de1ca410fcddd20e0f713e225e4176800fc282d0000000000000000"
	prevOther = "58dcd5b64e522d28de60983366c6788b1a74584a69845173d6faa16b2718c906"
)

func TestReversePrevHash(t *testing.T) {
	got, err := reversePrevHash(pyString(prevBCH))
	if err != nil || got != "00000000000000002d28fc006817e425e213f7e020ddcd0f41cae18d08f2d940" {
		t.Error(got, err)
	}
}

func tipAt(height int64, age time.Duration, stale time.Duration) *TipState {
	ts := NewTipState(stale)
	now := time.Now()
	ts.now = func() time.Time { return now.Add(-age) }
	ts.Set(height)
	ts.now = func() time.Time { return now }
	return ts
}

// fakeAPI serves the BCH block API; answers maps reversed prev_hash -> body.
func fakeAPI(t *testing.T, status int, body string) (*BCHConfirmer, *atomic.Int64) {
	var calls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return NewBCHConfirmer(srv.URL+"/", 1500*time.Millisecond), &calls
}

func classify(c *Classifier, height int64, prev string) string {
	var got *Document
	c.Emit = func(d *Document) { got = d }
	d := &Document{Height: height}
	d.Params[pPrevHash] = pyString(prev)
	if c.Prepare(d) {
		if c.Confirmer.ConfirmBCH(context.Background(), d.Params[pPrevHash]) {
			return "bch"
		}
		return "unknown"
	}
	_ = got
	return d.ChainFamily
}

func TestClassifierSkipsDetectionWhenTipStateIsUnavailable(t *testing.T) {
	conf, calls := fakeAPI(t, 200, `{"data": {}}`)
	c := NewClassifier(NewTipState(60*time.Second), 5, conf, nil, nil)
	if got := classify(c, 945964, strings.Repeat("00", 32)); got != "" || calls.Load() != 0 {
		t.Error(got, calls.Load())
	}
}

func TestClassifierSkipsDetectionWhenTipIsStale(t *testing.T) {
	conf, calls := fakeAPI(t, 200, `{"data": {"x": 1}}`)
	c := NewClassifier(tipAt(945964, 61*time.Second, 60*time.Second), 5, conf, nil, nil)
	if got := classify(c, 945900, prevBCH); got != "" || calls.Load() != 0 {
		t.Error(got)
	}
}

func TestClassifierSkipsDetectionInsideHeightWindow(t *testing.T) {
	conf, calls := fakeAPI(t, 200, `{"data": {"x": 1}}`)
	c := NewClassifier(tipAt(945964, 20*time.Second, 60*time.Second), 5, conf, nil, nil)
	if got := classify(c, 945960, strings.Repeat("00", 32)); got != "" || calls.Load() != 0 {
		t.Error(got)
	}
}

func TestClassifierMarksConfirmedBCHWhenHeightDivergesAndAPIConfirms(t *testing.T) {
	var path atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path.Store(r.URL.Path)
		_, _ = w.Write([]byte(`{"data": {"chain": "bch"}}`))
	}))
	defer srv.Close()
	c := NewClassifier(tipAt(945964, 20*time.Second, 60*time.Second), 5, NewBCHConfirmer(srv.URL, time.Second), nil, nil)
	if got := classify(c, 945900, prevBCH); got != "bch" {
		t.Error(got)
	}
	if p := path.Load(); p != "/00000000000000002d28fc006817e425e213f7e020ddcd0f41cae18d08f2d940" {
		t.Error(p)
	}
}

func TestClassifierMarksDivergentNonBCHAsUnknown(t *testing.T) {
	conf, calls := fakeAPI(t, 404, `{"data": null}`)
	c := NewClassifier(tipAt(945964, 20*time.Second, 60*time.Second), 5, conf, nil, nil)
	if got := classify(c, 6560463, prevOther); got != "unknown" || calls.Load() != 1 {
		t.Error(got, calls.Load())
	}
}

func TestOneEntryCacheReusesLastConfirmedPrevHash(t *testing.T) {
	conf, calls := fakeAPI(t, 200, `{"data": {"chain": "bch"}}`)
	for i := 0; i < 2; i++ {
		if !conf.ConfirmBCH(context.Background(), pyString(prevBCH)) {
			t.Fatal("expected bch")
		}
	}
	if calls.Load() != 1 {
		t.Error("calls", calls.Load())
	}
	if v, ok := conf.Cache.Lookup(prevBCH); !v || !ok {
		t.Error("cache")
	}
	if _, ok := conf.Cache.Lookup("def"); ok {
		t.Error("cache hit for another prev_hash")
	}
}

func TestConfirmBCHReturnsFalseWhenRequestFails(t *testing.T) {
	conf := NewBCHConfirmer("http://127.0.0.1:1", 500*time.Millisecond)
	if conf.ConfirmBCH(context.Background(), pyString(prevBCH)) {
		t.Error("expected false")
	}
}

func TestConfirmBCHReturnsFalseWhenResponseIsNotJSON(t *testing.T) {
	conf, _ := fakeAPI(t, 200, `not json`)
	if conf.ConfirmBCH(context.Background(), pyString(prevBCH)) {
		t.Error("expected false")
	}
}

func TestConfirmBCHReturnsFalseWhenDataPayloadIsNull(t *testing.T) {
	conf, _ := fakeAPI(t, 200, `{"data": null}`)
	if conf.ConfirmBCH(context.Background(), pyString(prevBCH)) {
		t.Error("expected false")
	}
	if _, ok := conf.Cache.Lookup(prevBCH); ok {
		t.Error("false must not be cached")
	}
}

func TestConfirmBCHTimesOut(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
	}))
	defer srv.Close()
	conf := NewBCHConfirmer(srv.URL, 200*time.Millisecond)
	start := time.Now()
	if conf.ConfirmBCH(context.Background(), pyString(prevBCH)) || time.Since(start) > time.Second {
		t.Error("expected a fast false")
	}
}

func TestPrepareSkipsUnparsedHeightAndEmptyPrevHash(t *testing.T) {
	conf, calls := fakeAPI(t, 200, `{"data": 1}`)
	c := NewClassifier(tipAt(945964, 0, 60*time.Second), 5, conf, nil, nil)
	if classify(c, 0, prevBCH) != "" || classify(c, 6976415, "") != "" || calls.Load() != 0 {
		t.Error("expected no classification")
	}
	if classify(c, 6976415, "zz") != "" || c.Unclassifiable.Load() != 1 { // Python: exception -> None
		t.Error("invalid hex prev_hash")
	}
}

// The BCH lookup never runs on the submitting (read) goroutine: Submit returns at once while the API hangs.
func TestSubmitNeverWaitsForTheBCHAPI(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		_, _ = w.Write([]byte(`{"data": {"x": 1}}`))
	}))
	defer srv.Close()
	defer close(release)
	emitted := make(chan *Document, 10)
	c := NewClassifier(tipAt(945964, 0, 60*time.Second), 5, NewBCHConfirmer(srv.URL, 5*time.Second),
		func(d *Document) { emitted <- d }, nil)
	c.Start()
	far := &Document{Height: 945900}
	far.Params[pPrevHash] = pyString(prevBCH)
	near := &Document{Height: 945965}
	near.Params[pPrevHash] = pyString(prevOther)
	start := time.Now()
	c.Submit(far)
	c.Submit(near)
	if time.Since(start) > 50*time.Millisecond {
		t.Fatal("Submit blocked")
	}
	if d := <-emitted; d != near || d.ChainFamily != "" {
		t.Fatal("the Bitcoin template should pass straight through")
	}
	release <- struct{}{}
	if d := <-emitted; d != far || d.ChainFamily != "bch" {
		t.Fatalf("got %+v", d)
	}
	c.Close()
}

func TestLookupQueueOverflowClassifiesOldestUnknown(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-block }))
	defer srv.Close()
	var emitted []*Document
	var mu = make(chan struct{}, 1)
	mu <- struct{}{}
	c := NewClassifier(tipAt(945964, 0, 60*time.Second), 5, NewBCHConfirmer(srv.URL, 5*time.Second),
		func(d *Document) { <-mu; emitted = append(emitted, d); mu <- struct{}{} }, nil)
	c.MaxQueue = 2
	for i := 0; i < 5; i++ {
		d := &Document{Height: 6976415}
		d.Params[pPrevHash] = pyString(prevOther)
		c.Submit(d)
	}
	<-mu
	if len(emitted) != 3 || c.SkippedFullQ.Load() != 3 || emitted[0].ChainFamily != "unknown" {
		t.Errorf("emitted %d skipped %d", len(emitted), c.SkippedFullQ.Load())
	}
	mu <- struct{}{}
	close(block)
}
