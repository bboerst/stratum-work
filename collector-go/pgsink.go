package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Port of collector/pgsink.py: route a template to `templates` or `templates_other`, convert it losslessly
// (to_row), and write it from a background goroutine with a bounded drop-oldest queue, so collection never waits on
// the database and a database outage never stalls or crashes the collector.

const (
	tipBehind = 6
	tipAhead  = 2
)

var columns = []string{"received_at", "source_id", "height", "job_id", "prev_hash", "coinbase1", "coinbase2",
	"merkle_branches", "version", "nbits", "ntime", "clean_jobs", "extranonce1", "extranonce2_length", "latency_ms",
	"latency_method"}

// Template is the collector's document (Python create_notification_document), with params kept as received.
type Template struct {
	TsNs          int64
	Height        int64 // 0 = unparseable (Python sentinel)
	JobID         string
	PrevHash      string
	Coinbase1     string
	Coinbase2     string
	Merkle        []string
	Version       string
	Nbits         string
	Ntime         string
	CleanJobs     bool
	Extranonce1   string
	HasExtranonce bool // false if subscribe gave no extranonce1 (Python: None -> to_row fails -> dropped_invalid)
	Extranonce2   int
	ChainFamily   string // "", "bch", "unknown"
	LatencyMs     *float32
	LatencyMethod *string
}

type route struct{ table, chain, reason string }

func routeOf(height int64, chainFamily string, tip int64, tipOK bool) route {
	switch {
	case height <= 0:
		return route{"templates_other", "unknown", "height_parse_failed"}
	case chainFamily == "bch":
		return route{"templates_other", "bch", "bch"}
	case chainFamily != "":
		return route{"templates_other", "unknown", "unknown_chain"}
	case tipOK && !(tip-tipBehind <= height && height <= tip+tipAhead):
		return route{"templates_other", "unknown", "height_implausible"}
	}
	return route{table: "templates"}
}

// u32 mirrors Python _u32 = int(value, 16) bounded to 32 bits (int() also accepts a 0x prefix and surrounding space).
func u32(s string) (int64, error) {
	t := strings.TrimSpace(s)
	t = strings.TrimPrefix(strings.TrimPrefix(t, "0x"), "0X")
	v, err := strconv.ParseUint(t, 16, 32)
	if err != nil {
		return 0, fmt.Errorf("not a 32-bit value: %q", s)
	}
	return int64(v), nil
}

func toRow(t Template, sourceID int16) ([]any, error) {
	if !t.HasExtranonce {
		return nil, errors.New("no extranonce1 from subscribe")
	}
	prev, e1 := hex.DecodeString(t.PrevHash)
	cb1, e2 := hex.DecodeString(t.Coinbase1)
	cb2, e3 := hex.DecodeString(t.Coinbase2)
	en1, e4 := hex.DecodeString(t.Extranonce1)
	if err := errors.Join(e1, e2, e3, e4); err != nil {
		return nil, err
	}
	var branches []byte
	for _, b := range t.Merkle {
		d, err := hex.DecodeString(b)
		if err != nil {
			return nil, err
		}
		branches = append(branches, d...)
	}
	if branches == nil {
		branches = []byte{}
	}
	ver, err := u32(t.Version)
	if err != nil {
		return nil, err
	}
	nbits, err := u32(t.Nbits)
	if err != nil {
		return nil, err
	}
	ntime, err := u32(t.Ntime)
	if err != nil {
		return nil, err
	}
	receivedAt := time.UnixMicro(t.TsNs / 1000).UTC() // µs precision, like Python (ns // 1000)
	var lm any
	if t.LatencyMethod != nil && (*t.LatencyMethod == "tcp" || *t.LatencyMethod == "app") {
		lm = *t.LatencyMethod
	}
	var lms any
	if t.LatencyMs != nil {
		lms = *t.LatencyMs
	}
	return []any{receivedAt, sourceID, int32(t.Height), t.JobID, prev, cb1, cb2, branches, ver, nbits, ntime,
		t.CleanJobs, en1, int16(t.Extranonce2), lms, lm}, nil
}

type PGConfig struct {
	Host, Port, Database, User, Password, SSLMode, Site string
}

type PostgresSink struct {
	cfg        PGConfig
	sourceName string
	stratumURL string
	tip        *TipState
	maxQueue   int
	batchSize  int
	log        *slog.Logger

	mu    sync.Mutex
	cond  *sync.Cond
	queue []Template
	stats map[string]int
}

func NewPostgresSink(cfg PGConfig, sourceName, stratumURL string, tip *TipState, log *slog.Logger) *PostgresSink {
	s := &PostgresSink{cfg: cfg, sourceName: sourceName, stratumURL: stratumURL, tip: tip, maxQueue: 50_000,
		batchSize: 500, log: log, stats: map[string]int{}}
	s.cond = sync.NewCond(&s.mu)
	return s
}

// Submit queues a template. Never blocks; drops the oldest when full.
func (s *PostgresSink) Submit(t Template) {
	s.mu.Lock()
	if len(s.queue) >= s.maxQueue {
		s.queue = s.queue[1:]
		s.stats["dropped_queue_full"]++
	}
	s.queue = append(s.queue, t)
	s.stats["submitted"]++
	s.mu.Unlock()
	s.cond.Signal()
}

func (s *PostgresSink) take() []Template {
	s.mu.Lock()
	defer s.mu.Unlock()
	for len(s.queue) == 0 {
		s.cond.Wait()
	}
	n := min(s.batchSize, len(s.queue))
	b := append([]Template(nil), s.queue[:n]...)
	s.queue = s.queue[n:]
	return b
}

func (s *PostgresSink) requeue(b []Template) {
	s.mu.Lock()
	room := s.maxQueue - len(s.queue)
	if room < len(b) {
		s.stats["dropped_queue_full"] += len(b) - room
		b = b[len(b)-room:]
	}
	s.queue = append(append([]Template(nil), b...), s.queue...)
	s.mu.Unlock()
}

func (s *PostgresSink) connect(ctx context.Context) (*pgx.Conn, int16, error) {
	// Keyword DSN without the password (set separately), so a connection error can never echo it. sslmode follows
	// PG_SSLMODE like the Python sink (libpq semantics: prefer / require / verify-full / disable).
	if _, err := strconv.Atoi(s.cfg.Port); err != nil {
		return nil, 0, fmt.Errorf("invalid PG_PORT %q", s.cfg.Port)
	}
	dsn := fmt.Sprintf("host=%s port=%s dbname=%s user=%s sslmode=%s", s.cfg.Host, s.cfg.Port, s.cfg.Database,
		s.cfg.User, s.cfg.SSLMode)
	cc, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, 0, err
	}
	cc.Password = s.cfg.Password
	cc.RuntimeParams["application_name"] = "stratum-work-collector-go"
	cc.ConnectTimeout = 10 * time.Second
	conn, err := pgx.ConnectConfig(ctx, cc)
	if err != nil {
		return nil, 0, err
	}
	var id int16
	err = conn.QueryRow(ctx, `INSERT INTO sources (name, site, stratum_url) VALUES ($1, $2, $3)
		ON CONFLICT (name, site) DO UPDATE SET stratum_url = EXCLUDED.stratum_url RETURNING id`,
		s.sourceName, s.cfg.Site, s.stratumURL).Scan(&id)
	if err != nil {
		conn.Close(ctx)
		return nil, 0, err
	}
	s.log.Info("postgres sink connected", "host", s.cfg.Host, "db", s.cfg.Database, "source", s.sourceName,
		"site", s.cfg.Site, "source_id", id)
	return conn, id, nil
}

func (s *PostgresSink) write(ctx context.Context, conn *pgx.Conn, sourceID int16, batch []Template) error {
	tip, tipOK := s.tip.Current()
	var btc, other [][]any
	for _, t := range batch {
		row, err := toRow(t, sourceID)
		if err != nil {
			s.count("dropped_invalid", 1)
			s.log.Warn("dropping malformed template", "job_id", t.JobID, "err", err)
			continue
		}
		r := routeOf(t.Height, t.ChainFamily, tip, tipOK)
		if r.table == "templates" {
			btc = append(btc, row)
		} else {
			other = append(other, append(row, r.chain, r.reason))
		}
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if len(btc) > 0 {
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"templates"}, columns, pgx.CopyFromRows(btc)); err != nil {
			return err
		}
	}
	if len(other) > 0 {
		cols := append(append([]string(nil), columns...), "chain", "reason")
		if _, err := tx.CopyFrom(ctx, pgx.Identifier{"templates_other"}, cols, pgx.CopyFromRows(other)); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.count("written", len(btc))
	s.count("written_other", len(other))
	return nil
}

func (s *PostgresSink) count(k string, n int) {
	s.mu.Lock()
	s.stats[k] += n
	s.mu.Unlock()
}

func (s *PostgresSink) Run() {
	ctx := context.Background()
	var conn *pgx.Conn
	var sourceID int16
	backoff := time.Second
	lastStats := time.Now()
	for {
		batch := s.take()
		if time.Since(lastStats) > 10*time.Minute {
			s.mu.Lock()
			b, _ := json.Marshal(s.stats)
			s.mu.Unlock()
			s.log.Info("postgres sink stats", "stats", string(b))
			lastStats = time.Now()
		}
		var err error
		if conn == nil {
			conn, sourceID, err = s.connect(ctx)
		}
		if err == nil {
			err = s.write(ctx, conn, sourceID, batch)
		}
		if err == nil {
			backoff = time.Second
			continue
		}
		s.count("db_errors", 1)
		s.log.Error("postgres sink write failed, retrying", "queued", len(batch), "in", backoff, "err", err)
		if conn != nil {
			conn.Close(ctx)
			conn = nil
		}
		s.requeue(batch)
		time.Sleep(backoff)
		backoff = min(backoff*2, 60*time.Second)
	}
}
