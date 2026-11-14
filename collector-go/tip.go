package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/go-zeromq/zmq4"
)

// The Bitcoin tip from the local node, like main.py: one getblockcount at startup, then a ZMQ subscription to
// rawblock/hashblock where every block notification triggers getblockcount. The tip is used for chain
// classification and Postgres routing, and only while fresher than --btc-tip-stale-seconds.

type RPC struct {
	URL, User, Password string
	Client              *http.Client
}

// NewRPC builds the client. https verifies against caFile only when given (Python:
// ssl.create_default_context(cafile=...)), else against the system trust store. Verification is never disabled.
func NewRPC(scheme, host, port, user, password, caFile string, timeout time.Duration) (*RPC, error) {
	if scheme != "http" && scheme != "https" {
		return nil, fmt.Errorf("unsupported RPC scheme %q", scheme)
	}
	tr := &http.Transport{Proxy: http.ProxyFromEnvironment}
	if scheme == "https" && caFile != "" {
		pem, err := os.ReadFile(caFile)
		if err != nil {
			return nil, err
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("no certificates in %s", caFile)
		}
		tr.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	}
	return &RPC{URL: fmt.Sprintf("%s://%s/", scheme, net.JoinHostPort(host, port)), User: user, Password: password,
		Client: &http.Client{Timeout: timeout, Transport: tr}}, nil
}

func (r *RPC) BlockCount(ctx context.Context) (int64, error) {
	body, _ := json.Marshal(map[string]any{"jsonrpc": "1.0", "id": "tip", "method": "getblockcount", "params": []any{}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.URL, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
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
		return 0, fmt.Errorf("rpc error (status %d): %s", resp.StatusCode, out.Error)
	}
	return *out.Result, nil
}

// TipFollower keeps a TipState current.
type TipFollower struct {
	Tip      *TipState
	RPC      *RPC
	Endpoint string // ZMQ endpoint, e.g. tcp://node:28332
	Retry    time.Duration
	log      *slog.Logger
	Updates  func() // metrics hook, optional
}

// Init is initialize_tip_state: one RPC call; failure leaves classification disabled until a block arrives.
func (f *TipFollower) Init(ctx context.Context) {
	h, err := f.RPC.BlockCount(ctx)
	if err != nil {
		f.log.Warn("initial BTC tip setup failed; classification disabled until tip data is available", "err", err)
		return
	}
	f.Tip.Set(h)
	f.log.Info("initialized BTC tip state", "height", h)
}

// Run is listen_for_btc_tip_updates: subscribe to rawblock + hashblock; each message triggers getblockcount. On a
// connection error, wait Retry (5 s) and subscribe again. The ZMQ socket reconnects on its own when the node
// restarts, like libzmq.
func (f *TipFollower) Run(ctx context.Context) {
	for ctx.Err() == nil {
		err := f.follow(ctx)
		if ctx.Err() != nil {
			return
		}
		f.log.Warn("BTC tip listener error", "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(f.Retry):
		}
	}
}

func (f *TipFollower) follow(ctx context.Context) error {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sub := zmq4.NewSub(sctx, zmq4.WithAutomaticReconnect(true), zmq4.WithDialerRetry(f.Retry),
		zmq4.WithDialerMaxRetries(-1), zmq4.WithDialerTimeout(10*time.Second))
	defer sub.Close()
	if err := sub.SetOption(zmq4.OptionSubscribe, "rawblock"); err != nil {
		return err
	}
	if err := sub.SetOption(zmq4.OptionSubscribe, "hashblock"); err != nil {
		return err
	}
	if err := sub.Dial(f.Endpoint); err != nil {
		return err
	}
	f.log.Info("BTC tip listener connected", "endpoint", f.Endpoint)
	for {
		msg, err := sub.Recv()
		if err != nil {
			return err
		}
		if len(msg.Frames) < 2 {
			continue
		}
		rctx, rcancel := context.WithTimeout(ctx, f.RPC.Client.Timeout+time.Second)
		h, err := f.RPC.BlockCount(rctx)
		rcancel()
		if err != nil {
			f.log.Warn("BTC tip update failed", "err", err)
			continue
		}
		f.Tip.Set(h)
		if f.Updates != nil {
			f.Updates()
		}
		f.log.Debug("updated BTC tip state", "height", h)
	}
}
