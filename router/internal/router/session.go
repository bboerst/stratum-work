package router

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/bboerst/stratum-work/router/internal/accounting"
	"github.com/bboerst/stratum-work/router/internal/downstream"
	"github.com/bboerst/stratum-work/router/internal/sched"
	"github.com/bboerst/stratum-work/router/internal/stratum"
)

func hex8(n uint64) string { return fmt.Sprintf("%08x", uint32(n)) }

// session is one downstream miner connection.
type session struct {
	r    *Router
	id   uint64
	raw  net.Conn
	c    *stratum.Conn
	ip   string
	en1  string // P
	rate *accounting.Rate
	sch  *sched.Scheduler

	sendMu sync.Mutex // serializes sendWork; taken before mu, never under it

	mu         sync.Mutex
	subscribed bool
	authorized bool
	worker     string
	mask       uint32 // negotiated downstream version mask (0 = none)
	vd         *downstream.VarDiff
	sentDiff   float64
	current    string // target id the miner is working on
	accepted   uint64
	invalid    uint64
	stale      uint64
	duplicate  uint64
	window     []shareMark // recent validated/invalid shares for ban ratio
}

type shareMark struct {
	at      time.Time
	invalid bool
}

func newSession(r *Router, id uint64, raw net.Conn, ip string) *session {
	var sts []sched.Target
	for _, t := range r.targets {
		if !t.remainder {
			sts = append(sts, sched.Target{ID: t.id})
		}
	}
	vd := r.cfg.VarDiff
	return &session{
		r: r, id: id, raw: raw, c: stratum.NewConn(raw), ip: ip,
		en1:  hex8(id),
		rate: accounting.NewRate(rateTau),
		sch:  sched.New(sts, r.remainder.id, time.Duration(r.cfg.Slice.MinSliceMs)*time.Millisecond),
		vd:   downstream.NewVarDiff(vd.Start, vd.Min, vd.Max, vd.SharesPerSec),
	}
}

func (s *session) close() { _ = s.c.Close() }

func (s *session) serve(ctx context.Context) {
	defer s.close()
	idle := time.Duration(s.r.cfg.Limits.IdleTimeoutS) * time.Second
	for ctx.Err() == nil {
		if idle > 0 {
			_ = s.raw.SetReadDeadline(time.Now().Add(idle))
		}
		m, err := s.c.Read()
		if err != nil {
			return
		}
		if !m.IsRequest() {
			continue
		}
		if !s.handle(m) {
			return
		}
	}
}

// handle dispatches one request; false closes the session.
func (s *session) handle(m *stratum.Message) bool {
	switch m.Method {
	case "mining.configure":
		s.onConfigure(m)
	case "mining.subscribe":
		s.mu.Lock()
		s.subscribed = true
		s.mu.Unlock()
		sid := s.en1
		_ = s.c.Write(stratum.Response(m.ID, []any{
			[]any{[]any{"mining.set_difficulty", sid}, []any{"mining.notify", sid}},
			s.en1, downEn2Size}, nil))
	case "mining.authorize":
		s.onAuthorize(m)
	case "mining.extranonce.subscribe", "mining.suggest_difficulty":
		_ = s.c.Write(stratum.Response(m.ID, true, nil))
	case "mining.submit":
		return s.onSubmit(m)
	default:
		_ = s.c.Write(stratum.Response(m.ID, nil, stratum.ErrOther))
	}
	return true
}
