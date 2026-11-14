package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Stratum v1 client for one pool (Python: Watcher in collector/main.py).
//
// Receipt timestamps: the time of the read that completed a line (kernel receive timestamp when available, else
// the clock right after the read returned, Python's method). Every line completed by the same read shares it.
//
// The read loop only reads, parses and hands documents off without blocking: latency probes and keep-alives are
// sent from their own goroutine (their responses are matched by id in the read loop), the BCH lookup runs in the
// Classifier, and the sinks take documents through bounded drop-oldest queues.

const maxLineBytes = 4 << 20 // a mining.notify is a few KB; a pool that sends 4 MiB without a newline is broken

type line struct {
	b    []byte
	ts   int64 // receipt time, ns since the epoch (kernel if available)
	app  int64 // clock after the read returned, ns since the epoch
	mono int64 // monotonic ns after the read returned (latency RTTs, like Python's last_recv_monotonic_ns)
}

type lineReader struct {
	conn  net.Conn
	rx    *rxConn
	buf   []byte
	chunk []byte
	last  line // timestamps of the most recent read
}

func newLineReader(c net.Conn) *lineReader {
	return &lineReader{conn: c, rx: newRxConn(c), chunk: make([]byte, 4096)}
}

// next returns the next non-empty line (without the newline). It reads only when no complete line is buffered, so
// a line's timestamps are those of the read that completed it.
func (r *lineReader) next(deadline time.Time) (line, error) {
	for {
		if i := bytes.IndexByte(r.buf, '\n'); i >= 0 {
			b := r.buf[:i]
			r.buf = r.buf[i+1:]
			if len(b) == 0 {
				continue
			}
			l := r.last
			l.b = append([]byte(nil), b...)
			return l, nil
		}
		if len(r.buf) > maxLineBytes {
			return line{}, fmt.Errorf("no newline in %d bytes", len(r.buf))
		}
		if len(r.buf) == 0 {
			r.buf = r.chunk[:0:0] // release the backing array once drained
		}
		_ = r.conn.SetReadDeadline(deadline)
		var n int
		var kts int64
		var err error
		if r.rx != nil {
			n, kts, err = r.rx.read(r.chunk)
		} else {
			n, err = r.conn.Read(r.chunk)
		}
		now := time.Now()
		if n > 0 {
			r.buf = append(r.buf, r.chunk[:n]...)
			r.last = line{ts: now.UnixNano(), app: now.UnixNano(), mono: monoNs()}
			if kts > 0 {
				r.last.ts = kts
			}
		}
		if err != nil {
			if n > 0 {
				continue
			}
			return line{}, err
		}
	}
}

type StratumConfig struct {
	URL              string
	UserPass         string
	UserAgent        *string // nil = omit the identifier
	PoolName         string
	UseProxy         bool
	ProxyHost        string
	ProxyPort        int
	HandshakeTimeout time.Duration // TCP/SOCKS connect and each handshake round trip (#146)
	ReadTimeout      time.Duration // steady-state read timeout (Python: 600 s)
	RetryDelay       time.Duration // between connection attempts (Python: 5 s)
	ProbeInterval    time.Duration // latency probes; 0 disables
	KeepAlive        bool          // re-subscribe every KeepAliveEvery
	KeepAliveEvery   time.Duration
}

type Collector struct {
	cfg     StratumConfig
	host    string
	port    int
	log     *slog.Logger
	tracker *LatencyTracker
	metrics *Metrics
	emit    func(*Document) // non-blocking hand-off (Classifier.Submit)

	sendMu  sync.Mutex
	nextID  int64
	conn    net.Conn // current pool connection, nil between connections (guarded by sendMu)
	lastSub time.Time

	// Read-goroutine state (Python Watcher attributes).
	extranonce1 pyValue
	extranonce2 pyValue
}

func parseStratumURL(raw string) (string, int, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", 0, err
	}
	if u.Scheme != "stratum+tcp" {
		return "", 0, fmt.Errorf("unrecognized scheme %s, only 'stratum+tcp' is allowed", u.Scheme)
	}
	if u.Hostname() == "" {
		return "", 0, errors.New("no hostname provided")
	}
	if u.Port() == "" {
		return "", 0, errors.New("no port provided")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 0 || port > 65535 {
		return "", 0, fmt.Errorf("invalid port %q", u.Port())
	}
	if u.Path != "" {
		return "", 0, fmt.Errorf("URL has a path %s, this is not valid", u.Path)
	}
	return u.Hostname(), port, nil
}

func NewCollector(cfg StratumConfig, log *slog.Logger, m *Metrics, emit func(*Document)) (*Collector, error) {
	host, port, err := parseStratumURL(cfg.URL)
	if err != nil {
		return nil, err
	}
	c := &Collector{cfg: cfg, host: host, port: port, log: log, metrics: m, emit: emit, nextID: 1,
		tracker: NewLatencyTracker(cfg.UseProxy), lastSub: time.Now()}
	c.resetExtranonce()
	return c, nil
}

func (c *Collector) resetExtranonce() {
	c.extranonce1 = pyValue{kind: pyNull}
	c.extranonce2 = pyIntOf(-1)
}

func (c *Collector) subscribeParams() pyValue {
	p := pyValue{kind: pyList, items: []pyValue{}}
	if c.cfg.UserAgent != nil {
		p.items = append(p.items, pyString(*c.cfg.UserAgent))
	}
	return p
}

func (c *Collector) authorizeParams() pyValue {
	p := pyValue{kind: pyList}
	for _, s := range strings.Split(c.cfg.UserPass, ":") { // Python: userpass.split(":")
		p.items = append(p.items, pyString(s))
	}
	return p
}

func (c *Collector) dial(ctx context.Context) (net.Conn, error) {
	if c.cfg.UseProxy {
		proxy := net.JoinHostPort(c.cfg.ProxyHost, strconv.Itoa(c.cfg.ProxyPort))
		return dialSOCKS5(ctx, proxy, c.host, c.port, c.cfg.HandshakeTimeout)
	}
	d := net.Dialer{Timeout: c.cfg.HandshakeTimeout}
	return d.DialContext(ctx, "tcp", net.JoinHostPort(c.host, strconv.Itoa(c.port)))
}

func (c *Collector) setConn(conn net.Conn) {
	c.sendMu.Lock()
	c.conn = conn
	c.sendMu.Unlock()
}

// send writes one JSON-RPC request (the same bytes as Python's json.dumps) and records it for latency matching.
func (c *Collector) send(method string, params pyValue) (int64, error) {
	c.sendMu.Lock()
	conn := c.conn
	if conn == nil {
		c.sendMu.Unlock()
		return 0, errors.New("not connected")
	}
	id := c.nextID
	c.nextID++
	req := pyValue{kind: pyDict, keys: []string{"id", "method", "params"},
		items: []pyValue{pyIntOf(id), pyString(method), params}}
	payload := append(pyDumps(req), '\n')
	c.tracker.RecordSend(id, monoNs())
	_ = conn.SetWriteDeadline(time.Now().Add(c.cfg.HandshakeTimeout))
	_, err := conn.Write(payload)
	c.sendMu.Unlock()
	c.sampleTCPRTT(conn)
	return id, err
}

// sampleTCPRTT: the kernel RTT through a SOCKS proxy only measures the local hop, so it's skipped there.
func (c *Collector) sampleTCPRTT(conn net.Conn) {
	if c.cfg.UseProxy || conn == nil {
		return
	}
	c.tracker.RecordTCPRTTUs(sampleTCPRTTUs(conn))
}

type pendingMsg struct {
	msg pyValue
	l   line
}

// call sends a request and waits (up to the handshake timeout) for the response with its id. Probe responses are
// consumed; everything else is queued for processing after the handshake, with its own receipt timestamp.
func (c *Collector) call(r *lineReader, method string, params pyValue, pending *[]pendingMsg) (pyValue, error) {
	id, err := c.send(method, params)
	if err != nil {
		return pyValue{}, err
	}
	deadline := time.Now().Add(c.cfg.HandshakeTimeout)
	for {
		l, err := r.next(deadline)
		if err != nil {
			if isTimeout(err) {
				return pyValue{}, fmt.Errorf("no response to %s within %s", method, c.cfg.HandshakeTimeout)
			}
			return pyValue{}, err
		}
		msg, err := pyLoads(l.b)
		if err != nil {
			c.log.Debug("skipping undecodable line", "bytes", len(l.b))
			continue
		}
		if idv, ok := msg.get("id"); ok {
			if k, ok := pyIDKey(idv); ok && k == id {
				c.tracker.TryResolve(msg, l.mono)
				return msg, nil
			}
		}
		if c.tracker.TryResolve(msg, l.mono) {
			continue
		}
		c.log.Info("queued server message while awaiting response", "method", method)
		*pending = append(*pending, pendingMsg{msg, l})
	}
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}

// handshake is connect_to_stratum after the TCP connect: subscribe, authorize.
func (c *Collector) handshake(r *lineReader) ([]pendingMsg, error) {
	var pending []pendingMsg
	start := time.Now()
	sub, err := c.call(r, "mining.subscribe", c.subscribeParams(), &pending)
	if err != nil {
		return nil, fmt.Errorf("mining.subscribe: %w", err)
	}
	if e, ok := sub.get("error"); ok && e.truthy() {
		c.log.Warn("subscribe error from pool", "error", string(pyDumps(e)))
	}
	subscribed := false
	if res, ok := sub.get("result"); ok && res.kind != pyNull {
		if res.kind != pyList || len(res.items) < 2 {
			// Python: `extranonce1, extranonce2_length = result[-2:]` raises -> the attempt fails
			return nil, fmt.Errorf("mining.subscribe: unexpected result %s", pyDumps(res))
		}
		c.extranonce1, c.extranonce2 = res.items[len(res.items)-2], res.items[len(res.items)-1]
		subscribed = true
		c.log.Info("subscribed", "extranonce1", string(pyDumps(c.extranonce1)),
			"extranonce2_length", string(pyDumps(c.extranonce2)))
	} else {
		c.log.Warn("subscribe response missing result", "resp", string(pyDumps(sub)))
	}
	auth, err := c.call(r, "mining.authorize", c.authorizeParams(), &pending)
	if err != nil {
		return nil, fmt.Errorf("mining.authorize: %w", err)
	}
	if res, _ := auth.get("result"); res.kind == pyTrue {
		c.log.Info("authorized with the pool")
	} else {
		c.log.Warn("authorization rejected by pool", "resp", string(pyDumps(auth)))
	}
	c.metrics.SetSubscribed(subscribed)
	c.log.Info("handshake done", "took", time.Since(start).Round(time.Millisecond), "queued", len(pending))
	return pending, nil
}

// process is _process_notification.
func (c *Collector) process(msg pyValue, l line) {
	m, _ := msg.get("method")
	if m.kind != pyStr {
		if m.truthy() {
			c.log.Info("server notification", "method", pyStrOf(m))
		}
		return
	}
	switch m.s {
	case "mining.notify":
		params, ok := notifyParams(msg)
		if !ok {
			c.metrics.NotifyMalformed.Add(1)
			c.log.Warn("skipping malformed mining.notify", "msg", truncate(string(pyDumps(msg)), 300))
			return
		}
		d := newDocument(params, c.cfg.PoolName, c.extranonce1, c.extranonce2, l.ts, c.tracker.Estimate())
		d.AppTsNs = l.app
		if params[pCoinbase1].kind != pyStr || d.Height == 0 {
			c.log.Warn("could not parse BIP34 height from coinbase1 (stored as 0)",
				"coinbase1", truncate(pyStrOf(params[pCoinbase1]), 80))
		}
		c.metrics.Notify(l.ts, l.app)
		c.log.Info("mining.notify", "job_id", truncate(pyStrOf(params[pJobID]), 64),
			"prev_hash", truncate(pyStrOf(params[pPrevHash]), 16), "clean", pyStrOf(params[pCleanJobs]),
			"height", d.Height, "app_minus_rx_us", (l.app-l.ts)/1000)
		c.emit(d)
	case "mining.set_difficulty":
		p, _ := msg.get("params")
		var v pyValue
		if p.kind == pyList && len(p.items) > 0 {
			v = p.items[0]
		}
		c.log.Info("mining.set_difficulty", "difficulty", pyStrOf(v))
	default:
		p, _ := msg.get("params")
		c.log.Info("server notification", "method", m.s, "params", truncate(string(pyDumps(p)), 300))
	}
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

// Run collects until ctx is done, reconnecting after every error (Python: get_stratum_work + main loop).
func (c *Collector) Run(ctx context.Context) {
	go c.background(ctx)
	for ctx.Err() == nil {
		err := c.session(ctx)
		c.metrics.SetSubscribed(false)
		if ctx.Err() != nil {
			return
		}
		c.metrics.Reconnects.Add(1)
		c.log.Error("connection error, reconnecting", "err", err, "in", c.cfg.RetryDelay)
		select {
		case <-ctx.Done():
			return
		case <-time.After(c.cfg.RetryDelay):
		}
	}
}

func (c *Collector) session(ctx context.Context) error {
	c.tracker.Reset()
	c.log.Info("connecting", "host", c.host, "port", c.port, "proxy", c.cfg.UseProxy)
	conn, err := c.dial(ctx)
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	defer conn.Close()
	r := newLineReader(conn)
	c.metrics.KernelTimestamps.Store(r.rx != nil)
	c.log.Info("connected", "kernel_rx_timestamps", r.rx != nil)
	c.setConn(conn)
	defer c.setConn(nil)

	pending, err := c.handshake(r)
	if err != nil {
		return err
	}
	for _, p := range pending {
		c.process(p.msg, p.l)
	}
	for {
		l, err := r.next(time.Now().Add(c.cfg.ReadTimeout))
		if err != nil {
			return err
		}
		msg, err := pyLoads(l.b)
		if err != nil {
			c.log.Debug("skipping undecodable line", "bytes", len(l.b), "line", truncate(string(l.b), 200))
			continue
		}
		if c.tracker.TryResolve(msg, l.mono) {
			continue // response to a latency probe or keep-alive
		}
		c.process(msg, l)
	}
}

// background sends latency probes (Python _latency_probe_loop) and keep-alive re-subscribes. Both are plain
// mining.subscribe requests whose responses the read loop consumes by id.
func (c *Collector) background(ctx context.Context) {
	period := time.Second
	if c.cfg.ProbeInterval > 0 && c.cfg.ProbeInterval < 2*period {
		period = c.cfg.ProbeInterval / 2
	}
	tick := time.NewTicker(period)
	defer tick.Stop()
	nextProbe := time.Now().Add(c.cfg.ProbeInterval)
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick.C:
			if c.cfg.ProbeInterval > 0 && !now.Before(nextProbe) {
				nextProbe = now.Add(c.cfg.ProbeInterval)
				if _, err := c.send("mining.subscribe", c.subscribeParams()); err == nil {
					c.tracker.PrunePending(monoNs(), int64(2*c.cfg.ProbeInterval))
				} else {
					c.log.Debug("latency probe send failed", "err", err)
				}
			}
			if c.cfg.KeepAlive && now.Sub(c.lastSub) > c.cfg.KeepAliveEvery {
				c.lastSub = now
				if _, err := c.send("mining.subscribe", c.subscribeParams()); err == nil {
					c.log.Info("keep-alive subscribe sent")
				}
			}
		}
	}
}

// ── miner-relay mode (--enable-stratum-client; Python run_proxy) ────────────────────────────────────────────────

// RunRelay accepts one miner at a time on listenAddr and relays between it and the pool, collecting the pool's
// mining.notify like the direct mode. The miner does the handshake.
func (c *Collector) RunRelay(ctx context.Context, listenAddr string) error {
	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		return err
	}
	context.AfterFunc(ctx, func() { ln.Close() })
	c.log.Info("listening for stratum client connections", "addr", ln.Addr().String())
	for {
		client, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			c.log.Error("accept failed", "err", err)
			time.Sleep(time.Second)
			continue
		}
		c.log.Info("accepted connection", "from", client.RemoteAddr().String())
		if err := c.relaySession(ctx, client); err != nil {
			c.log.Error("relay session ended", "err", err)
		}
		c.metrics.SetSubscribed(false)
	}
}

func (c *Collector) connectWithRetries(ctx context.Context) (net.Conn, error) {
	var err error
	for attempt := 1; attempt <= 5; attempt++ { // Python connect_to_stratum: max_retries = 5
		var conn net.Conn
		if conn, err = c.dial(ctx); err == nil {
			return conn, nil
		}
		c.metrics.Reconnects.Add(1)
		c.log.Error("failed to connect to stratum server", "attempt", attempt, "err", err)
		if attempt < 5 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(c.cfg.RetryDelay):
			}
		}
	}
	return nil, err
}

func (c *Collector) relaySession(ctx context.Context, client net.Conn) error {
	defer client.Close()
	// A new Watcher per miner in Python: fresh tracker and extranonce.
	c.tracker.Reset()
	c.resetExtranonce()
	pool, err := c.connectWithRetries(ctx)
	if err != nil {
		return err
	}
	defer pool.Close()
	c.setConn(pool)
	defer c.setConn(nil)
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	context.AfterFunc(sctx, func() { pool.Close(); client.Close() })

	toClient := make(chan []byte, 4096)
	var wg sync.WaitGroup
	wg.Add(2)
	errs := make(chan error, 3)
	go func() { // pool -> collector (+ queue for the miner); never blocks on the miner
		defer wg.Done()
		defer close(toClient)
		r := newLineReader(pool)
		c.metrics.KernelTimestamps.Store(r.rx != nil)
		for {
			l, err := r.next(time.Now().Add(c.cfg.ReadTimeout))
			if err != nil {
				errs <- fmt.Errorf("pool: %w", err)
				cancel()
				return
			}
			if msg, err := pyLoads(l.b); err == nil && msg.truthy() {
				c.process(msg, l)
				if res, ok := msg.get("result"); ok && res.kind == pyList && len(res.items) >= 2 {
					c.extranonce1, c.extranonce2 = res.items[len(res.items)-2], res.items[len(res.items)-1]
					c.metrics.SetSubscribed(true)
				}
			}
			select {
			case toClient <- append(l.b, '\n'):
			default:
				errs <- errors.New("miner is not reading (relay queue full)")
				cancel()
				return
			}
		}
	}()
	go func() { // queue -> miner
		defer wg.Done()
		for b := range toClient {
			_ = client.SetWriteDeadline(time.Now().Add(c.cfg.HandshakeTimeout))
			if _, err := client.Write(b); err != nil {
				errs <- fmt.Errorf("sending to client: %w", err)
				cancel()
				for range toClient { // drain so the pool reader never blocks
				}
				return
			}
		}
	}()
	// miner -> pool
	cr := newLineReader(client)
	for {
		l, err := cr.next(time.Time{})
		if err != nil {
			errs <- fmt.Errorf("client: %w", err)
			break
		}
		c.sendMu.Lock()
		_ = pool.SetWriteDeadline(time.Now().Add(c.cfg.HandshakeTimeout))
		_, werr := pool.Write(append(l.b, '\n'))
		c.sendMu.Unlock()
		if werr != nil {
			errs <- fmt.Errorf("sending to pool: %w", werr)
			break
		}
		c.sampleTCPRTT(pool)
	}
	cancel()
	wg.Wait()
	return <-errs
}
