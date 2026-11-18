// stratum-work collector, Go port of collector/main.py (stratum-work#148). One process per pool: connects to one
// Stratum endpoint, records every mining.notify with its receipt time, and writes it to Postgres and RabbitMQ.
// MongoDB is not supported (its flags are accepted and ignored, so deployments can switch images).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "dev" // set with -ldflags "-X main.version=..."

type Config struct {
	URL, UserPass, PoolName                                   string
	RabbitHost, RabbitUser, RabbitExchange                    string
	RabbitPort                                                int
	RabbitPassword                                            string // env RABBITMQ_PASSWORD only
	PGHost, PGPort, PGDatabase, PGUser, PGSSLMode, PGPassword string // PGPassword: env PG_PASSWORD only
	PGMaxQueue                                                int
	Site, Replica                                             string
	Node                                                      string
	KeepAlive                                                 bool
	LogLevel                                                  string
	UseProxy                                                  bool
	ProxyHost                                                 string
	ProxyPort                                                 int
	EnableStratumClient                                       bool
	StratumClientPort                                         int
	UserAgent                                                 *string
	ZMQBlock                                                  string
	RPCUser, RPCPassword, RPCHost, RPCPort, RPCScheme, RPCCA  string // RPCPassword: env BITCOIN_RPC_PASSWORD only
	RPCTimeout                                                float64
	Divergence                                                int64
	TipStaleSeconds                                           int
	BCHURL                                                    string
	BCHTimeout                                                float64
	ProbeInterval                                             float64
	HandshakeTimeout, ReadTimeout                             float64
	ReplicaStagger                                            float64
	BurstThreshold                                            int     // templates per second that make a burst second; 0 = off
	BurstGap                                                  float64 // seconds without a burst second that end an episode
	HTTPPort                                                  int
	ReadyMaxNotifyAgeMin                                      float64

	Warnings []string // accepted-but-ignored flags etc., logged once the logger exists
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

// parseConfig accepts the Python collector's flags (long and short forms) with the same defaults and env vars.
// Differences: passwords come only from the environment (RABBITMQ_PASSWORD, PG_PASSWORD, BITCOIN_RPC_PASSWORD) and
// passing one on the command line is an error; the MongoDB flags are accepted and ignored.
func parseConfig(args []string, stderr io.Writer) (*Config, error) {
	c := &Config{}
	fs := flag.NewFlagSet("collector", flag.ContinueOnError)
	fs.SetOutput(stderr)
	str := func(p *string, names []string, def, usage string) {
		for _, n := range names {
			fs.StringVar(p, n, def, usage)
		}
	}
	integer := func(p *int, names []string, def int, usage string) {
		for _, n := range names {
			fs.IntVar(p, n, def, usage)
		}
	}
	boolean := func(p *bool, names []string, usage string) {
		for _, n := range names {
			fs.BoolVar(p, n, false, usage)
		}
	}
	str(&c.URL, []string{"u", "url"}, "", "stratum server URL, e.g. stratum+tcp://pool.example:3333 (required)")
	str(&c.UserPass, []string{"up", "userpass"}, "", "user:password for mining.authorize (required)")
	str(&c.PoolName, []string{"p", "pool-name"}, "", "pool name (default: hostname from --url)")
	str(&c.RabbitHost, []string{"r", "rabbitmq-host"}, envOr("RABBITMQ_HOST", "localhost"), "RabbitMQ host (env RABBITMQ_HOST)")
	integer(&c.RabbitPort, []string{"rpc", "rabbitmq-port"}, envInt("RABBITMQ_PORT", 5672), "RabbitMQ port (env RABBITMQ_PORT)")
	str(&c.RabbitUser, []string{"ru", "rabbitmq-username"}, os.Getenv("RABBITMQ_USERNAME"), "RabbitMQ username (env RABBITMQ_USERNAME; publishing is enabled when this and env RABBITMQ_PASSWORD are set)")
	var rabbitPassFlag, pgPassFlag, rpcPassFlag string
	str(&rabbitPassFlag, []string{"rp", "rabbitmq-password"}, "", "not accepted: set env RABBITMQ_PASSWORD")
	str(&c.RabbitExchange, []string{"re", "rabbitmq-exchange"}, envOr("RABBITMQ_EXCHANGE", "mining_notify_exchange"), "RabbitMQ fanout exchange (env RABBITMQ_EXCHANGE)")
	var mongo [4]string
	str(&mongo[0], []string{"d", "db-url"}, "", "MongoDB URL (ignored: the Go collector writes Postgres only)")
	str(&mongo[1], []string{"dn", "db-name"}, "", "ignored (MongoDB)")
	str(&mongo[2], []string{"du", "db-username"}, "", "ignored (MongoDB)")
	str(&mongo[3], []string{"dp", "db-password"}, "", "ignored (MongoDB)")
	str(&c.PGHost, []string{"pg-host"}, os.Getenv("PG_HOST"), "Postgres host (env PG_HOST); the sink is enabled when --pg-host and --pg-user are set")
	str(&c.PGPort, []string{"pg-port"}, envOr("PG_PORT", "5432"), "Postgres port (env PG_PORT)")
	str(&c.PGDatabase, []string{"pg-database"}, envOr("PG_DATABASE", "stratum"), "Postgres database (env PG_DATABASE)")
	str(&c.PGUser, []string{"pg-user"}, os.Getenv("PG_USER"), "Postgres user (env PG_USER)")
	str(&pgPassFlag, []string{"pg-password"}, "", "not accepted: set env PG_PASSWORD")
	str(&c.PGSSLMode, []string{"pg-sslmode"}, envOr("PG_SSLMODE", "prefer"), "libpq sslmode (env PG_SSLMODE)")
	// 10,000 templates (~27 MiB full) instead of Python's 50,000 (~133 MiB): at ~4,400 templates/day per pool that
	// still buffers more than 2 days of Postgres outage, and keeps a pod inside a 64 Mi limit on small nodes.
	integer(&c.PGMaxQueue, []string{"pg-max-queue"}, envInt("PG_MAX_QUEUE", 10_000),
		"templates buffered while Postgres is unreachable; the oldest are dropped beyond this (env PG_MAX_QUEUE)")
	str(&c.Site, []string{"collector-site"}, envOr("COLLECTOR_SITE", "local"), "where this collector runs, stored with the source (env COLLECTOR_SITE)")
	str(&c.Replica, []string{"collector-replica"}, envOr("COLLECTOR_REPLICA", "a"), "replica identity when a pool is collected more than once per site, stored with the source (env COLLECTOR_REPLICA)")
	str(&c.Node, []string{"collector-node"}, os.Getenv("COLLECTOR_NODE"), "the machine (e.g. Kubernetes node) this process runs on, whose clock stamps received_at; recorded in its ingest_events \"start\" row (env COLLECTOR_NODE)")
	boolean(&c.KeepAlive, []string{"k", "keep-alive"}, "send mining.subscribe every 480 s to keep the connection alive")
	str(&c.LogLevel, []string{"l", "log-level"}, "INFO", "DEBUG, INFO, WARNING, ERROR or CRITICAL")
	boolean(&c.UseProxy, []string{"use-proxy"}, "connect through a SOCKS5 proxy")
	str(&c.ProxyHost, []string{"proxy-host"}, "localhost", "SOCKS5 proxy host")
	integer(&c.ProxyPort, []string{"proxy-port"}, 9050, "SOCKS5 proxy port")
	boolean(&c.EnableStratumClient, []string{"enable-stratum-client"}, "relay between a mining device and the pool")
	integer(&c.StratumClientPort, []string{"stratum-client-port"}, 3333, "port for the mining device to connect to")
	var userAgent string
	str(&userAgent, []string{"stratum-user-agent"}, "", "client identifier sent with mining.subscribe (default: omitted)")
	str(&c.ZMQBlock, []string{"bitcoin-zmq-block"}, envOr("BITCOIN_ZMQ_BLOCK", "tcp://bitcoin-node:28332"), "Bitcoin node ZMQ block endpoint (env BITCOIN_ZMQ_BLOCK)")
	str(&c.RPCUser, []string{"bitcoin-rpc-user"}, envOr("BITCOIN_RPC_USER", "user"), "Bitcoin RPC user (env BITCOIN_RPC_USER)")
	str(&rpcPassFlag, []string{"bitcoin-rpc-password"}, "", "not accepted: set env BITCOIN_RPC_PASSWORD")
	str(&c.RPCHost, []string{"bitcoin-rpc-host"}, envOr("BITCOIN_RPC_HOST", "localhost"), "Bitcoin RPC host (env BITCOIN_RPC_HOST)")
	str(&c.RPCPort, []string{"bitcoin-rpc-port"}, envOr("BITCOIN_RPC_PORT", "8332"), "Bitcoin RPC port (env BITCOIN_RPC_PORT)")
	str(&c.RPCScheme, []string{"bitcoin-rpc-scheme"}, envOr("BITCOIN_RPC_SCHEME", "http"), "http or https (env BITCOIN_RPC_SCHEME)")
	str(&c.RPCCA, []string{"bitcoin-rpc-ca-file"}, os.Getenv("BITCOIN_RPC_CA_FILE"), "PEM CA bundle for an https RPC endpoint (env BITCOIN_RPC_CA_FILE)")
	fs.Float64Var(&c.RPCTimeout, "bitcoin-rpc-timeout", 3.0, "Bitcoin RPC timeout in seconds")
	fs.Int64Var(&c.Divergence, "btc-chain-divergence-threshold", tipAhead, "height divergence before non-BTC confirmation (default: the routing window, tip ±6)")
	fs.IntVar(&c.TipStaleSeconds, "btc-tip-stale-seconds", 1800, "seconds before the local BTC tip is considered stale")
	fs.StringVar(&c.BCHURL, "bch-confirmation-url", "https://api.blockchair.com/bitcoin-cash/raw/block", "BCH block confirmation API base URL")
	fs.Float64Var(&c.BCHTimeout, "bch-confirmation-timeout", 3.0, "BCH confirmation timeout in seconds")
	fs.Float64Var(&c.ProbeInterval, "latency-probe-interval", 60.0, "seconds between latency probes (0 disables)")
	integer(&c.BurstThreshold, []string{"burst-threshold"}, envInt("COLLECTOR_BURST_THRESHOLD", defaultBurstConfig.Threshold),
		"templates in one second that make it a burst second, recorded in ingest_events; templates are stored regardless; 0 = off (env COLLECTOR_BURST_THRESHOLD)")
	fs.Float64Var(&c.BurstGap, "burst-gap", envFloat("COLLECTOR_BURST_GAP", defaultBurstConfig.Gap.Seconds()),
		"seconds without a burst second that end a burst episode (env COLLECTOR_BURST_GAP)")
	fs.Float64Var(&c.HandshakeTimeout, "handshake-timeout", envFloat("COLLECTOR_HANDSHAKE_TIMEOUT", 30), "seconds for the TCP/proxy connect and each subscribe/authorize round trip (env COLLECTOR_HANDSHAKE_TIMEOUT)")
	fs.Float64Var(&c.ReadTimeout, "read-timeout", envFloat("COLLECTOR_READ_TIMEOUT", 600), "seconds without data before reconnecting (env COLLECTOR_READ_TIMEOUT)")
	fs.Float64Var(&c.ReplicaStagger, "replica-stagger", envFloat("COLLECTOR_REPLICA_STAGGER", 0), "seconds per replica index to delay the first connection (a or 0: none, b or 1: 1x, ...), so replicas of a pool stay out of phase; 0 = off (env COLLECTOR_REPLICA_STAGGER)")
	fs.IntVar(&c.HTTPPort, "http-port", envInt("COLLECTOR_HTTP_PORT", 0), "port for /livez, /readyz and /metrics; 0 disables (env COLLECTOR_HTTP_PORT)")
	fs.Float64Var(&c.ReadyMaxNotifyAgeMin, "ready-max-notify-age", envFloat("COLLECTOR_READY_MAX_NOTIFY_AGE", 10), "/readyz fails when the last mining.notify is older than this many minutes (env COLLECTOR_READY_MAX_NOTIFY_AGE)")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if fs.NArg() > 0 {
		return nil, fmt.Errorf("unexpected arguments: %v", fs.Args())
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	for _, p := range []struct {
		names []string
		env   string
	}{{[]string{"rp", "rabbitmq-password"}, "RABBITMQ_PASSWORD"}, {[]string{"pg-password"}, "PG_PASSWORD"},
		{[]string{"bitcoin-rpc-password"}, "BITCOIN_RPC_PASSWORD"}} {
		for _, n := range p.names {
			if set[n] {
				return nil, fmt.Errorf("--%s is not accepted on the command line (it would be visible in the process list); set the %s environment variable instead", p.names[len(p.names)-1], p.env)
			}
		}
	}
	for i, n := range []string{"db-url", "db-name", "db-username", "db-password"} {
		short := []string{"d", "dn", "du", "dp"}[i]
		if set[n] || set[short] {
			c.Warnings = append(c.Warnings, fmt.Sprintf("--%s ignored: MongoDB is not supported by the Go collector (Postgres only)", n))
		}
	}
	if c.URL == "" || c.UserPass == "" {
		return nil, errors.New("--url and --userpass are required")
	}
	if _, _, err := parseStratumURL(c.URL); err != nil {
		return nil, err
	}
	if set["stratum-user-agent"] {
		c.UserAgent = &userAgent
	}
	if c.PoolName == "" {
		u, _ := url.Parse(c.URL)
		c.PoolName = strings.ToLower(u.Hostname()) // Python urlparse().hostname is lower-cased
	}
	switch c.LogLevel {
	case "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL":
	default:
		return nil, fmt.Errorf("invalid --log-level %q (DEBUG, INFO, WARNING, ERROR, CRITICAL)", c.LogLevel)
	}
	if c.RPCScheme != "http" && c.RPCScheme != "https" {
		return nil, fmt.Errorf("invalid --bitcoin-rpc-scheme %q (http or https)", c.RPCScheme)
	}
	if c.Replica == "" {
		return nil, errors.New("--collector-replica must not be empty")
	}
	c.RabbitPassword = os.Getenv("RABBITMQ_PASSWORD")
	c.PGPassword = os.Getenv("PG_PASSWORD")
	c.RPCPassword = envOr("BITCOIN_RPC_PASSWORD", "password")
	return c, nil
}

func secs(f float64) time.Duration { return time.Duration(f * float64(time.Second)) }

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
		"ERROR": slog.LevelError, "CRITICAL": slog.LevelError + 4}[cfg.LogLevel]
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lvl})).With("pool", cfg.PoolName)
	for _, w := range cfg.Warnings {
		log.Warn(w)
	}
	log.Info("starting", "version", version, "site", cfg.Site, "replica", cfg.Replica, "node", cfg.Node)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	metrics := &Metrics{}

	// Bitcoin tip: initial RPC, then ZMQ-triggered updates.
	tip := NewTipState(time.Duration(cfg.TipStaleSeconds) * time.Second)
	if rpc, err := NewRPC(cfg.RPCScheme, cfg.RPCHost, cfg.RPCPort, cfg.RPCUser, cfg.RPCPassword, cfg.RPCCA,
		secs(cfg.RPCTimeout)); err != nil {
		log.Warn("BTC tip disabled: RPC client setup failed", "err", err)
	} else {
		f := &TipFollower{Tip: tip, RPC: rpc, Endpoint: cfg.ZMQBlock, Retry: 5 * time.Second, log: log,
			Updates: func() { metrics.TipUpdates.Add(1) }}
		ictx, cancel := context.WithTimeout(ctx, secs(cfg.RPCTimeout)+time.Second)
		f.Init(ictx)
		cancel()
		go f.Run(ctx)
	}

	var pg *PostgresSink
	if cfg.PGHost != "" && cfg.PGUser != "" {
		pg = NewPostgresSink(PGConfig{Host: cfg.PGHost, Port: cfg.PGPort, Database: cfg.PGDatabase, User: cfg.PGUser,
			Password: cfg.PGPassword, SSLMode: cfg.PGSSLMode, Site: cfg.Site, Replica: cfg.Replica,
			ConnectTimeout: 10 * time.Second}, cfg.PoolName, cfg.URL, tip.Current, log)
		if cfg.PGMaxQueue > 0 {
			pg.maxQueue = cfg.PGMaxQueue
		}
		pg.Start()
	}
	if pg != nil {
		// Which machine's clock stamps this process's templates: a pod can land on a different node after every
		// restart, and the replica name doesn't say which.
		pg.SubmitEvent(startEvent(cfg.Node, version, time.Now()))
	}
	var rmq *RabbitMQPublisher
	if cfg.RabbitUser != "" && cfg.RabbitPassword != "" {
		rmq = NewRabbitMQPublisher(RabbitMQConfig{Host: cfg.RabbitHost, Port: cfg.RabbitPort, Username: cfg.RabbitUser,
			Password: cfg.RabbitPassword, Exchange: cfg.RabbitExchange, Heartbeat: 30 * time.Second,
			BlockedConnectionTimeout: 30 * time.Second, SocketTimeout: 10 * time.Second}, log).Start()
	} else if cfg.RabbitUser != "" {
		log.Warn("RabbitMQ disabled: --rabbitmq-username is set but RABBITMQ_PASSWORD is not")
	}
	var backends []string
	if rmq != nil {
		backends = append(backends, "RabbitMQ")
	}
	if pg != nil {
		backends = append(backends, fmt.Sprintf("Postgres (%s:%s/%s, site %s, replica %s)", cfg.PGHost, cfg.PGPort,
			cfg.PGDatabase, cfg.Site, cfg.Replica))
	}
	if len(backends) > 0 {
		log.Info("enabled backends: " + strings.Join(backends, ", "))
	} else {
		log.Info("running in connect-only mode (no RabbitMQ or Postgres backend enabled)")
	}

	toSinks := func(d *Document) {
		if pg != nil {
			pg.Submit(d)
		}
		if rmq != nil {
			rmq.Submit(d)
		}
	}
	classifier := NewClassifier(tip, cfg.Divergence, NewBCHConfirmer(cfg.BCHURL, secs(cfg.BCHTimeout)), toSinks, log)
	classifier.Start()

	collector, err := NewCollector(StratumConfig{
		URL: cfg.URL, UserPass: cfg.UserPass, UserAgent: cfg.UserAgent, PoolName: cfg.PoolName,
		Site: cfg.Site, Replica: cfg.Replica,
		UseProxy: cfg.UseProxy, ProxyHost: cfg.ProxyHost, ProxyPort: cfg.ProxyPort,
		HandshakeTimeout: secs(cfg.HandshakeTimeout), ReadTimeout: secs(cfg.ReadTimeout), RetryDelay: 5 * time.Second,
		StartDelay:    replicaStartDelay(cfg.Replica, secs(cfg.ReplicaStagger)),
		ProbeInterval: secs(cfg.ProbeInterval), KeepAlive: cfg.KeepAlive, KeepAliveEvery: 480 * time.Second,
	}, log, metrics, classifier.Submit)
	if err != nil {
		log.Error("invalid configuration", "err", err)
		return 2
	}
	if pg != nil {
		collector.Reject = pg.SubmitReject // quarantine: templates_rejected (#105)
		collector.Event = pg.SubmitEvent   // ingest_events: bursts (#105)
	}
	if cfg.BurstThreshold > 0 {
		collector.Bursts = NewBurstDetector(BurstConfig{Threshold: cfg.BurstThreshold, Gap: secs(cfg.BurstGap),
			MaxSegment: defaultBurstConfig.MaxSegment})
		go func() { // close episodes when the pool goes quiet (no template would trigger it)
			t := time.NewTicker(time.Second)
			defer t.Stop()
			for range t.C {
				for _, e := range collector.Bursts.Flush(time.Now()) {
					collector.event(e)
				}
			}
		}()
	}

	if cfg.HTTPPort > 0 {
		hs := &HealthServer{Metrics: metrics, MaxAge: secs(cfg.ReadyMaxNotifyAgeMin * 60), PG: pg, RMQ: rmq,
			Classifier: classifier, Tracker: collector.tracker, Tip: tip, log: log,
			Labels: map[string]string{"pool": cfg.PoolName, "site": cfg.Site, "replica": cfg.Replica, "version": version}}
		if err := hs.Serve(ctx, fmt.Sprintf(":%d", cfg.HTTPPort)); err != nil {
			log.Error("health server failed to start", "err", err)
			return 1
		}
	}

	code := 0
	if cfg.EnableStratumClient {
		if err := collector.RunRelay(ctx, fmt.Sprintf(":%d", cfg.StratumClientPort)); err != nil {
			log.Error("relay mode failed", "err", err)
			code = 1
		}
	} else {
		collector.Run(ctx)
	}
	log.Info("shutting down: flushing sinks")
	classifier.Close()
	if pg != nil {
		pg.Close(5 * time.Second)
	}
	if rmq != nil {
		rmq.Close(5 * time.Second)
	}
	return code
}

// startEvent is the ingest_events record of a collector process starting (kind "start"). A template's node is the
// node of the latest start of its source at or before its received_at.
func startEvent(node, version string, at time.Time) IngestEvent {
	d := map[string]any{"node": nil, "version": version}
	if node != "" {
		d["node"] = node
	}
	return IngestEvent{Kind: "start", Start: at, End: at, Detail: d}
}

// replicaStartDelay staggers replicas of a pool by their index: replica "a" (or "0", a StatefulSet ordinal) starts
// at once, "b" ("1") after one stagger, "c" ("2") after two. Some pools drop idle connections on a fixed timer after
// they connect, so replicas started together are dropped together; a fixed offset keeps their gaps apart (a random
// jitter wouldn't: it overlaps often and drifts). Other replica names start at once.
func replicaStartDelay(replica string, stagger time.Duration) time.Duration {
	if stagger <= 0 || len(replica) != 1 {
		return 0
	}
	switch r := replica[0]; {
	case r >= 'a' && r <= 'z':
		return time.Duration(r-'a') * stagger
	case r >= '0' && r <= '9':
		return time.Duration(r-'0') * stagger
	}
	return 0
}
