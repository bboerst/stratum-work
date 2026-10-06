package router

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/bboerst/stratum-work/router/internal/stratum"
	"github.com/bboerst/stratum-work/router/internal/work"
)

const (
	banWindow    = 5 * time.Minute
	banMinShares = 50
)

// onSubmit validates a downstream share; false closes the session (ban).
func (s *session) onSubmit(m *stratum.Message) bool {
	var p []string
	if json.Unmarshal(m.Params, &p) != nil || len(p) < 5 {
		_ = s.c.Write(stratum.Response(m.ID, nil, stratum.ErrOther))
		return true
	}
	s.mu.Lock()
	authorized, worker := s.authorized, s.worker
	s.mu.Unlock()
	if !authorized {
		_ = s.c.Write(stratum.Response(m.ID, nil, stratum.ErrUnauthorized))
		return true
	}
	jobID, en2, ntime, nonce := p[1], p[2], p[3], p[4]
	e, ok := s.r.reg.Get(jobID)
	if !ok {
		s.count("stale")
		_ = s.c.Write(stratum.Response(m.ID, nil, stratum.ErrJobNotFound))
		return true
	}

	var vbits uint32
	// Validate against the connection's negotiated mask (the work the miner
	// really did). Whether the bits can go upstream is decided at forwarding.
	hasV := len(p) > 5 && p[5] != ""
	if hasV {
		n, err := strconv.ParseUint(p[5], 16, 32)
		if err != nil || uint32(n)&^e.Mask != 0 {
			return s.reject(m, "invalid")
		}
		vbits = uint32(n)
	}
	if s.r.reg.Seen(jobID, en2, ntime, nonce, vbits) {
		s.count("duplicate")
		_ = s.c.Write(stratum.Response(m.ID, nil, stratum.ErrDuplicate))
		return true
	}
	if len(en2) != downEn2Size*2 {
		return s.reject(m, "invalid")
	}

	cb1, cb2 := work.DownstreamCoinbase(e.Job, e.En1, e.Fold)
	cb, err := work.BuildCoinbase(cb1, s.en1, en2, cb2)
	if err != nil {
		return s.reject(m, "invalid")
	}
	root, err := work.MerkleRoot(cb, e.Job.Branches)
	if err != nil {
		return s.reject(m, "invalid")
	}
	version := e.Job.Version
	if hasV {
		version = work.RolledVersion(e.Job.Version, vbits, e.Mask)
	}
	hdr, err := work.BuildHeader(version, e.Job.PrevHash, root, ntime, e.Job.NBits, nonce)
	if err != nil {
		return s.reject(m, "invalid")
	}
	hash := work.DoubleSHA256(hdr[:])
	if !work.MeetsTarget(hash, work.DiffToTarget(e.Diff)) {
		return s.reject(m, "invalid")
	}

	_ = s.c.Write(stratum.Response(m.ID, true, nil))
	up := e.client.State()
	// Rolled bits the target never agreed to: valid work for the miner's
	// accounting, but the pool can never use it, so it is not delivered.
	usable := vbits&^up.VersionMask == 0
	s.credit(e, worker, usable)
	if !usable {
		s.r.countShare("unforwardable")
		return true
	}

	// Forward only while the issuing session is unchanged: a reconnect or
	// set_extranonce changes En1, which would make the pool reject the share.
	if up.Connected && up.En1 == e.En1 && up.Difficulty > 0 &&
		work.MeetsTarget(hash, work.DiffToTarget(up.Difficulty)) {
		if _, still := s.r.reg.Get(jobID); still {
			var vp *uint32
			if up.VersionMask != 0 && hasV {
				vp = &vbits
			}
			if _, err := e.client.Submit(worker, e.Job.UpstreamID, work.UpstreamEn2(s.en1, en2, e.Fold), ntime, nonce, vp); err != nil {
				s.r.log.Debug("upstream submit failed", "target", e.Target, "err", err)
			}
		}
	}
	return true
}
