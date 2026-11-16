package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
)

// Transaction and block parsing (BIP141/BIP144 serialization), only as far as the recorder needs: txid, wtxid,
// size, weight, vsize and the inputs (prevouts).
//
// Byte order: a Hash is stored in INTERNAL byte order, the bytes the hash function produced. That's the order used
// inside blocks, merkle trees and Stratum's merkle_branches, so a template's merkle_branches[0] compares directly to
// a stored txid. RPC, ZMQ and block explorers DISPLAY hashes reversed; Display()/ParseDisplayHash convert.

type Hash [32]byte

// Display returns the hash as RPC and explorers show it (reversed byte order, hex).
func (h Hash) Display() string {
	var r Hash
	for i := range h {
		r[i] = h[31-i]
	}
	return hex.EncodeToString(r[:])
}

func (h Hash) String() string { return h.Display() }

// ParseDisplayHash reads a hash in display order (64 hex characters).
func ParseDisplayHash(s string) (Hash, error) {
	var h Hash
	if len(s) != 64 {
		return h, fmt.Errorf("hash %q: want 64 hex characters", s)
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return h, err
	}
	for i := range h {
		h[i] = b[31-i]
	}
	return h, nil
}

// reversed32 converts a 32-byte hash between internal and display order (ZMQ bodies are display order).
func reversed32(b []byte) Hash {
	var h Hash
	for i := range h {
		h[i] = b[31-i]
	}
	return h
}

func sha256d(parts ...[]byte) Hash {
	h := sha256.New()
	for _, p := range parts {
		h.Write(p)
	}
	first := h.Sum(nil)
	return Hash(sha256.Sum256(first))
}

// OutpointLen is the size of one serialized prevout: txid (internal order) + output index (u32 LE). A transaction's
// inputs are stored as their concatenation, the same bytes the transaction itself carries.
const OutpointLen = 36

type Tx struct {
	Txid, Wtxid Hash
	Size        int    // serialized size with witness (bytes)
	Weight      int    // BIP141 weight: base size * 3 + total size
	Inputs      []byte // n x OutpointLen
	Raw         []byte // the serialization, kept only when raw storage is on
}

// VSize is the BIP141 virtual size, ceil(weight / 4). (The mempool's own vsize can be larger for transactions with
// many signature operations; that adjusted size is what getmempoolentry's ancestor/descendant sizes use.)
func (t *Tx) VSize() int { return (t.Weight + 3) / 4 }

func (t *Tx) NumInputs() int { return len(t.Inputs) / OutpointLen }

// Input returns prevout i: the funding transaction's txid and the output index.
func (t *Tx) Input(i int) (Hash, uint32) { return inputAt(t.Inputs, i) }

func inputAt(inputs []byte, i int) (Hash, uint32) {
	o := inputs[i*OutpointLen : (i+1)*OutpointLen]
	return Hash(o[:32]), binary.LittleEndian.Uint32(o[32:])
}

var errShort = errors.New("truncated data")

type reader struct {
	b   []byte
	pos int
}

func (r *reader) need(n int) error {
	if n < 0 || len(r.b)-r.pos < n {
		return errShort
	}
	return nil
}

func (r *reader) skip(n int) error {
	if err := r.need(n); err != nil {
		return err
	}
	r.pos += n
	return nil
}

func (r *reader) varint() (uint64, error) {
	if err := r.need(1); err != nil {
		return 0, err
	}
	p := r.b[r.pos]
	r.pos++
	var n int
	switch p {
	case 0xfd:
		n = 2
	case 0xfe:
		n = 4
	case 0xff:
		n = 8
	default:
		return uint64(p), nil
	}
	if err := r.need(n); err != nil {
		return 0, err
	}
	var v uint64
	for i := n - 1; i >= 0; i-- {
		v = v<<8 | uint64(r.b[r.pos+i])
	}
	r.pos += n
	return v, nil
}

// count reads a varint count of items that each take at least minItem bytes, rejecting counts the remaining data
// can't hold (so a malformed length can never cause a huge allocation).
func (r *reader) count(minItem int) (int, error) {
	v, err := r.varint()
	if err != nil {
		return 0, err
	}
	if v > uint64(len(r.b)-r.pos)/uint64(minItem) {
		return 0, fmt.Errorf("count %d exceeds the remaining %d bytes", v, len(r.b)-r.pos)
	}
	return int(v), nil
}

func (r *reader) varbytes() error {
	n, err := r.count(1)
	if err != nil {
		return err
	}
	return r.skip(n)
}

// ParseTx parses one serialized transaction that must fill b exactly.
func ParseTx(b []byte, keepRaw bool) (*Tx, error) {
	r := &reader{b: b}
	tx, err := parseTx(r, keepRaw)
	if err != nil {
		return nil, err
	}
	if r.pos != len(b) {
		return nil, fmt.Errorf("%d trailing bytes after the transaction", len(b)-r.pos)
	}
	return tx, nil
}

func parseTx(r *reader, keepRaw bool) (*Tx, error) {
	start := r.pos
	if err := r.skip(4); err != nil { // version
		return nil, err
	}
	segwit := false
	if r.need(2) == nil && r.b[r.pos] == 0x00 && r.b[r.pos+1] != 0x00 {
		if r.b[r.pos+1] != 0x01 {
			return nil, fmt.Errorf("unknown segwit flag %#x", r.b[r.pos+1])
		}
		segwit = true
		r.pos += 2
	}
	bodyStart := r.pos
	nIn, err := r.count(41) // prevout 36 + script length 1 + sequence 4
	if err != nil {
		return nil, fmt.Errorf("inputs: %w", err)
	}
	if nIn == 0 {
		return nil, errors.New("no inputs")
	}
	inputs := make([]byte, 0, nIn*OutpointLen)
	for range nIn {
		if err := r.need(OutpointLen); err != nil {
			return nil, err
		}
		inputs = append(inputs, r.b[r.pos:r.pos+OutpointLen]...)
		r.pos += OutpointLen
		if err := r.varbytes(); err != nil { // scriptSig
			return nil, err
		}
		if err := r.skip(4); err != nil { // sequence
			return nil, err
		}
	}
	nOut, err := r.count(9) // value 8 + script length 1
	if err != nil {
		return nil, fmt.Errorf("outputs: %w", err)
	}
	for range nOut {
		if err := r.skip(8); err != nil {
			return nil, err
		}
		if err := r.varbytes(); err != nil {
			return nil, err
		}
	}
	bodyEnd := r.pos
	if segwit {
		for range nIn {
			items, err := r.count(1)
			if err != nil {
				return nil, fmt.Errorf("witness: %w", err)
			}
			for range items {
				if err := r.varbytes(); err != nil {
					return nil, err
				}
			}
		}
	}
	lockStart := r.pos
	if err := r.skip(4); err != nil {
		return nil, err
	}
	full := r.b[start:r.pos]
	tx := &Tx{Size: len(full), Inputs: inputs}
	base := 4 + (bodyEnd - bodyStart) + 4
	tx.Weight = base*3 + len(full)
	tx.Txid = sha256d(r.b[start:start+4], r.b[bodyStart:bodyEnd], r.b[lockStart:r.pos])
	if segwit {
		tx.Wtxid = sha256d(full)
	} else {
		tx.Wtxid = tx.Txid
	}
	if keepRaw {
		tx.Raw = append([]byte(nil), full...)
	}
	return tx, nil
}

type Block struct {
	Hash Hash
	Txs  []*Tx // Txs[0] is the coinbase
}

// ParseBlock parses a serialized block (header + transactions).
func ParseBlock(b []byte) (*Block, error) {
	r := &reader{b: b}
	if err := r.skip(80); err != nil {
		return nil, err
	}
	blk := &Block{Hash: sha256d(b[:80])}
	n, err := r.count(60)
	if err != nil {
		return nil, fmt.Errorf("transaction count: %w", err)
	}
	blk.Txs = make([]*Tx, 0, n)
	for i := range n {
		tx, err := parseTx(r, false)
		if err != nil {
			return nil, fmt.Errorf("transaction %d: %w", i, err)
		}
		blk.Txs = append(blk.Txs, tx)
	}
	if r.pos != len(b) {
		return nil, fmt.Errorf("%d trailing bytes after the block", len(b)-r.pos)
	}
	return blk, nil
}
