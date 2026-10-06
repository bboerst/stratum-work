package router

import (
	"time"

	"github.com/bboerst/stratum-work/router/internal/accounting"
	"github.com/bboerst/stratum-work/router/internal/upstream"
)

const (
	prefixLen   = 4 // downstream en1 (P) bytes
	downEn2Size = 4 // S_down
	rollMask    = uint32(0x1fffe000)
	rateTau     = 10 * time.Minute
)

// target is one upstream destination. The remainder target may have a
// fallback client that takes over while the primary is down.
type target struct {
	id, pool  string
	targetHs  float64
	remainder bool
	client    *upstream.Client
	fallback  *upstream.Client
	delivered *accounting.Rate
}

// active returns the client currently serving this target.
func (t *target) active(fallbackActive bool) *upstream.Client {
	if t.remainder && fallbackActive && t.fallback != nil {
		return t.fallback
	}
	return t.client
}

// jobView is a snapshot of what a session needs to send work for a target.
type jobView struct {
	st     upstream.State
	client *upstream.Client
	ok     bool
}

// view snapshots the active client's state and checks it is usable for a
// connection with the given downstream version mask.
func (t *target) view(fallbackActive bool, connMask uint32) jobView {
	c := t.active(fallbackActive)
	if c == nil {
		return jobView{}
	}
	st := c.State()
	ok := st.Connected && len(st.Jobs) > 0 && st.En2Size >= prefixLen+downEn2Size
	if ok && !t.remainder && connMask != 0 && st.VersionMask&connMask != connMask {
		ok = false
	}
	return jobView{st: st, client: c, ok: ok}
}
