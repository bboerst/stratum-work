// stratum-work mempool recorder (stratum-work#180, slice 2). Follows a Bitcoin Core node's mempool over ZMQ
// (`sequence` + `rawtx`) and records every transaction it accepts, with first-seen time and how it left (mined,
// replaced, conflict, reorg, expired, evicted, unknown), in Postgres/TimescaleDB (mempool_txs). Also records block
// connects/disconnects and, per block, the transactions that were never in our mempool (mempool_offmempool).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

var version = "dev" // set with -ldflags "-X main.version=..."

type Config struct {
	RPCHost, RPCPort, RPCUser, RPCScheme, RPCCA string
	RPCPassword                                 string // env BITCOIN_RPC_PASSWORD only
	RPCTimeout                                  time.Duration
	ZMQSequence, ZMQRawTx                       string
	PGHost, PGPort, PGDatabase, PGUser          string
	PGSSLMode                                   string
	PGPassword                                  string // env PG_PASSWORD only
	StoreRaw                                    bool
	Expiry                                      time.Duration
	HTTPPort                                    int
	ReadyMaxSilence                             time.Duration
	ReconcileEvery                              time.Duration
	ReconcileTol                                int
	ResyncMaxBlocks                             int
	EnrichBatch                                 int
	EnrichMinInterval                           time.Duration
	QueueSize                                   int
	OffMempoolLookback                          time.Duration
	LogLevel                                    string
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envFloat(k string, def float64) float64 {
	if v := os.Getenv(k); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func envBool(k string) bool {
	b, _ := strconv.ParseBool(os.Getenv(k))
	return b
}

func secs(f float64) time.Duration { return time.Duration(f * float64(time.Second)) }

// parseConfig: flags win, env vars give the defaults. Passwords come only from the environment; passing one as a
// flag is an error (it would show in the process list).
func parseConfig(args []string, stderr io.Writer) (*Config, error) {
	c := &Config{}
	fs := flag.NewFlagSet("mempool-recorder", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var rpcPassFlag, pgPassFlag string
	var rpcTimeout, expiryH, silenceMin, reconcileS, enrichMs, lookbackD float64
	fs.StringVar(&c.RPCHost, "bitcoin-rpc-host", envOr("BITCOIN_RPC_HOST", "localhost"), "Bitcoin RPC host (env BITCOIN_RPC_HOST)")
	fs.StringVar(&c.RPCPort, "bitcoin-rpc-port", envOr("BITCOIN_RPC_PORT", "8332"), "Bitcoin RPC port (env BITCOIN_RPC_PORT)")
	fs.StringVar(&c.RPCUser, "bitcoin-rpc-user", os.Getenv("BITCOIN_RPC_USER"), "Bitcoin RPC user (env BITCOIN_RPC_USER)")
	fs.StringVar(&rpcPassFlag, "bitcoin-rpc-password", "", "not accepted: set env BITCOIN_RPC_PASSWORD")
	fs.StringVar(&c.RPCScheme, "bitcoin-rpc-scheme", envOr("BITCOIN_RPC_SCHEME", "http"), "http or https (env BITCOIN_RPC_SCHEME)")
	fs.StringVar(&c.RPCCA, "bitcoin-rpc-ca-file", os.Getenv("BITCOIN_RPC_CA_FILE"), "PEM CA bundle for an https RPC endpoint (env BITCOIN_RPC_CA_FILE)")
	fs.Float64Var(&rpcTimeout, "bitcoin-rpc-timeout", envFloat("BITCOIN_RPC_TIMEOUT", 30), "seconds per RPC call or batch (env BITCOIN_RPC_TIMEOUT); the mempool snapshot gets max(5 min, 20x)")
	fs.StringVar(&c.ZMQSequence, "bitcoin-zmq-sequence", envOr("BITCOIN_ZMQ_SEQUENCE", "tcp://localhost:28334"), "node's -zmqpubsequence endpoint (env BITCOIN_ZMQ_SEQUENCE)")
	fs.StringVar(&c.ZMQRawTx, "bitcoin-zmq-rawtx", envOr("BITCOIN_ZMQ_RAWTX", "tcp://localhost:28335"), "node's -zmqpubrawtx endpoint (env BITCOIN_ZMQ_RAWTX)")
	fs.StringVar(&c.PGHost, "pg-host", os.Getenv("PG_HOST"), "Postgres host (env PG_HOST, required)")
	fs.StringVar(&c.PGPort, "pg-port", envOr("PG_PORT", "5432"), "Postgres port (env PG_PORT)")
	fs.StringVar(&c.PGDatabase, "pg-database", envOr("PG_DATABASE", "stratum"), "Postgres database (env PG_DATABASE)")
	fs.StringVar(&c.PGUser, "pg-user", os.Getenv("PG_USER"), "Postgres user, granted stratum_mempool (env PG_USER, required)")
	fs.StringVar(&pgPassFlag, "pg-password", "", "not accepted: set env PG_PASSWORD")
	fs.StringVar(&c.PGSSLMode, "pg-sslmode", envOr("PG_SSLMODE", "prefer"), "libpq sslmode (env PG_SSLMODE)")
	fs.BoolVar(&c.StoreRaw, "store-raw", envBool("MEMPOOL_STORE_RAW"), "also store raw transactions in mempool_tx_raw (~300 MB/day on mainnet; 14-day retention) (env MEMPOOL_STORE_RAW)")
	fs.Float64Var(&expiryH, "mempool-expiry-hours", envFloat("MEMPOOL_EXPIRY_HOURS", 336), "the node's -mempoolexpiry, to tell expiry from eviction (env MEMPOOL_EXPIRY_HOURS)")
	fs.IntVar(&c.HTTPPort, "http-port", envInt("MEMPOOL_HTTP_PORT", 0), "port for /livez, /readyz and /metrics; 0 disables (env MEMPOOL_HTTP_PORT)")
	fs.Float64Var(&silenceMin, "ready-max-silence", envFloat("MEMPOOL_READY_MAX_SILENCE", 10), "/readyz fails when no sequence event arrived for this many minutes; 0 = never (env MEMPOOL_READY_MAX_SILENCE)")
	fs.Float64Var(&reconcileS, "reconcile-interval", envFloat("MEMPOOL_RECONCILE_INTERVAL", 30), "seconds between comparisons of the tracked set with getmempoolinfo (env MEMPOOL_RECONCILE_INTERVAL)")
	fs.IntVar(&c.ReconcileTol, "reconcile-tolerance", envInt("MEMPOOL_RECONCILE_TOLERANCE", 25), "tracked vs node size difference tolerated; 3 checks in a row above it trigger a resync (env MEMPOOL_RECONCILE_TOLERANCE)")
	fs.IntVar(&c.ResyncMaxBlocks, "resync-max-blocks", envInt("MEMPOOL_RESYNC_MAX_BLOCKS", 144), "blocks scanned at a resync to find transactions mined while not following (env MEMPOOL_RESYNC_MAX_BLOCKS)")
	fs.IntVar(&c.EnrichBatch, "enrich-batch", envInt("MEMPOOL_ENRICH_BATCH", 500), "getmempoolentry calls per batch request (env MEMPOOL_ENRICH_BATCH)")
	fs.Float64Var(&enrichMs, "enrich-min-interval", envFloat("MEMPOOL_ENRICH_MIN_INTERVAL", 200), "milliseconds between enrichment batch requests (rate limit) (env MEMPOOL_ENRICH_MIN_INTERVAL)")
	fs.IntVar(&c.QueueSize, "queue-size", envInt("MEMPOOL_QUEUE_SIZE", 200_000), "operations buffered per pipeline queue while the node or database is slow; the oldest are dropped beyond this (env MEMPOOL_QUEUE_SIZE)")
	fs.Float64Var(&lookbackD, "offmempool-lookback-days", envFloat("MEMPOOL_OFFMEMPOOL_LOOKBACK_DAYS", 15), "a block transaction with a mempool_txs row this recent is not off-mempool; also how far back open rows are reloaded at startup (env MEMPOOL_OFFMEMPOOL_LOOKBACK_DAYS)")
	fs.StringVar(&c.LogLevel, "log-level", envOr("LOG_LEVEL", "INFO"), "DEBUG, INFO, WARNING or ERROR (env LOG_LEVEL)")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	for flagName, env := range map[string]string{"bitcoin-rpc-password": "BITCOIN_RPC_PASSWORD", "pg-password": "PG_PASSWORD"} {
		if set[flagName] {
			return nil, fmt.Errorf("--%s is not accepted on the command line (it would be visible in the process list); set the %s environment variable instead", flagName, env)
		}
	}
	if c.PGHost == "" || c.PGUser == "" {
		return nil, errors.New("--pg-host and --pg-user (or PG_HOST and PG_USER) are required")
	}
	if c.RPCScheme != "http" && c.RPCScheme != "https" {
		return nil, fmt.Errorf("invalid --bitcoin-rpc-scheme %q (http or https)", c.RPCScheme)
	}
	switch c.LogLevel {
	case "DEBUG", "INFO", "WARNING", "ERROR":
	default:
		return nil, fmt.Errorf("invalid --log-level %q (DEBUG, INFO, WARNING, ERROR)", c.LogLevel)
	}
	if rpcTimeout <= 0 || expiryH <= 0 || reconcileS <= 0 || c.EnrichBatch <= 0 || c.QueueSize <= 0 || lookbackD <= 0 {
		return nil, errors.New("timeouts, intervals, batch and queue sizes must be positive")
	}
	c.RPCTimeout, c.Expiry = secs(rpcTimeout), secs(expiryH*3600)
	c.ReadyMaxSilence, c.ReconcileEvery = secs(silenceMin*60), secs(reconcileS)
	c.EnrichMinInterval, c.OffMempoolLookback = secs(enrichMs/1000), secs(lookbackD*86400)
	c.RPCPassword = os.Getenv("BITCOIN_RPC_PASSWORD")
	c.PGPassword = os.Getenv("PG_PASSWORD")
	return c, nil
}

func main() {
	cfg, err := parseConfig(os.Args[1:], os.Stderr)
	if err != nil {
		if !errors.Is(err, flag.ErrHelp) {
			fmt.Fprintln(os.Stderr, "error:", err)
		}
		os.Exit(2)
	}
	os.Exit(run(cfg))
}

func run(cfg *Config) int {
	lvl := map[string]slog.Level{"DEBUG": slog.LevelDebug, "INFO": slog.LevelInfo, "WARNING": slog.LevelWarn,
		"ERROR": slog.LevelError}[cfg.LogLevel]
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
	log.Info("starting", "version", version, "store_raw", cfg.StoreRaw)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	rpc, err := NewRPC(cfg.RPCScheme, cfg.RPCHost, cfg.RPCPort, cfg.RPCUser, cfg.RPCPassword, cfg.RPCCA, cfg.RPCTimeout)
	if err != nil {
		log.Error("invalid RPC settings", "err", err)
		return 2
	}
	pgcfg := PGConfig{Host: cfg.PGHost, Port: cfg.PGPort, Database: cfg.PGDatabase, User: cfg.PGUser,
		Password: cfg.PGPassword, SSLMode: cfg.PGSSLMode, ConnectTimeout: 10 * time.Second,
		OffMempoolLookback: cfg.OffMempoolLookback}
	m := &Metrics{}
	pipe := NewPipeline(PipelineConfig{EnrichQueue: cfg.QueueSize, WriteQueue: cfg.QueueSize, EnrichBatch: cfg.EnrichBatch,
		WriteBatch: 5000, Linger: 200 * time.Millisecond, EnrichMinInterval: cfg.EnrichMinInterval, KeepRaw: cfg.StoreRaw},
		rpc, NewPGStore(pgcfg), log).Start()

	feeds := NewFeeds(cfg.ZMQSequence, cfg.ZMQRawTx, cfg.StoreRaw, m, log)
	rc := DefaultRecorderConfig()
	rc.KeepRaw, rc.Expiry, rc.ReconcileEvery, rc.ReconcileTol = cfg.StoreRaw, cfg.Expiry, cfg.ReconcileEvery, cfg.ReconcileTol
	rc.ResyncMaxBlocks, rc.OpenLookback = cfg.ResyncMaxBlocks, cfg.OffMempoolLookback
	rec := NewRecorder(rc, rpc, NewPGStore(pgcfg), pipe.Submit, feeds.SeqCh, feeds.RawCh, m, log)

	if cfg.HTTPPort > 0 {
		hs := &HealthServer{M: m, Rec: rec, Pipe: pipe, RPC: rpc, MaxSilence: cfg.ReadyMaxSilence,
			MaxRPCAge: 3*cfg.ReconcileEvery + time.Minute, ZMQUp: feeds.Up, ZMQMessages: feeds.Messages, log: log,
			Labels: map[string]string{"version": version}}
		if err := hs.Serve(ctx, fmt.Sprintf(":%d", cfg.HTTPPort)); err != nil {
			log.Error("health server failed to start", "err", err)
			return 1
		}
	}
	// Subscribe before the first snapshot (the race-free sync needs the events from before it buffered).
	feeds.Start(ctx)
	if err := feeds.WaitUp(ctx, time.Second); err != nil {
		return 0 // only on shutdown
	}
	go func() {
		t := time.NewTicker(10 * time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				e, w := pipe.Queued()
				log.Info("stats", "tracked", rec.Tracked(), "node_txs", m.NodeTxs.Load(), "enrich_queue", e, "write_queue", w,
					"pipeline", fmtStats(pipe.Stats(), pipeStatKeys))
			}
		}
	}()
	rec.Run(ctx)
	log.Info("shutting down: flushing the write queue")
	rec.finalize()
	pipe.Close(10 * time.Second)
	return 0
}
