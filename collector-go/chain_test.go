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
	blockBCH  = "000000000000000000fc282d25e41768e0f713e20fcddd208de1ca4140d9f208" // Bitcoin Cash 945963
	prevOther = "58dcd5b64e522d28de60983366c6788b1a74584a69845173d6faa16b2718c906"
)

// prevHashVectors: (block hash as explorers show it, the prev_hash a Stratum mining.notify carries for the next
// block). The same public chain data as collector/tests/test_chain_detection.py PREV_HASH_VECTORS.
var prevHashVectors = [][2]string{
	{"00000000000000000001a8d326d8c59ccb89fde87a9fec130ac332c99c4ac17e", // Bitcoin 976051
		"9c4ac17e0ac332c97a9fec13cb89fde826d8c59c0001a8d30000000000000000"},
	{"000000000002d01c1fccc21636b607dfd930d31d01c3a62104612a1719011250", // Bitcoin 99999 (pre-segwit)
		"1901125004612a1701c3a621d930d31d36b607df1fccc2160002d01c00000000"},
	{"000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f", // Bitcoin genesis
		"0a8ce26f72b3f1b646a2a6c14ff763ae65831e939c085ae10019d66800000000"},
	{blockBCH, prevBCH}, // Bitcoin Cash 945963
	{"000000000000000000cd65f3dca7fb2bb3a909339a66bb3d7535c1dec40ddb41", // Bitcoin Cash 945962
		"c40ddb417535c1de9a66bb3db3a90933dca7fb2b00cd65f30000000000000000"},
	{"1c1d1e1f18191a1b14151617101112130c0d0e0f08090a0b0405060700010203", // synthetic: all words distinct, none zero
		"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"},
}

// Word order reversed, bytes within a word kept (#192); not the byte reversal.
func TestReversePrevHash(t *testing.T) {
	for _, v := range prevHashVectors {
		for _, in := range []string{v[1], strings.ToUpper(v[1])} {
			if got, err := reversePrevHash(pyString(in)); err != nil || got != v[0] {
				t.Errorf("reversePrevHash(%s) = %s, %v; want %s", in, got, err, v[0])
			}
		}
	}
	for _, bad := range []string{"", "ab", strings.Repeat("00", 31), strings.Repeat("00", 33), strings.Repeat("zz", 32),
		strings.Repeat("0", 63)} {
		if got, err := reversePrevHash(pyString(bad)); err == nil {
			t.Errorf("reversePrevHash(%q) = %s, want an error", bad, got)
		}
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
	if p := path.Load(); p != "/"+blockBCH {
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
	if classify(c, 6976415, "abcd") != "" || c.Unclassifiable.Load() != 2 || calls.Load() != 0 { // not 32 bytes
		t.Error("short prev_hash")
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
