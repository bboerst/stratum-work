// Package upstream implements a Stratum V1 client for a single upstream target.
package upstream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"time"

	"github.com/bboerst/stratum-work/router/internal/stratum"
	"github.com/bboerst/stratum-work/router/internal/work"
)

const (
	readTimeout = 180 * time.Second
	dialTimeout = 10 * time.Second
	maxJobs     = 16
	minBackoff  = time.Second
	maxBackoff  = 30 * time.Second
	userAgent   = "stratum-work-router/1"
	requestMask = "1fffe000"
)

// ErrNotConnected is returned by Submit when there is no authorized session.
var ErrNotConnected = errors.New("upstream: not connected")

type State struct {
	En1         string
	En2Size     int
	VersionMask uint32 // 0 when not negotiated
	Difficulty  float64
	Jobs        []work.Job // latest first, max 16; cleared on clean_jobs
	Connected   bool
}

type Events interface {
	OnJob(target string, job work.Job) // after State updated
	OnDifficulty(target string, diff float64)
	OnState(target string, connected bool)
	OnSubmitResult(target string, reqID uint64, accepted bool, reason string)
}

type Client struct {
	id, addr, username, password string
	ev                           Events
	log                          *slog.Logger

	mu      sync.Mutex
	st      State
	conn    *stratum.Conn
	nextID  uint64
	pending map[uint64]struct{} // outstanding mining.submit request ids
}

func New(id, addr, username, password string, ev Events, log *slog.Logger) *Client {
	if log == nil {
		log = slog.Default()
	}
	return &Client{
		id: id, addr: addr, username: username, password: password,
		ev: ev, log: log.With("target", id, "upstream", addr),
		pending: make(map[uint64]struct{}),
	}
}

// State returns a copy of the current upstream state.
func (c *Client) State() State {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.st
	s.Jobs = append([]work.Job(nil), c.st.Jobs...)
	return s
}

func (c *Client) newID() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	return c.nextID
}

// Run connects and serves the upstream session, reconnecting with exponential
// backoff (1s doubling to 30s, reset after a successful authorize) until ctx is cancelled.
func (c *Client) Run(ctx context.Context) {
	backoff := minBackoff
	for ctx.Err() == nil {
		authorized, err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		if authorized {
			backoff = minBackoff
		}
		c.log.Warn("upstream session ended", "err", err, "retry_in", backoff)
		t := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// session runs one connection. It reports whether authorize succeeded.
func (c *Client) session(ctx context.Context) (authorized bool, err error) {
	d := net.Dialer{Timeout: dialTimeout}
	raw, err := d.DialContext(ctx, "tcp", c.addr)
	if err != nil {
		return false, err
	}
	conn := stratum.NewConn(raw)
	stop := context.AfterFunc(ctx, func() { _ = raw.Close() })
	defer stop()
	defer func() {
		_ = raw.Close()
		c.disconnect(conn, authorized)
	}()

	read := func() (*stratum.Message, error) {
		_ = raw.SetReadDeadline(time.Now().Add(readTimeout))
		return conn.Read()
	}

	// Handshake: configure -> subscribe -> authorize.
	cfgID, subID, authID := c.newID(), c.newID(), c.newID()
	if err := conn.Write(stratum.Request(cfgID, "mining.configure",
		[]string{"version-rolling"},
		map[string]any{"version-rolling.mask": requestMask, "version-rolling.min-bit-count": 2},
	)); err != nil {
		return false, err
	}
	if err := conn.Write(stratum.Request(subID, "mining.subscribe", userAgent)); err != nil {
		return false, err
	}
	if err := conn.Write(stratum.Request(authID, "mining.authorize", c.username, c.password)); err != nil {
		return false, err
	}

	for {
		m, err := read()
		if err != nil {
			return authorized, err
		}
		if m.Method != "" {
			c.handleNotification(m)
			continue
		}
		id, ok := parseID(m.ID)
		if !ok {
			continue
		}
		switch id {
		case cfgID:
			c.handleConfigure(m)
		case subID:
			if err := c.handleSubscribe(m); err != nil {
				return authorized, err
			}
		case authID:
			var res bool
			if rpcErr(m) != "" || json.Unmarshal(m.Result, &res) != nil || !res {
				return false, fmt.Errorf("authorize rejected: %s", orDefault(rpcErr(m), "false"))
			}
			authorized = true
			c.mu.Lock()
			c.st.Connected = true
			c.conn = conn
			c.mu.Unlock()
			c.log.Info("upstream authorized", "user", c.username)
			c.ev.OnState(c.id, true)
		default:
			c.handleSubmitResult(id, m)
		}
	}
}

func (c *Client) disconnect(conn *stratum.Conn, wasConnected bool) {
	c.mu.Lock()
	if c.conn == conn {
		c.conn = nil
	}
	// Every session starts from zero: negotiated mask, extranonce and
	// difficulty must never leak into the next session.
	c.st = State{}
	lost := make([]uint64, 0, len(c.pending))
	for id := range c.pending {
		lost = append(lost, id)
	}
	c.pending = make(map[uint64]struct{})
	c.mu.Unlock()
	for _, id := range lost {
		c.ev.OnSubmitResult(c.id, id, false, "disconnected")
	}
	if wasConnected {
		c.ev.OnState(c.id, false)
	}
}

func (c *Client) handleConfigure(m *stratum.Message) {
	if rpcErr(m) != "" {
		c.log.Warn("mining.configure failed; version rolling not negotiated", "err", rpcErr(m))
		return
	}
	var res map[string]any
	if json.Unmarshal(m.Result, &res) != nil {
		return
	}
	if on, _ := res["version-rolling"].(bool); !on {
		c.log.Warn("upstream did not enable version rolling")
		return
	}
	s, _ := res["version-rolling.mask"].(string)
	mask, err := parseHex32(s)
	if err != nil {
		c.log.Warn("bad version-rolling mask", "mask", s)
		return
	}
	c.mu.Lock()
	c.st.VersionMask = mask
	c.mu.Unlock()
}

func (c *Client) handleSubscribe(m *stratum.Message) error {
	if e := rpcErr(m); e != "" {
		return fmt.Errorf("subscribe rejected: %s", e)
	}
	var res []json.RawMessage
	if err := json.Unmarshal(m.Result, &res); err != nil || len(res) < 3 {
		return fmt.Errorf("bad subscribe result")
	}
	var en1 string
	var en2 int
	if json.Unmarshal(res[1], &en1) != nil || json.Unmarshal(res[2], &en2) != nil {
		return fmt.Errorf("bad subscribe result")
	}
	c.mu.Lock()
	c.st.En1, c.st.En2Size = en1, en2
	c.mu.Unlock()
	return nil
}

func (c *Client) handleSubmitResult(id uint64, m *stratum.Message) {
	c.mu.Lock()
	_, ok := c.pending[id]
	delete(c.pending, id)
	c.mu.Unlock()
	if !ok {
		return
	}
	var accepted bool
	_ = json.Unmarshal(m.Result, &accepted)
	reason := ""
	if !accepted {
		reason = orDefault(rpcErr(m), "rejected")
	}
	c.ev.OnSubmitResult(c.id, id, accepted, reason)
}

func (c *Client) handleNotification(m *stratum.Message) {
	var params []json.RawMessage
	_ = json.Unmarshal(m.Params, &params)
	switch m.Method {
	case "mining.notify":
		job, err := parseNotify(params)
		if err != nil {
			c.log.Warn("bad mining.notify", "err", err)
			return
		}
		c.mu.Lock()
		if job.Clean {
			c.st.Jobs = nil
		}
		jobs := make([]work.Job, 0, maxJobs)
		jobs = append(jobs, job)
		for _, j := range c.st.Jobs {
			if len(jobs) == maxJobs {
				break
			}
			jobs = append(jobs, j)
		}
		c.st.Jobs = jobs
		c.mu.Unlock()
		c.ev.OnJob(c.id, job)
	case "mining.set_difficulty":
		var d float64
		if len(params) < 1 || json.Unmarshal(params[0], &d) != nil || d <= 0 {
			c.log.Warn("bad mining.set_difficulty")
			return
		}
		c.mu.Lock()
		c.st.Difficulty = d
		c.mu.Unlock()
		c.ev.OnDifficulty(c.id, d)
	case "mining.set_extranonce":
		var en1 string
		var en2 int
		if len(params) < 2 || json.Unmarshal(params[0], &en1) != nil || json.Unmarshal(params[1], &en2) != nil {
			c.log.Warn("bad mining.set_extranonce")
			return
		}
		c.mu.Lock()
		c.st.En1, c.st.En2Size = en1, en2
		c.mu.Unlock()
	case "mining.set_version_mask":
		var s string
		if len(params) < 1 || json.Unmarshal(params[0], &s) != nil {
			c.log.Warn("bad mining.set_version_mask")
			return
		}
		mask, err := parseHex32(s)
		if err != nil {
			c.log.Warn("bad mining.set_version_mask", "mask", s)
			return
		}
		c.mu.Lock()
		c.st.VersionMask = mask
		c.mu.Unlock()
	}
}

// Submit sends mining.submit upstream and returns its request id. The result
// is delivered asynchronously via Events.OnSubmitResult.
func (c *Client) Submit(worker, jobID, en2, ntime, nonce string, version *uint32) (uint64, error) {
	c.mu.Lock()
	conn := c.conn
	if conn == nil || !c.st.Connected {
		c.mu.Unlock()
		return 0, ErrNotConnected
	}
	c.nextID++
	id := c.nextID
	c.pending[id] = struct{}{}
	c.mu.Unlock()

	params := []any{worker, jobID, en2, ntime, nonce}
	if version != nil {
		params = append(params, fmt.Sprintf("%08x", *version))
	}
	if err := conn.Write(stratum.Request(id, "mining.submit", params...)); err != nil {
		c.mu.Lock()
		_, stillPending := c.pending[id]
		delete(c.pending, id)
		c.mu.Unlock()
		if stillPending {
			return 0, err
		}
		// A concurrent disconnect already claimed this id and reported it via
		// OnSubmitResult; return the id so the result is delivered exactly once.
	}
	return id, nil
}

func parseNotify(p []json.RawMessage) (work.Job, error) {
	var j work.Job
	if len(p) < 9 {
		return j, fmt.Errorf("want 9 params, got %d", len(p))
	}
	var ver string
	strs := []*string{&j.UpstreamID, &j.PrevHash, &j.Coinb1, &j.Coinb2}
	for i, dst := range strs {
		if err := json.Unmarshal(p[i], dst); err != nil {
			return j, fmt.Errorf("param %d: %w", i, err)
		}
	}
	if err := json.Unmarshal(p[4], &j.Branches); err != nil {
		return j, fmt.Errorf("branches: %w", err)
	}
	for i, dst := range []*string{&ver, &j.NBits, &j.NTime} {
		if err := json.Unmarshal(p[5+i], dst); err != nil {
			return j, fmt.Errorf("param %d: %w", 5+i, err)
		}
	}
	if err := json.Unmarshal(p[8], &j.Clean); err != nil {
		return j, fmt.Errorf("clean_jobs: %w", err)
	}
	v, err := parseHex32(ver)
	if err != nil {
		return j, fmt.Errorf("version: %w", err)
	}
	j.Version = v
	if j.Branches == nil {
		j.Branches = []string{}
	}
	return j, nil
}

func parseHex32(s string) (uint32, error) {
	if s == "" || len(s) > 8 {
		return 0, fmt.Errorf("bad hex32 %q", s)
	}
	v, err := strconv.ParseUint(s, 16, 32)
	return uint32(v), err
}

func parseID(raw json.RawMessage) (uint64, bool) {
	var id uint64
	if err := json.Unmarshal(raw, &id); err == nil {
		return id, true
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if v, err := strconv.ParseUint(s, 10, 64); err == nil {
			return v, true
		}
	}
	return 0, false
}

// rpcErr returns the error message from a Stratum error field, or "" when none.
func rpcErr(m *stratum.Message) string {
	if len(m.Error) == 0 || string(m.Error) == "null" {
		return ""
	}
	var arr []any
	if json.Unmarshal(m.Error, &arr) == nil {
		if len(arr) > 1 {
			if s, ok := arr[1].(string); ok && s != "" {
				return s
			}
		}
		return "error"
	}
	var obj map[string]any
	if json.Unmarshal(m.Error, &obj) == nil {
		if s, ok := obj["message"].(string); ok && s != "" {
			return s
		}
	}
	return "error"
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
