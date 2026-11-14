package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Port of collector/pgsink.py: route each document to `templates` or `templates_other` (route), convert it
// losslessly (toRow), and write from a background goroutine with a bounded drop-oldest queue, so collection never
// waits on the database and a database outage never stalls or crashes the collector.

type PGConfig struct {
	Host, Port, Database, User, Password, SSLMode, Site, Replica string
	ConnectTimeout                                               time.Duration
}

// pgConn is what the sink needs from a database connection (a fake in tests).
type pgConn interface {
	UpsertSource(ctx context.Context, name, site, replica, stratumURL string) (int16, error)
	WriteBatch(ctx context.Context, btc, other [][]any) error
	Close()
}

type PostgresSink struct {
	cfg           PGConfig
	sourceName    string
	stratumURL    string
	tip           func() (int64, bool)
	maxQueue      int
	batchSize     int
	statsInterval time.Duration
	connect       func(ctx context.Context, cfg PGConfig) (pgConn, error)
	log           *slog.Logger

	mu    sync.Mutex
	cond  *sync.Cond
	queue []*Document
	stop  bool
	stats map[string]int64
	done  chan struct{}

	conn     pgConn
	sourceID int16
}

var pgStatKeys = []string{"submitted", "written", "written_other", "dropped_queue_full", "dropped_invalid", "db_errors"}

func NewPostgresSink(cfg PGConfig, sourceName, stratumURL string, tip func() (int64, bool), log *slog.Logger) *PostgresSink {
	s := &PostgresSink{cfg: cfg, sourceName: sourceName, stratumURL: stratumURL, tip: tip, maxQueue: 50_000,
		batchSize: 500, statsInterval: 10 * time.Minute, connect: pgxConnect, log: log, stats: map[string]int64{},
		done: make(chan struct{})}
	for _, k := range pgStatKeys {
		s.stats[k] = 0
	}
	s.cond = sync.NewCond(&s.mu)
	return s
}

func (s *PostgresSink) Start() *PostgresSink {
	go s.run()
	return s
}

// Submit queues a document. Never blocks on I/O; drops (and counts) the oldest when the queue is full.
func (s *PostgresSink) Submit(d *Document) {
	s.mu.Lock()
	if len(s.queue) >= s.maxQueue {
		s.queue[0] = nil
		s.queue = s.queue[1:]
		s.stats["dropped_queue_full"]++
	}
	s.queue = append(s.queue, d)
	s.stats["submitted"]++
	s.mu.Unlock()
	s.cond.Signal()
}

func (s *PostgresSink) Queued() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.queue)
}

func (s *PostgresSink) Stats() map[string]int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]int64, len(s.stats))
	for k, v := range s.stats {
		out[k] = v
	}
	return out
}

func (s *PostgresSink) count(k string, n int) {
	s.mu.Lock()
	s.stats[k] += int64(n)
	s.mu.Unlock()
}

// Close stops the worker after a best-effort flush of what's queued (waits at most timeout).
func (s *PostgresSink) Close(timeout time.Duration) {
	s.mu.Lock()
	s.stop = true
	s.mu.Unlock()
	s.cond.Broadcast()
	select {
	case <-s.done:
	case <-time.After(timeout):
	}
}

func (s *PostgresSink) takeBatch() []*Document {
	s.mu.Lock()
	defer s.mu.Unlock()
	for len(s.queue) == 0 && !s.stop {
		s.cond.Wait()
	}
	n := min(s.batchSize, len(s.queue))
	b := append([]*Document(nil), s.queue[:n]...)
	clear(s.queue[:n])
	s.queue = s.queue[n:]
	return b
}

// requeueFront puts a failed batch back at the front, keeping the newest entries if the queue can't hold all.
func (s *PostgresSink) requeueFront(b []*Document) {
	s.mu.Lock()
	defer s.mu.Unlock()
	room := s.maxQueue - len(s.queue)
	if room < len(b) {
		s.stats["dropped_queue_full"] += int64(len(b) - max(room, 0))
		b = b[len(b)-max(room, 0):]
	}
	s.queue = append(append(make([]*Document, 0, len(b)+len(s.queue)), b...), s.queue...)
}

func (s *PostgresSink) disconnect() {
	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
	}
}

func (s *PostgresSink) ensureConnected(ctx context.Context) error {
	if s.conn != nil {
		return nil
	}
	conn, err := s.connect(ctx, s.cfg)
	if err != nil {
		return err
	}
	id, err := conn.UpsertSource(ctx, s.sourceName, s.cfg.Site, s.cfg.Replica, s.stratumURL)
	if err != nil {
		conn.Close()
		return err
	}
	s.conn, s.sourceID = conn, id
	s.log.Info("postgres sink connected", "host", s.cfg.Host, "port", s.cfg.Port, "db", s.cfg.Database,
		"user", s.cfg.User, "source", s.sourceName, "site", s.cfg.Site, "replica", s.cfg.Replica, "source_id", id)
	return nil
}

func (s *PostgresSink) write(ctx context.Context, batch []*Document) error {
	if err := s.ensureConnected(ctx); err != nil {
		return err
	}
	tip, tipOK := s.tip()
	var btc, other [][]any
	for _, d := range batch {
		row, err := toRow(d, s.sourceID)
		if err != nil {
			s.count("dropped_invalid", 1)
			s.log.Warn("postgres sink: dropping malformed template", "job_id", truncate(pyStrOf(d.Params[pJobID]), 64),
				"err", err)
			continue
		}
		r := route(int64(row.Height), d.ChainFamily, tip, tipOK)
		if r == routeBTC {
			btc = append(btc, row.values())
		} else {
			other = append(other, append(row.values(), r.Chain, r.Reason))
		}
	}
	if err := s.conn.WriteBatch(ctx, btc, other); err != nil {
		return err
	}
	s.count("written", len(btc))
	s.count("written_other", len(other))
	return nil
}

func (s *PostgresSink) logStats() {
	s.log.Info("postgres sink stats", "stats", fmtStats(s.Stats(), pgStatKeys), "queued", s.Queued())
}

func fmtStats(m map[string]int64, keys []string) string {
	out := "{"
	for i, k := range keys {
		if i > 0 {
			out += ", "
		}
		out += "'" + k + "': " + strconv.FormatInt(m[k], 10)
	}
	return out + "}"
}

func (s *PostgresSink) run() {
	defer close(s.done)
	defer s.disconnect()
	ctx := context.Background()
	backoff := time.Second
	lastStats := time.Now()
	for {
		if time.Since(lastStats) >= s.statsInterval {
			lastStats = time.Now()
			s.logStats()
		}
		batch := s.takeBatch()
		if len(batch) == 0 {
			return // stopped and drained
		}
		wctx, cancel := context.WithTimeout(ctx, 60*time.Second)
		err := s.write(wctx, batch)
		cancel()
		if err == nil {
			backoff = time.Second
			continue
		}
		s.count("db_errors", 1)
		s.log.Error("postgres sink write failed, retrying", "queued", len(batch)+s.Queued(), "in", backoff, "err", err)
		s.disconnect()
		s.requeueFront(batch)
		s.mu.Lock()
		stopping := s.stop
		s.mu.Unlock()
		if stopping {
			return
		}
		time.Sleep(backoff)
		backoff = min(backoff*2, 60*time.Second)
	}
}

// ── pgx implementation ───────────────────────────────────────────────────────────────────────────────────────────

type pgxConn struct{ c *pgx.Conn }

func pgxConnect(ctx context.Context, cfg PGConfig) (pgConn, error) {
	// Keyword DSN without the password (set on the config), so a connection error can never echo it. sslmode has
	// libpq semantics (prefer / require / verify-full / disable), like the Python sink.
	if _, err := strconv.Atoi(cfg.Port); err != nil {
		return nil, fmt.Errorf("invalid PG_PORT %q", cfg.Port)
	}
	cc, err := pgx.ParseConfig(fmt.Sprintf("host=%s port=%s dbname=%s user=%s sslmode=%s",
		dsnQuote(cfg.Host), cfg.Port, dsnQuote(cfg.Database), dsnQuote(cfg.User), dsnQuote(cfg.SSLMode)))
	if err != nil {
		return nil, errors.New("invalid Postgres settings") // never echo the DSN
	}
	cc.Password = cfg.Password
	cc.RuntimeParams["application_name"] = "stratum-work-collector-go"
	cc.ConnectTimeout = cfg.ConnectTimeout
	conn, err := pgx.ConnectConfig(ctx, cc)
	if err != nil {
		return nil, err
	}
	// The enum columns (chain, latency_method) need their types registered for binary COPY.
	for _, t := range []string{"chain", "latency_method"} {
		typ, err := conn.LoadType(ctx, t)
		if err != nil {
			_ = conn.Close(ctx)
			return nil, fmt.Errorf("loading type %s: %w", t, err)
		}
		conn.TypeMap().RegisterType(typ)
	}
	return &pgxConn{conn}, nil
}

func dsnQuote(s string) string {
	q := "'"
	for _, r := range s {
		if r == '\'' || r == '\\' {
			q += `\`
		}
		q += string(r)
	}
	return q + "'"
}

func (p *pgxConn) UpsertSource(ctx context.Context, name, site, replica, stratumURL string) (int16, error) {
	var id int16
	err := p.c.QueryRow(ctx, `INSERT INTO sources (name, site, replica, stratum_url) VALUES ($1, $2, $3, $4)
		ON CONFLICT (name, site, replica) DO UPDATE SET stratum_url = EXCLUDED.stratum_url RETURNING id`,
		name, site, replica, stratumURL).Scan(&id)
	return id, err
}

func (p *pgxConn) WriteBatch(ctx context.Context, btc, other [][]any) error {
	tx, err := p.c.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	if len(btc) > 0 {
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"templates"}, pgColumns, pgx.CopyFromRows(btc)); err != nil {
			return err
		}
	}
	if len(other) > 0 {
		cols := append(append([]string(nil), pgColumns...), "chain", "reason")
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"templates_other"}, cols, pgx.CopyFromRows(other)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (p *pgxConn) Close() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = p.c.Close(ctx)
}
