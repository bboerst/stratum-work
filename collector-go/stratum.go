package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Stratum v1 client for one pool: connect, subscribe, authorize, then read mining.notify forever.
// Mirrors the Python Watcher (collector/main.py) where it affects stored data:
//   - receipt timestamp = wall clock when the socket read that completed the line returned (Python: time.time_ns()
//     right after recv); every line completed by the same read shares it
//   - notifications that arrive while waiting for the subscribe/authorize responses are queued and processed after
//   - extranonce1 / extranonce2_length come from the last two elements of the subscribe result

type message struct {
	ID     json.RawMessage   `json:"id"`
	Method string            `json:"method"`
	Params []json.RawMessage `json:"params"`
	Result json.RawMessage   `json:"result"`
	Error  json.RawMessage   `json:"error"`
}

type received struct {
	msg   message
	tsNs  int64
	appNs int64
}

// Receipt time of a line = the moment the bytes that completed it arrived:
//   - kernel receive timestamp (SO_TIMESTAMPNS, rxtime_linux.go) when available: independent of scheduling, GC
//     and how busy the read loop was;
//   - otherwise the wall clock right after Read() returns (what the Python collector records).
//
// Every line completed by the same read shares the timestamp, like Python.
type lineReader struct {
	conn    net.Conn
	rx      *rxConn
	buf     []byte
	lastTs  int64 // kernel if available, else app
	lastApp int64 // app clock after the read returned (for the spike's comparison)
	timeout time.Duration
}

func (r *lineReader) next() ([]byte, int64, error) {
	line, ts, _, err := r.nextBoth()
	return line, ts, err
}

// nextBoth returns the next non-empty line, its receipt timestamp, and the app-clock timestamp of the same read.
func (r *lineReader) nextBoth() ([]byte, int64, int64, error) {
	chunk := make([]byte, 4096)
	for {
		if i := bytes.IndexByte(r.buf, '\n'); i >= 0 {
			line := r.buf[:i]
			r.buf = r.buf[i+1:]
			if len(line) == 0 {
				continue
			}
			out := make([]byte, len(line))
			copy(out, line)
			return out, r.lastTs, r.lastApp, nil
		}
		_ = r.conn.SetReadDeadline(time.Now().Add(r.timeout))
		var n int
		var kts int64
		var err error
		if r.rx != nil {
			n, kts, err = r.rx.read(chunk)
		} else {
			n, err = r.conn.Read(chunk)
		}
		app := time.Now().UnixNano()
		if n > 0 {
			r.buf = append(r.buf, chunk[:n]...)
			r.lastApp = app
			r.lastTs = app
			if kts > 0 {
				r.lastTs = kts
			}
		}
		if err != nil {
			if n > 0 {
				continue // deliver what's complete first
			}
			return nil, 0, 0, err
		}
	}
}

type Client struct {
	URL       string // stratum+tcp://host:port
	UserPass  string
	UserAgent string
	Timeout   time.Duration
	OnNotify  func(params []json.RawMessage, tsNs, appNs int64, extranonce1 string, extranonce2Len int)
	log       *slog.Logger

	mu          sync.Mutex
	nextID      int
	conn        net.Conn
	reader      *lineReader
	pending     []received
	extranonce1 string
	en2Len      int
}

func parseStratumURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	if u.Scheme != "stratum+tcp" {
		return "", fmt.Errorf("unrecognized scheme %s, only 'stratum+tcp' is allowed", u.Scheme)
	}
	if u.Hostname() == "" || u.Port() == "" {
		return "", errors.New("URL needs a host and a port")
	}
	if u.Path != "" {
		return "", fmt.Errorf("URL has a path %s, this is not valid", u.Path)
	}
	return net.JoinHostPort(u.Hostname(), u.Port()), nil
}

func (c *Client) send(method string, params []any) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	id := c.nextID
	b, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	_, err := c.conn.Write(append(b, '\n'))
	return id, err
}

// call sends a request and waits for its response, queueing anything else that arrives meanwhile.
func (c *Client) call(method string, params []any) (message, error) {
	id, err := c.send(method, params)
	if err != nil {
		return message{}, err
	}
	for {
		line, ts, err := c.reader.next()
		if err != nil {
			return message{}, err
		}
		var m message
		if json.Unmarshal(line, &m) != nil {
			continue // garbage line, like Python: skip
		}
		if string(m.ID) == fmt.Sprint(id) {
			return m, nil
		}
		c.pending = append(c.pending, received{m, ts, c.reader.lastApp})
	}
}

func (c *Client) connect() error {
	addr, err := parseStratumURL(c.URL)
	if err != nil {
		return err
	}
	conn, err := net.DialTimeout("tcp", addr, 30*time.Second)
	if err != nil {
		return err
	}
	c.conn = conn
	c.reader = &lineReader{conn: conn, rx: newRxConn(conn), timeout: c.Timeout}
	c.log.Info("connected", "kernel_rx_timestamps", c.reader.rx != nil)
	c.pending = nil
	subParams := []any{}
	if c.UserAgent != "" {
		subParams = []any{c.UserAgent}
	}
	sub, err := c.call("mining.subscribe", subParams)
	if err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	var result []json.RawMessage
	if json.Unmarshal(sub.Result, &result) == nil && len(result) >= 2 {
		var en1 string
		var en2 int
		_ = json.Unmarshal(result[len(result)-2], &en1)
		_ = json.Unmarshal(result[len(result)-1], &en2)
		c.extranonce1, c.en2Len = en1, en2
		c.log.Info("subscribed", "extranonce1", en1, "extranonce2_length", en2)
	} else {
		c.log.Warn("subscribe response missing result", "resp", string(sub.Result))
	}
	user, pass, _ := strings.Cut(c.UserPass, ":")
	auth, err := c.call("mining.authorize", []any{user, pass})
	if err != nil {
		return fmt.Errorf("authorize: %w", err)
	}
	if string(auth.Result) == "true" {
		c.log.Info("authorized")
	} else {
		c.log.Warn("authorization rejected", "resp", string(auth.Result))
	}
	return nil
}

func (c *Client) handle(m message, ts, app int64) {
	switch m.Method {
	case "mining.notify":
		if c.OnNotify != nil && len(m.Params) >= 9 {
			c.OnNotify(m.Params, ts, app, c.extranonce1, c.en2Len)
		}
	case "mining.set_difficulty":
		c.log.Debug("set_difficulty", "params", m.Params)
	}
}

// Run connects and collects until the process stops, reconnecting after every error.
func (c *Client) Run() {
	backoff := 5 * time.Second
	for {
		err := c.connect()
		if err == nil {
			for _, p := range c.pending {
				c.handle(p.msg, p.tsNs, p.appNs)
			}
			c.pending = nil
			for {
				line, ts, app, rerr := c.reader.nextBoth()
				if rerr != nil {
					err = rerr
					break
				}
				var m message
				if json.Unmarshal(line, &m) != nil {
					continue
				}
				c.handle(m, ts, app)
			}
		}
		c.log.Error("connection error, reconnecting", "err", err, "in", backoff)
		if c.conn != nil {
			_ = c.conn.Close()
		}
		time.Sleep(backoff)
	}
}
