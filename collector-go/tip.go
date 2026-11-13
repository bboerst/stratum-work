package main

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"
)

// Bitcoin tip from the local node, for routing (pgsink route) and chain classification. Same semantics as Python's
// tip_state: usable only while fresher than staleAfter. SPIKE: polls getblockcount every pollEvery instead of the
// Python ZMQ trigger (rawblock/hashblock -> getblockcount); the full port adds ZMQ.

type TipState struct {
	mu         sync.Mutex
	height     int64
	updated    time.Time
	staleAfter time.Duration
}

func (t *TipState) Current() (int64, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.updated.IsZero() || time.Since(t.updated) > t.staleAfter {
		return 0, false
	}
	return t.height, true
}

func (t *TipState) set(h int64) {
	t.mu.Lock()
	t.height, t.updated = h, time.Now()
	t.mu.Unlock()
}

type RPC struct {
	URL, User, Password string
	Client              *http.Client
}

func newRPC(scheme, host, port, user, password, caFile string, timeout time.Duration) (*RPC, error) {
	tr := &http.Transport{}
	if scheme == "https" && caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("no certificates in %s", caFile)
		}
		tr.TLSClientConfig = &tls.Config{RootCAs: pool}
	}
	return &RPC{URL: fmt.Sprintf("%s://%s:%s/", scheme, host, port), User: user, Password: password,
		Client: &http.Client{Timeout: timeout, Transport: tr}}, nil
}

func (r *RPC) BlockCount() (int64, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "1.0", "id": "tip", "method": "getblockcount", "params": []any{}})
	req, _ := http.NewRequest("POST", r.URL, bytes.NewReader(body))
	req.SetBasicAuth(r.User, r.Password)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.Client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var out struct {
		Result *int64          `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return 0, fmt.Errorf("rpc status %d: %w", resp.StatusCode, err)
	}
	if out.Result == nil {
		return 0, fmt.Errorf("rpc error: %s", out.Error)
	}
	return *out.Result, nil
}

func (t *TipState) Follow(r *RPC, pollEvery time.Duration, log *slog.Logger) {
	for {
		if h, err := r.BlockCount(); err != nil {
			log.Warn("BTC tip update failed", "err", err)
		} else {
			t.set(h)
		}
		time.Sleep(pollEvery)
	}
}

// classifyChain mirrors ChainClassifier.classify, minus the BCH lookup (SPIKE): far from our tip = "unknown".
func classifyChain(tip *TipState, height int64, divergence int64) string {
	if height <= 0 {
		return ""
	}
	h, ok := tip.Current()
	if !ok {
		return ""
	}
	d := height - h
	if d < 0 {
		d = -d
	}
	if d <= divergence {
		return ""
	}
	return "unknown" // full port: "bch" when the BCH confirmation API knows prev_hash
}
