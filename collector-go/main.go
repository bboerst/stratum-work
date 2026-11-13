// stratum-work collector, Go port (SPIKE for stratum-work#148). One process per pool, like the Python collector.
// Implemented: Stratum subscribe/authorize/notify, BIP34 height, chain classification (minus the BCH API), tip from
// bitcoind RPC, Postgres sink. Not yet: latency probes, RabbitMQ, SOCKS5 proxy, miner-relay mode, keep-alive,
// health endpoint, replica identity.
package main

import (
	"encoding/json"
	"flag"
	"log/slog"
	"net/url"
	"os"
	"time"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	poolName := flag.String("pool-name", "", "pool name (default: URL host)")
	stratumURL := flag.String("url", "", "stratum+tcp://host:port")
	userpass := flag.String("userpass", "", "user:password for mining.authorize")
	userAgent := flag.String("stratum-user-agent", "", "optional mining.subscribe user agent")
	site := flag.String("collector-site", env("COLLECTOR_SITE", "local"), "collection site (env COLLECTOR_SITE)")
	logLevel := flag.String("log-level", "INFO", "DEBUG, INFO, WARNING, ERROR")
	pgHost := flag.String("pg-host", env("PG_HOST", ""), "Postgres host (env PG_HOST)")
	pgPort := flag.String("pg-port", env("PG_PORT", "5432"), "Postgres port (env PG_PORT)")
	pgDB := flag.String("pg-database", env("PG_DATABASE", "stratum"), "Postgres database (env PG_DATABASE)")
	pgUser := flag.String("pg-user", env("PG_USER", ""), "Postgres user (env PG_USER)")
	pgSSL := flag.String("pg-sslmode", env("PG_SSLMODE", "prefer"), "libpq sslmode (env PG_SSLMODE)")
	rpcScheme := flag.String("bitcoin-rpc-scheme", env("BITCOIN_RPC_SCHEME", "http"), "")
	rpcHost := flag.String("bitcoin-rpc-host", env("BITCOIN_RPC_HOST", "localhost"), "")
	rpcPort := flag.String("bitcoin-rpc-port", env("BITCOIN_RPC_PORT", "8332"), "")
	rpcUser := flag.String("bitcoin-rpc-user", env("BITCOIN_RPC_USER", "user"), "")
	rpcCA := flag.String("bitcoin-rpc-ca-file", env("BITCOIN_RPC_CA_FILE", ""), "")
	divergence := flag.Int64("btc-chain-divergence-threshold", 5, "")
	staleSec := flag.Int("btc-tip-stale-seconds", 1800, "")
	flag.Parse()

	lvl := map[string]slog.Level{"DEBUG": slog.LevelDebug, "INFO": slog.LevelInfo, "WARNING": slog.LevelWarn, "ERROR": slog.LevelError}[*logLevel]
	if *poolName == "" {
		if u, err := url.Parse(*stratumURL); err == nil {
			*poolName = u.Hostname()
		}
	}
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lvl})).With("pool", *poolName)

	tip := &TipState{staleAfter: time.Duration(*staleSec) * time.Second}
	// Passwords come from the environment only (never argv): PG_PASSWORD, BITCOIN_RPC_PASSWORD.
	if rpc, err := newRPC(*rpcScheme, *rpcHost, *rpcPort, *rpcUser, os.Getenv("BITCOIN_RPC_PASSWORD"), *rpcCA, 3*time.Second); err != nil {
		log.Warn("BTC tip disabled", "err", err)
	} else {
		go tip.Follow(rpc, 2*time.Second, log)
	}

	var sink *PostgresSink
	if *pgHost != "" && *pgUser != "" {
		sink = NewPostgresSink(PGConfig{Host: *pgHost, Port: *pgPort, Database: *pgDB, User: *pgUser,
			Password: os.Getenv("PG_PASSWORD"), SSLMode: *pgSSL, Site: *site}, *poolName, *stratumURL, tip, log)
		go sink.Run()
	}

	c := &Client{URL: *stratumURL, UserPass: *userpass, UserAgent: *userAgent, Timeout: 600 * time.Second, log: log}
	c.OnNotify = func(p []json.RawMessage, ts, app int64, en1 string, en2 int) {
		t := Template{TsNs: ts, Extranonce1: en1, HasExtranonce: en1 != "", Extranonce2: en2}
		t.JobID = rawString(p[0])
		_ = json.Unmarshal(p[1], &t.PrevHash)
		_ = json.Unmarshal(p[2], &t.Coinbase1)
		_ = json.Unmarshal(p[3], &t.Coinbase2)
		_ = json.Unmarshal(p[4], &t.Merkle)
		_ = json.Unmarshal(p[5], &t.Version)
		_ = json.Unmarshal(p[6], &t.Nbits)
		_ = json.Unmarshal(p[7], &t.Ntime)
		t.CleanJobs = truthy(p[8])
		if h, ok := parseBIP34Height(t.Coinbase1); ok {
			t.Height = h
		} else {
			log.Warn("could not parse BIP34 height from coinbase1 (stored as 0)")
		}
		t.ChainFamily = classifyChain(tip, t.Height, *divergence)
		// SPIKE measurement: how far the app clock (Python's method) trails the kernel receive time.
		log.Info("mining.notify", "job_id", t.JobID, "height", t.Height, "app_minus_kernel_us", (app-ts)/1000)
		if sink != nil {
			sink.Submit(t)
		}
	}
	log.Info("starting", "site", *site, "postgres", sink != nil)
	c.Run()
}

// rawString mirrors Python str(value) for a JSON string or number.
func rawString(r json.RawMessage) string {
	var s string
	if json.Unmarshal(r, &s) == nil {
		return s
	}
	return string(r)
}

// truthy mirrors Python bool(value) for a decoded JSON value.
func truthy(r json.RawMessage) bool {
	var v any
	if json.Unmarshal(r, &v) != nil {
		return false
	}
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case nil:
		return false
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}
