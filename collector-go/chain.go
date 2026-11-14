package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Port of collector/chain_detection.py plus the tip state from main.py.
//
// Classification is split so that nothing on the Stratum read path waits on the network:
//   - Prepare (read path, CPU only): the same decisions as ChainClassifier.classify up to the BCH lookup, against the
//     tip at that moment. Most templates end here (no tip, or within the divergence threshold: Bitcoin).
//   - the BCH confirmation API call, which Python made inline with a 3 s timeout, runs in the Classifier goroutine.
//     The receipt timestamp was captured before, so the lookup can no longer delay or distort it.

// TipState is the collector's Bitcoin tip (from the local node), usable while fresher than staleAfter.
type TipState struct {
	mu         sync.Mutex
	height     int64
	updated    time.Time // zero = never
	staleAfter time.Duration
	now        func() time.Time
}

func NewTipState(staleAfter time.Duration) *TipState {
	return &TipState{staleAfter: staleAfter, now: time.Now}
}

// Current returns the tip if known and fresh (Python current_btc_tip / TipState.is_usable: age <= stale_after).
func (t *TipState) Current() (int64, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.updated.IsZero() || t.now().Sub(t.updated) > t.staleAfter {
		return 0, false
	}
	return t.height, true
}

func (t *TipState) Set(h int64) {
	t.mu.Lock()
	t.height, t.updated = h, t.now()
	t.mu.Unlock()
}

// reversePrevHash converts stratum's prev_hash to the RPC/explorer byte order (bytes.fromhex(x)[::-1].hex()).
func reversePrevHash(prev pyValue) (string, error) {
	b, err := pyFromHex(prev)
	if err != nil {
		return "", err
	}
	slices.Reverse(b)
	return hexLower(b), nil
}

func hexLower(b []byte) string {
	var sb strings.Builder
	for _, c := range b {
		sb.WriteByte(lowerHex[c>>4])
		sb.WriteByte(lowerHex[c&0xf])
	}
	return sb.String()
}

// BCHCache is BCHConfirmationCache: one entry, the last prev_hash confirmed as BCH.
type BCHCache struct {
	mu    sync.Mutex
	prev  string
	isBCH bool
	set   bool
}

// Lookup returns (is_bch, found). Python returns None unless prev_hash equals the cached one.
func (c *BCHCache) Lookup(prev string) (bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.set || prev != c.prev {
		return false, false
	}
	return c.isBCH, true
}

func (c *BCHCache) Store(prev string, isBCH bool) {
	c.mu.Lock()
	c.prev, c.isBCH, c.set = prev, isBCH, true
	c.mu.Unlock()
}

// BCHConfirmer asks a BCH block API whether prev_hash is a BCH block (BCHConfirmer.confirm_bch).
type BCHConfirmer struct {
	BaseURL string
	Client  *http.Client
	Cache   *BCHCache
}

func NewBCHConfirmer(baseURL string, timeout time.Duration) *BCHConfirmer {
	tr := http.DefaultTransport.(*http.Transport).Clone() // honors HTTPS_PROXY etc., like requests
	return &BCHConfirmer{BaseURL: strings.TrimRight(baseURL, "/"), Client: &http.Client{Timeout: timeout, Transport: tr},
		Cache: &BCHCache{}}
}

// ConfirmBCH: cached answer, else GET <base>/<reversed prev_hash>; any failure means false. Only true is cached.
func (b *BCHConfirmer) ConfirmBCH(ctx context.Context, prev pyValue) bool {
	if prev.kind == pyStr {
		if v, ok := b.Cache.Lookup(prev.s); ok {
			return v
		}
	}
	rev, err := reversePrevHash(prev)
	if err != nil {
		return false // Python raises here; classify_notification_chain turns it into "no classification"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.BaseURL+"/"+rev, nil)
	if err != nil {
		return false
	}
	resp, err := b.Client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil || resp.StatusCode >= 400 { // requests: response.ok
		return false
	}
	payload, err := pyLoads(body)
	if err != nil || payload.kind != pyDict {
		return false
	}
	data, _ := payload.get("data")
	isBCH := data.truthy()
	if isBCH {
		b.Cache.Store(prev.s, true)
	}
	return isBCH
}

// Classifier runs ChainClassifier.classify for each document; BCH lookups happen in its own goroutine.
type Classifier struct {
	Tip        *TipState
	Divergence int64
	Confirmer  *BCHConfirmer
	Emit       func(*Document) // hands a finished document to the sinks (non-blocking)
	MaxQueue   int
	log        *slog.Logger

	mu    sync.Mutex
	cond  *sync.Cond
	queue []*Document
	stop  bool

	Lookups        atomic.Int64
	SkippedFullQ   atomic.Int64 // queue full: resolved as "unknown" without a lookup (Python's API-failure outcome)
	Unclassifiable atomic.Int64
	wg             sync.WaitGroup
}

func NewClassifier(tip *TipState, divergence int64, confirmer *BCHConfirmer, emit func(*Document), log *slog.Logger) *Classifier {
	c := &Classifier{Tip: tip, Divergence: divergence, Confirmer: confirmer, Emit: emit, MaxQueue: 1000, log: log}
	c.cond = sync.NewCond(&c.mu)
	return c
}

// Prepare classifies d where that needs no network I/O and reports whether d still needs the BCH lookup. Same
// decisions as classify_notification_chain + ChainClassifier.classify.
func (c *Classifier) Prepare(d *Document) (needsLookup bool) {
	prev := d.Params[pPrevHash]
	if d.Height <= 0 || !prev.truthy() {
		return false
	}
	tip, ok := c.Tip.Current()
	if !ok {
		return false
	}
	diff := d.Height - tip
	if diff < 0 {
		diff = -diff
	}
	if diff <= c.Divergence {
		return false
	}
	if prev.kind == pyStr {
		if v, ok := c.Confirmer.Cache.Lookup(prev.s); ok && v {
			d.ChainFamily = "bch"
			return false
		}
	}
	if _, err := reversePrevHash(prev); err != nil {
		c.Unclassifiable.Add(1) // Python: exception in confirm_bch -> classification skipped (None)
		return false
	}
	return true
}

// Submit routes a document: straight to Emit, or (BCH lookup needed) via the lookup queue. Never blocks on I/O.
func (c *Classifier) Submit(d *Document) {
	if !c.Prepare(d) {
		c.Emit(d)
		return
	}
	d.needsBCH = true
	var overflow *Document
	c.mu.Lock()
	if len(c.queue) >= c.MaxQueue {
		overflow = c.queue[0]
		c.queue = c.queue[1:]
	}
	c.queue = append(c.queue, d)
	c.mu.Unlock()
	c.cond.Signal()
	if overflow != nil {
		c.SkippedFullQ.Add(1)
		overflow.ChainFamily, overflow.needsBCH = "unknown", false
		c.Emit(overflow)
	}
}

func (c *Classifier) Queued() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.queue)
}

func (c *Classifier) Start() {
	c.wg.Add(1)
	go c.run()
}

func (c *Classifier) run() {
	defer c.wg.Done()
	for {
		c.mu.Lock()
		for len(c.queue) == 0 && !c.stop {
			c.cond.Wait()
		}
		if len(c.queue) == 0 {
			c.mu.Unlock()
			return
		}
		d := c.queue[0]
		c.queue = c.queue[1:]
		stopping := c.stop
		c.mu.Unlock()
		if stopping {
			d.ChainFamily = "unknown" // shutting down: don't wait on the API
		} else {
			c.Lookups.Add(1)
			if c.Confirmer.ConfirmBCH(context.Background(), d.Params[pPrevHash]) {
				d.ChainFamily = "bch"
			} else {
				d.ChainFamily = "unknown"
			}
		}
		d.needsBCH = false
		c.Emit(d)
	}
}

// Close resolves what is queued without further lookups and stops the goroutine.
func (c *Classifier) Close() {
	c.mu.Lock()
	c.stop = true
	c.mu.Unlock()
	c.cond.Broadcast()
	c.wg.Wait()
}
