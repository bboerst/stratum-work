package router

import (
	"context"
	"net"
	"sync"
	"time"
)

const banDuration = time.Hour

func remoteIP(c net.Conn) string {
	if a, ok := c.RemoteAddr().(*net.TCPAddr); ok {
		return a.IP.String()
	}
	h, _, _ := net.SplitHostPort(c.RemoteAddr().String())
	return h
}

// admit enforces bans and connection caps, then starts a session.
func (r *Router) admit(ctx context.Context, raw net.Conn, wg *sync.WaitGroup) {
	ip := remoteIP(raw)
	now := time.Now()
	r.mu.Lock()
	if exp, ok := r.bans[ip]; ok {
		if now.Before(exp) {
			r.mu.Unlock()
			_ = raw.Close()
			return
		}
		delete(r.bans, ip)
	}
	if len(r.sessions) >= r.cfg.Limits.MaxConnections || r.perIP[ip] >= r.cfg.Limits.MaxConnectionsPerIP {
		r.mu.Unlock()
		_ = raw.Close()
		return
	}
	r.nextConn++
	s := newSession(r, r.nextConn, raw, ip)
	r.sessions[s.id] = s
	r.perIP[ip]++
	r.mu.Unlock()

	wg.Add(1)
	go func() {
		defer wg.Done()
		s.serve(ctx)
		r.mu.Lock()
		delete(r.sessions, s.id)
		if r.perIP[ip]--; r.perIP[ip] <= 0 {
			delete(r.perIP, ip)
		}
		r.mu.Unlock()
	}()
}

func (r *Router) ban(ip string) {
	r.mu.Lock()
	r.bans[ip] = time.Now().Add(banDuration)
	r.mu.Unlock()
	r.log.Warn("banned ip for invalid shares", "duration", banDuration)
}

func (r *Router) newJobID() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextJob++
	return hex8(r.nextJob)
}

func (r *Router) countShare(result string) {
	r.mu.Lock()
	r.shares[result]++
	r.mu.Unlock()
}

// tick recomputes each connection's per-target goals and switches sessions.
func (r *Router) tick(now time.Time) {
	fbChanged := r.updateFallback(now)
	r.mu.Lock()
	ss := make([]*session, 0, len(r.sessions))
	for _, s := range r.sessions {
		ss = append(ss, s)
	}
	fb := r.fallbackActive
	r.mu.Unlock()

	total := 0.0
	rates := make([]float64, len(ss))
	for i, s := range ss {
		rates[i] = s.rate.HashesPerSecond(now)
		total += rates[i]
	}
	for i, s := range ss {
		s.schedule(now, rates[i], total, fb, fbChanged)
	}
}
