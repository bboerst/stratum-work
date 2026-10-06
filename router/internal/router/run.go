package router

import (
	"context"
	"errors"
	"net"
	"sync"
	"time"

	"github.com/bboerst/stratum-work/router/internal/upstream"
)

const tickInterval = 250 * time.Millisecond

// Run starts upstream clients, the downstream listener and the scheduler
// tick loop. It returns when ctx is cancelled.
func (r *Router) Run(ctx context.Context) error {
	ln, err := net.Listen("tcp", r.cfg.Listen)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	r.mu.Lock()
	r.ln = ln
	r.remDownSince = time.Now() // remainder counts as down until it authorizes
	r.mu.Unlock()

	var wg sync.WaitGroup
	for _, t := range r.targets {
		for _, c := range []*upstream.Client{t.client, t.fallback} {
			if c == nil {
				continue
			}
			wg.Add(1)
			go func() { defer wg.Done(); c.Run(ctx) }()
		}
	}
	wg.Add(1)
	go func() { defer wg.Done(); r.tickLoop(ctx) }()
	go func() { <-ctx.Done(); _ = ln.Close() }()

	for {
		raw, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				break
			}
			r.log.Warn("accept failed", "err", err)
			time.Sleep(50 * time.Millisecond)
			continue
		}
		r.admit(ctx, raw, &wg)
	}
	r.closeAll()
	wg.Wait()
	return nil
}

// Addr returns the listen address once Run is listening, else nil.
func (r *Router) Addr() net.Addr {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ln == nil {
		return nil
	}
	return r.ln.Addr()
}

func (r *Router) tickLoop(ctx context.Context) {
	t := time.NewTicker(tickInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			r.tick(now)
		}
	}
}

func (r *Router) closeAll() {
	r.mu.Lock()
	ss := make([]*session, 0, len(r.sessions))
	for _, s := range r.sessions {
		ss = append(ss, s)
	}
	r.mu.Unlock()
	for _, s := range ss {
		s.close()
	}
}
