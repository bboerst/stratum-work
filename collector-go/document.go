package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Document is the collector's record of one mining.notify: Python's create_notification_document. Pool-sent values
// are kept as decoded (pyValue), so both sinks see exactly what Python would: the RabbitMQ message is json.dumps of
// the same fields in the same order, and the Postgres row is converted with Python's semantics (toRow).
type Document struct {
	ID             string // uuid4
	TsNs           int64  // receipt time (kernel receive timestamp, or the clock after the read returned)
	PoolName       string
	Height         int64 // BIP34 height, 0 if it could not be parsed (Python sentinel)
	Params         [9]pyValue
	Extranonce1    pyValue // from mining.subscribe; JSON null before the first successful subscribe
	Extranonce2Len pyValue // from mining.subscribe; -1 before
	HasLatency     bool
	LatencyMs      float64
	LatencyMethod  string
	ChainFamily    string // "" (Bitcoin / not classified), "bch", "unknown"

	AppTsNs  int64 // clock after the read returned (for the app-vs-kernel measurement only; never stored)
	needsBCH bool  // chain classification waits for the BCH confirmation API (resolved off the read path)
}

const (
	pJobID = iota
	pPrevHash
	pCoinbase1
	pCoinbase2
	pMerkle
	pVersion
	pNbits
	pNtime
	pCleanJobs
)

// notifyParams validates what Python's _process_notification touches before it builds a document: params must be
// indexable up to [8] and params[1] sliceable (str or list). Python raises (and reconnects) otherwise; the Go
// collector skips the message instead.
func notifyParams(msg pyValue) ([9]pyValue, bool) {
	var p [9]pyValue
	params, ok := msg.get("params")
	if !ok || params.kind != pyList || len(params.items) < 9 {
		return p, false
	}
	if k := params.items[1].kind; k != pyStr && k != pyList {
		return p, false
	}
	copy(p[:], params.items[:9])
	return p, true
}

func uuid4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

// newDocument mirrors create_notification_document, minus the chain classification (see Classifier).
func newDocument(params [9]pyValue, poolName string, en1, en2 pyValue, tsNs int64, lat *latencyEstimate) *Document {
	d := &Document{ID: uuid4(), TsNs: tsNs, PoolName: poolName, Params: params, Extranonce1: en1, Extranonce2Len: en2}
	if params[pCoinbase1].kind == pyStr {
		if h, ok := parseBIP34Height(params[pCoinbase1].s); ok {
			d.Height = h
		}
	}
	if lat != nil {
		d.HasLatency, d.LatencyMs, d.LatencyMethod = true, lat.ms, lat.method
	}
	return d
}

// TimestampHex is hex(receipt_ts_ns)[2:].
func (d *Document) TimestampHex() string { return strconv.FormatInt(d.TsNs, 16) }

// JSON is json.dumps(document) exactly as the Python collector publishes it to RabbitMQ.
func (d *Document) JSON() []byte {
	var b bytes.Buffer
	field := func(first bool, k string) {
		if !first {
			b.WriteString(", ")
		}
		pyEncodeString(&b, k)
		b.WriteString(": ")
	}
	b.WriteByte('{')
	field(true, "_id")
	pyEncodeString(&b, d.ID)
	field(false, "timestamp")
	pyEncodeString(&b, d.TimestampHex())
	field(false, "pool_name")
	pyEncodeString(&b, d.PoolName)
	field(false, "height")
	b.WriteString(strconv.FormatInt(d.Height, 10))
	names := [9]string{"job_id", "prev_hash", "coinbase1", "coinbase2", "merkle_branches", "version", "nbits", "ntime",
		"clean_jobs"}
	for i, n := range names {
		field(false, n)
		pyEncode(&b, d.Params[i])
	}
	field(false, "extranonce1")
	pyEncode(&b, d.Extranonce1)
	field(false, "extranonce2_length")
	pyEncode(&b, d.Extranonce2Len)
	if d.HasLatency {
		field(false, "lat_ms")
		b.WriteString(pyFloatJSON(d.LatencyMs))
		field(false, "lat_m")
		pyEncodeString(&b, d.LatencyMethod)
	}
	if d.ChainFamily != "" {
		field(false, "chain_family")
		pyEncodeString(&b, d.ChainFamily)
	}
	b.WriteByte('}')
	return b.Bytes()
}

// ── Postgres row (pgsink.py to_row) ──────────────────────────────────────────────────────────────────────────────

var pgColumns = []string{"received_at", "source_id", "height", "job_id", "prev_hash", "coinbase1", "coinbase2",
	"merkle_branches", "version", "nbits", "ntime", "clean_jobs", "extranonce1", "extranonce2_length", "latency_ms",
	"latency_method"}

// Row is one `templates` row (column order = pgColumns).
type Row struct {
	ReceivedAt     time.Time
	SourceID       int16
	Height         int32
	JobID          string
	PrevHash       []byte
	Coinbase1      []byte
	Coinbase2      []byte
	MerkleBranches []byte
	Version        int64
	Nbits          int64
	Ntime          int64
	CleanJobs      bool
	Extranonce1    []byte
	Extranonce2Len int16
	LatencyMs      *float32 // real
	LatencyMethod  *string  // latency_method enum: tcp | app
}

func (r Row) values() []any {
	var lm, lmeth any
	if r.LatencyMs != nil {
		lm = *r.LatencyMs
	}
	if r.LatencyMethod != nil {
		lmeth = *r.LatencyMethod
	}
	return []any{r.ReceivedAt, r.SourceID, r.Height, r.JobID, r.PrevHash, r.Coinbase1, r.Coinbase2, r.MerkleBranches,
		r.Version, r.Nbits, r.Ntime, r.CleanJobs, r.Extranonce1, r.Extranonce2Len, lm, lmeth}
}

// merkleBytes is b"".join(_hex(b) for b in document.get("merkle_branches") or []) with Python iteration semantics.
func merkleBytes(v pyValue) ([]byte, error) {
	if !v.truthy() {
		return []byte{}, nil
	}
	out := []byte{}
	switch v.kind {
	case pyList:
		for _, it := range v.items {
			b, err := pyFromHex(it)
			if err != nil {
				return nil, err
			}
			out = append(out, b...)
		}
		return out, nil
	case pyDict: // iterating a dict yields its keys
		for i := 0; i < len(v.items); i += 2 {
			b, err := pyFromHex(v.items[i])
			if err != nil {
				return nil, err
			}
			out = append(out, b...)
		}
		return out, nil
	case pyStr: // iterating a str yields characters; only whitespace survives bytes.fromhex
		for i := 0; i < len(v.s); i++ {
			if !isPySpace(v.s[i]) {
				return nil, errors.New("non-hexadecimal number found in fromhex() arg")
			}
		}
		return out, nil
	}
	return nil, errPyType // int / float / bool: not iterable
}

// toRow converts a document to a `templates` row exactly like pgsink.to_row. On top of Python's checks it rejects
// values Postgres would refuse (NUL or a lone surrogate in job_id, a height or extranonce2_length out of the column's
// range): Python would fail the whole batch on those and retry it forever.
func toRow(d *Document, sourceID int16) (Row, error) {
	var r Row
	if d.TsNs < 0 {
		return r, errors.New("negative timestamp")
	}
	r.ReceivedAt = time.UnixMicro(d.TsNs / 1000).UTC() // µs precision: ns // 1000
	r.SourceID = sourceID
	if d.Height > math.MaxInt32 || d.Height < math.MinInt32 {
		return r, fmt.Errorf("height %d out of range for integer", d.Height)
	}
	r.Height = int32(d.Height)
	r.JobID = pyStrOf(d.Params[pJobID])
	if strings.IndexByte(r.JobID, 0) >= 0 || hasSurrogate(r.JobID) {
		return r, errors.New("job_id not storable as text")
	}
	var err error
	if r.PrevHash, err = pyFromHex(d.Params[pPrevHash]); err != nil {
		return r, fmt.Errorf("prev_hash: %w", err)
	}
	if r.Coinbase1, err = pyFromHex(d.Params[pCoinbase1]); err != nil {
		return r, fmt.Errorf("coinbase1: %w", err)
	}
	if r.Coinbase2, err = pyFromHex(d.Params[pCoinbase2]); err != nil {
		return r, fmt.Errorf("coinbase2: %w", err)
	}
	if r.MerkleBranches, err = merkleBytes(d.Params[pMerkle]); err != nil {
		return r, fmt.Errorf("merkle_branches: %w", err)
	}
	if r.Version, err = pyU32(d.Params[pVersion]); err != nil {
		return r, fmt.Errorf("version: %w", err)
	}
	if r.Nbits, err = pyU32(d.Params[pNbits]); err != nil {
		return r, fmt.Errorf("nbits: %w", err)
	}
	if r.Ntime, err = pyU32(d.Params[pNtime]); err != nil {
		return r, fmt.Errorf("ntime: %w", err)
	}
	r.CleanJobs = d.Params[pCleanJobs].truthy()
	if r.Extranonce1, err = pyFromHex(d.Extranonce1); err != nil {
		return r, fmt.Errorf("extranonce1: %w", err)
	}
	en2, err := pyIntOfValue(d.Extranonce2Len)
	if err != nil {
		return r, fmt.Errorf("extranonce2_length: %w", err)
	}
	if !en2.IsInt64() || en2.Int64() < math.MinInt16 || en2.Int64() > math.MaxInt16 {
		return r, errors.New("extranonce2_length out of range for smallint")
	}
	r.Extranonce2Len = int16(en2.Int64())
	if d.HasLatency {
		f := float32(d.LatencyMs) // float8 -> real, rounded to nearest like Postgres' assignment cast
		r.LatencyMs = &f
		if d.LatencyMethod == "tcp" || d.LatencyMethod == "app" {
			m := d.LatencyMethod
			r.LatencyMethod = &m
		}
	}
	return r, nil
}

// ── routing (pgsink.py route) ────────────────────────────────────────────────────────────────────────────────────

const (
	tipBehind = 6
	tipAhead  = 2
)

type Route struct{ Table, Chain, Reason string }

var routeBTC = Route{Table: "templates"}

func route(height int64, chainFamily string, tip int64, tipOK bool) Route {
	switch {
	case height <= 0:
		return Route{"templates_other", "unknown", "height_parse_failed"}
	case chainFamily == "bch":
		return Route{"templates_other", "bch", "bch"}
	case chainFamily != "":
		return Route{"templates_other", "unknown", "unknown_chain"}
	case tipOK && (height < tip-tipBehind || height > tip+tipAhead): // not tip-6 <= height <= tip+2
		return Route{"templates_other", "unknown", "height_implausible"}
	}
	return routeBTC
}
