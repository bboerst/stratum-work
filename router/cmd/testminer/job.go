package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"

	"github.com/bboerst/stratum-work/router/internal/work"
)

// job is a mining.notify as seen by the miner.
type job struct {
	ID, PrevHash, Coinb1, Coinb2, NBits, NTime string
	Branches                                   []string
	Version                                    uint32
	Clean                                      bool
}

// parseNotify decodes mining.notify params.
func parseNotify(params []json.RawMessage) (job, error) {
	var j job
	if len(params) < 9 {
		return j, errors.New("notify: need 9 params")
	}
	var ver string
	for i, dst := range []*string{&j.ID, &j.PrevHash, &j.Coinb1, &j.Coinb2} {
		if err := json.Unmarshal(params[i], dst); err != nil {
			return j, fmt.Errorf("notify param %d: %w", i, err)
		}
	}
	if err := json.Unmarshal(params[4], &j.Branches); err != nil {
		return j, fmt.Errorf("notify branches: %w", err)
	}
	_ = json.Unmarshal(params[5], &ver)
	_ = json.Unmarshal(params[6], &j.NBits)
	_ = json.Unmarshal(params[7], &j.NTime)
	_ = json.Unmarshal(params[8], &j.Clean)
	if _, err := fmt.Sscanf(ver, "%08x", &j.Version); err != nil {
		return j, fmt.Errorf("notify version: %w", err)
	}
	return j, nil
}

// work is everything needed to hash one job.
type workUnit struct {
	j      job
	en1    string
	en2Len int // bytes
	mask   uint32
	target *big.Int
}

// share is a found solution.
type share struct {
	JobID, En2, NTime, Nonce, VersionBits string
	Hash                                  [32]byte
}

// header builds the 80-byte header for (en2, vbits) with nonce 0.
func header(w *workUnit, en2 string, vbits uint32) ([80]byte, error) {
	cb, err := work.BuildCoinbase(w.j.Coinb1, w.en1, en2, w.j.Coinb2)
	if err != nil {
		return [80]byte{}, err
	}
	root, err := work.MerkleRoot(cb, w.j.Branches)
	if err != nil {
		return [80]byte{}, err
	}
	return work.BuildHeader(work.RolledVersion(w.j.Version, vbits, w.mask),
		w.j.PrevHash, root, w.j.NTime, w.j.NBits, "00000000")
}

// hashOne returns the header hash for (en2, nonce, vbits).
func hashOne(w *workUnit, en2 string, nonce, vbits uint32) ([32]byte, error) {
	h, err := header(w, en2, vbits)
	if err != nil {
		return [32]byte{}, err
	}
	binary.LittleEndian.PutUint32(h[76:80], nonce)
	return work.DoubleSHA256(h[:]), nil
}

// en2Hex formats counter ctr as an en2 of n bytes (low bytes kept).
func en2Hex(ctr uint64, n int) string {
	s := fmt.Sprintf("%0*x", n*2, ctr)
	return s[len(s)-n*2:]
}

// search scans nonces [0, limit) for en2 counter ctr, rolling one version
// bit pattern per en2 when a mask is negotiated. abort is polled every 4096
// hashes; it returns (share, true) on success.
func search(w *workUnit, ctr uint64, limit uint32, abort func() bool) (share, bool, error) {
	en2 := en2Hex(ctr, w.en2Len)
	var vbits uint32
	if w.mask != 0 {
		// Spread ctr across the mask bits so version rolling is exercised.
		vbits = depositBits(uint32(ctr), w.mask)
	}
	hdr, err := header(w, en2, vbits)
	if err != nil {
		return share{}, false, err
	}
	for nonce := uint32(0); nonce < limit; nonce++ {
		if nonce&0xfff == 0 && abort() {
			return share{}, false, nil
		}
		binary.LittleEndian.PutUint32(hdr[76:80], nonce)
		h := work.DoubleSHA256(hdr[:])
		if work.MeetsTarget(h, w.target) {
			s := share{JobID: w.j.ID, En2: en2, NTime: w.j.NTime, Nonce: fmt.Sprintf("%08x", nonce), Hash: h}
			if w.mask != 0 {
				s.VersionBits = fmt.Sprintf("%08x", vbits)
			}
			return s, true, nil
		}
	}
	return share{}, false, nil
}

// depositBits places the low bits of v into the set bits of mask (PDEP).
func depositBits(v, mask uint32) uint32 {
	var out uint32
	for bit := uint32(1); bit != 0 && mask != 0; bit <<= 1 {
		low := mask & -mask
		if v&bit != 0 {
			out |= low
		}
		mask &^= low
	}
	return out
}
