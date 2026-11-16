package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync/atomic"
	"time"
)

// Bitcoin Core JSON-RPC client. Batches (a JSON array of calls in one request) keep per-transaction lookups cheap.
// Every method used here must be in the recorder login's -rpcwhitelist (see the README).

type RPC struct {
	url, user, password string
	client              *http.Client
	timeout             time.Duration // per call; the mempool snapshot gets snapshotTimeout
	snapshotTimeout     time.Duration
	Errors              atomic.Int64 // failed calls (transport or RPC error), for /metrics
	id                  atomic.Int64
}

// NewRPC: https verifies against caFile when given, else the system trust store; verification is never disabled.
func NewRPC(scheme, host, port, user, password, caFile string, timeout time.Duration) (*RPC, error) {
	if scheme != "http" && scheme != "https" {
		return nil, fmt.Errorf("unsupported RPC scheme %q", scheme)
	}
	tr := &http.Transport{Proxy: http.ProxyFromEnvironment, MaxIdleConnsPerHost: 4,
		// bitcoind closes idle connections after -rpcservertimeout (30 s); drop ours first.
		IdleConnTimeout: 15 * time.Second,
		DialContext:     (&net.Dialer{Timeout: 10 * time.Second}).DialContext}
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
	return &RPC{url: fmt.Sprintf("%s://%s/", scheme, net.JoinHostPort(host, port)), user: user, password: password,
		client: &http.Client{Transport: tr}, timeout: timeout, snapshotTimeout: max(5*time.Minute, 20*timeout)}, nil
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message) }

// RPC error codes (src/rpc/protocol.h).
const (
	rpcInvalidAddressOrKey = -5 // e.g. "Transaction not in mempool"
)

func isRPCCode(err error, code int) bool {
	var e *rpcError
	return errors.As(err, &e) && e.Code == code
}

type rpcReq struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResp struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

func (r *RPC) post(ctx context.Context, body any) (*http.Response, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(r.user, r.password)
	req.Header.Set("Content-Type", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		resp.Body.Close()
		return nil, fmt.Errorf("rpc: HTTP %d (credentials, or a method missing from -rpcwhitelist)", resp.StatusCode)
	}
	return resp, nil
}

// Call makes one call and decodes its result into out (nil: discard).
func (r *RPC) Call(ctx context.Context, method string, out any, params ...any) error {
	err := r.call(ctx, method, out, params...)
	if err != nil {
		r.Errors.Add(1)
	}
	return err
}

func (r *RPC) call(ctx context.Context, method string, out any, params ...any) error {
	if params == nil {
		params = []any{}
	}
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	resp, err := r.post(ctx, rpcReq{"1.0", r.id.Add(1), method, params})
	if err != nil {
		return fmt.Errorf("%s: %w", method, err)
	}
	defer resp.Body.Close()
	var res rpcResp
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return fmt.Errorf("%s: HTTP %d: %w", method, resp.StatusCode, err)
	}
	if res.Error != nil {
		return fmt.Errorf("%s: %w", method, res.Error)
	}
	if out != nil {
		return json.Unmarshal(res.Result, out)
	}
	return nil
}

// Batch makes len(params) calls of one method in one request. errs[i] is the error of call i (e.g. a transaction
// no longer in the mempool); err is a failure of the whole request.
func (r *RPC) Batch(ctx context.Context, method string, params [][]any) (results []json.RawMessage, errs []error, err error) {
	if len(params) == 0 {
		return nil, nil, nil
	}
	reqs := make([]rpcReq, len(params))
	base := r.id.Add(int64(len(params))) - int64(len(params))
	for i, p := range params {
		reqs[i] = rpcReq{"1.0", base + int64(i) + 1, method, p}
	}
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	resp, err := r.post(ctx, reqs)
	if err != nil {
		r.Errors.Add(1)
		return nil, nil, fmt.Errorf("%s batch: %w", method, err)
	}
	defer resp.Body.Close()
	var out []rpcResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		r.Errors.Add(1)
		return nil, nil, fmt.Errorf("%s batch: HTTP %d: %w", method, resp.StatusCode, err)
	}
	results, errs = make([]json.RawMessage, len(params)), make([]error, len(params))
	for i := range errs {
		errs[i] = errors.New("no response")
	}
	for _, o := range out {
		i := o.ID - base - 1
		if i < 0 || int(i) >= len(params) {
			continue
		}
		if o.Error != nil {
			errs[i] = o.Error
			continue
		}
		results[i], errs[i] = o.Result, nil
	}
	return results, errs, nil
}

// ── Typed calls ──────────────────────────────────────────────────────────────────────────────────────────────────

// MempoolEntry is the part of getmempoolentry / getrawmempool (verbose) the recorder keeps. Fees in BTC from the
// node are converted to satoshis.
type MempoolEntry struct {
	Txid            Hash
	Wtxid           Hash
	VSize, Weight   int
	Time            int64 // node's entry time (unix seconds)
	Fee, ModFee     int64 // satoshis
	AncestorCount   int
	AncestorSize    int // sigop-adjusted vsize
	AncestorFees    int64
	DescendantCount int
	DescendantSize  int
	DescendantFees  int64
}

type entryJSON struct {
	VSize           int    `json:"vsize"`
	Weight          int    `json:"weight"`
	Time            int64  `json:"time"`
	Wtxid           string `json:"wtxid"`
	DescendantCount int    `json:"descendantcount"`
	DescendantSize  int    `json:"descendantsize"`
	AncestorCount   int    `json:"ancestorcount"`
	AncestorSize    int    `json:"ancestorsize"`
	Fees            struct {
		Base       json.Number `json:"base"`
		Modified   json.Number `json:"modified"`
		Ancestor   json.Number `json:"ancestor"`
		Descendant json.Number `json:"descendant"`
	} `json:"fees"`
}

// btcToSats converts an RPC amount (a decimal with at most 8 places) exactly, without float rounding.
func btcToSats(n json.Number) (int64, error) {
	s := string(n)
	if s == "" {
		return 0, errors.New("empty amount")
	}
	neg := s[0] == '-'
	if neg {
		s = s[1:]
	}
	whole, frac := s, ""
	for i := range s {
		if s[i] == '.' {
			whole, frac = s[:i], s[i+1:]
			break
		}
	}
	if len(frac) > 8 {
		return 0, fmt.Errorf("amount %q has more than 8 decimals", n)
	}
	for len(frac) < 8 {
		frac += "0"
	}
	w, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, err
	}
	f, err := strconv.ParseInt(frac, 10, 64)
	if err != nil {
		return 0, err
	}
	v := w*100_000_000 + f
	if neg {
		v = -v
	}
	return v, nil
}

func (e *entryJSON) toEntry(txid Hash) (MempoolEntry, error) {
	m := MempoolEntry{Txid: txid, VSize: e.VSize, Weight: e.Weight, Time: e.Time, AncestorCount: e.AncestorCount,
		AncestorSize: e.AncestorSize, DescendantCount: e.DescendantCount, DescendantSize: e.DescendantSize}
	var err error
	if m.Wtxid, err = ParseDisplayHash(e.Wtxid); err != nil {
		return m, err
	}
	for _, f := range []struct {
		n   json.Number
		dst *int64
	}{{e.Fees.Base, &m.Fee}, {e.Fees.Modified, &m.ModFee}, {e.Fees.Ancestor, &m.AncestorFees},
		{e.Fees.Descendant, &m.DescendantFees}} {
		if *f.dst, err = btcToSats(f.n); err != nil {
			return m, err
		}
	}
	return m, nil
}

func decodeEntry(txid Hash, raw json.RawMessage) (MempoolEntry, error) {
	var e entryJSON
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err := d.Decode(&e); err != nil {
		return MempoolEntry{}, err
	}
	return e.toEntry(txid)
}

// MempoolEntries is getmempoolentry for each txid, in one batch. A missing entry (the transaction already left the
// mempool) is absent from the result, not an error.
func (r *RPC) MempoolEntries(ctx context.Context, txids []Hash) (map[Hash]MempoolEntry, error) {
	params := make([][]any, len(txids))
	for i, t := range txids {
		params[i] = []any{t.Display()}
	}
	res, errs, err := r.Batch(ctx, "getmempoolentry", params)
	if err != nil {
		return nil, err
	}
	out := make(map[Hash]MempoolEntry, len(txids))
	for i, t := range txids {
		if errs[i] != nil {
			if !isRPCCode(errs[i], rpcInvalidAddressOrKey) {
				r.Errors.Add(1)
			}
			continue
		}
		if e, err := decodeEntry(t, res[i]); err == nil {
			out[t] = e
		}
	}
	return out, nil
}

// RawTransactions is getrawtransaction (hex) for each txid, in one batch; works for mempool transactions without
// -txindex. Missing ones are absent.
func (r *RPC) RawTransactions(ctx context.Context, txids []Hash, keepRaw bool) (map[Hash]*Tx, error) {
	params := make([][]any, len(txids))
	for i, t := range txids {
		params[i] = []any{t.Display()}
	}
	res, errs, err := r.Batch(ctx, "getrawtransaction", params)
	if err != nil {
		return nil, err
	}
	out := make(map[Hash]*Tx, len(txids))
	for i := range txids {
		if errs[i] != nil {
			continue
		}
		var h string
		if json.Unmarshal(res[i], &h) != nil {
			continue
		}
		b, err := hex.DecodeString(h)
		if err != nil {
			continue
		}
		if tx, err := ParseTx(b, keepRaw); err == nil {
			out[tx.Txid] = tx
		}
	}
	return out, nil
}

// MempoolSnapshot is the race-free snapshot: `getrawmempool false true` gives the txids with the mempool sequence
// they correspond to (Core refuses verbose output with the sequence), then batched getmempoolentry calls give each
// entry (entry time, fees, sizes). Entries go to fn as they arrive, so a 150k-transaction mempool never sits in
// memory as JSON. A transaction that left between the two calls gets an entry with only Txid set (Time 0): its R
// event, above the sequence, follows on the feed.
func (r *RPC) MempoolSnapshot(ctx context.Context, fn func(MempoolEntry)) (uint64, error) {
	txids, seq, err := r.mempoolTxids(ctx)
	if err != nil {
		r.Errors.Add(1)
		return 0, err
	}
	const batch = 500
	for i := 0; i < len(txids); i += batch {
		part := txids[i:min(i+batch, len(txids))]
		got, err := r.MempoolEntries(ctx, part)
		if err != nil {
			return 0, err
		}
		for _, t := range part {
			if e, ok := got[t]; ok {
				fn(e)
			} else {
				fn(MempoolEntry{Txid: t})
			}
		}
	}
	return seq, nil
}

func (r *RPC) mempoolTxids(ctx context.Context) ([]Hash, uint64, error) {
	ctx, cancel := context.WithTimeout(ctx, r.snapshotTimeout)
	defer cancel()
	resp, err := r.post(ctx, rpcReq{"1.0", r.id.Add(1), "getrawmempool", []any{false, true}})
	if err != nil {
		return nil, 0, fmt.Errorf("getrawmempool: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		Result *struct {
			Txids []string `json:"txids"`
			Seq   *uint64  `json:"mempool_sequence"`
		} `json:"result"`
		Error *rpcError `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, 0, fmt.Errorf("getrawmempool: HTTP %d: %w", resp.StatusCode, err)
	}
	if out.Error != nil {
		return nil, 0, fmt.Errorf("getrawmempool: %w", out.Error)
	}
	if out.Result == nil || out.Result.Seq == nil {
		return nil, 0, errors.New("getrawmempool: response without txids or mempool_sequence")
	}
	txids := make([]Hash, len(out.Result.Txids))
	for i, s := range out.Result.Txids {
		if txids[i], err = ParseDisplayHash(s); err != nil {
			return nil, 0, err
		}
	}
	return txids, *out.Result.Seq, nil
}

type MempoolInfo struct {
	Size          int         `json:"size"`
	Bytes         int64       `json:"bytes"`
	Usage         int64       `json:"usage"`
	MaxMempool    int64       `json:"maxmempool"`
	MempoolMinFee json.Number `json:"mempoolminfee"`
	MinRelayTxFee json.Number `json:"minrelaytxfee"`
}

// Full reports whether the node has been trimming its mempool to size recently: trimming raises the rolling
// minimum fee above the relay minimum, and it decays back over hours.
func (m *MempoolInfo) Full() bool {
	a, err1 := btcToSats(m.MempoolMinFee)
	b, err2 := btcToSats(m.MinRelayTxFee)
	return err1 == nil && err2 == nil && a > b
}

func (r *RPC) MempoolInfo(ctx context.Context) (*MempoolInfo, error) {
	var m MempoolInfo
	if err := r.Call(ctx, "getmempoolinfo", &m); err != nil {
		return nil, err
	}
	return &m, nil
}

type BlockHeader struct {
	Hash          string `json:"hash"`
	Height        int    `json:"height"`
	Confirmations int    `json:"confirmations"` // -1: not on the active chain
}

func (r *RPC) BlockHeader(ctx context.Context, hash Hash) (*BlockHeader, error) {
	var h BlockHeader
	if err := r.Call(ctx, "getblockheader", &h, hash.Display(), true); err != nil {
		return nil, err
	}
	return &h, nil
}

// Block fetches and parses a block (getblock <hash> 0: raw, so its inputs are available for conflict detection).
func (r *RPC) Block(ctx context.Context, hash Hash) (*Block, error) {
	var h string
	if err := r.Call(ctx, "getblock", &h, hash.Display(), 0); err != nil {
		return nil, err
	}
	b, err := hex.DecodeString(h)
	if err != nil {
		return nil, err
	}
	blk, err := ParseBlock(b)
	if err != nil {
		return nil, err
	}
	if blk.Hash != hash {
		return nil, fmt.Errorf("getblock %s returned block %s", hash, blk.Hash)
	}
	return blk, nil
}

func (r *RPC) BlockHash(ctx context.Context, height int) (Hash, error) {
	var s string
	if err := r.Call(ctx, "getblockhash", &s, height); err != nil {
		return Hash{}, err
	}
	return ParseDisplayHash(s)
}

func (r *RPC) BlockCount(ctx context.Context) (int, error) {
	var n int
	err := r.Call(ctx, "getblockcount", &n)
	return n, err
}
