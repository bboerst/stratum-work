package main

import (
	"io"
	"log/slog"
	"strings"
	"testing"
)

func TestPythonFlagsAndDefaults(t *testing.T) {
	t.Setenv("PG_HOST", "pg")
	t.Setenv("COLLECTOR_SITE", "")
	t.Setenv("COLLECTOR_REPLICA", "")
	t.Setenv("RABBITMQ_PASSWORD", "mq-secret")
	c, err := parseConfig(strings.Fields(`-u stratum+tcp://Pool.Example.com:3333 -up user:pw -ru mquser -r rabbitmq
		-re ex -d mongodb -dn db -du mu -dp mp --log-level DEBUG -k --use-proxy --proxy-port 9150`), io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if c.PoolName != "pool.example.com" || c.RabbitUser != "mquser" || c.RabbitHost != "rabbitmq" ||
		c.RabbitExchange != "ex" || c.RabbitPort != 5672 || !c.KeepAlive || !c.UseProxy || c.ProxyPort != 9150 ||
		c.ProxyHost != "localhost" || c.PGHost != "pg" || c.Site != "local" || c.Replica != "a" ||
		c.RabbitPassword != "mq-secret" || c.UserAgent != nil || c.ProbeInterval != 60 ||
		c.HandshakeTimeout != 30 || c.ReadTimeout != 600 || c.ReplicaStagger != 0 || c.HTTPPort != 0 ||
		c.ReadyMaxNotifyAgeMin != 10 || c.StratumClientPort != 3333 {
		t.Errorf("%+v", c)
	}
	if len(c.Warnings) != 4 { // the four MongoDB flags
		t.Error(c.Warnings)
	}
}

func TestUserAgentDefaultsToNoneAndAcceptsOverride(t *testing.T) {
	c, _ := parseConfig([]string{"--url", "stratum+tcp://p:1", "--userpass", "u:p"}, io.Discard)
	if c.UserAgent != nil {
		t.Error("expected nil")
	}
	c, _ = parseConfig([]string{"--url", "stratum+tcp://p:1", "--userpass", "u:p", "--stratum-user-agent", "cgminer/4.12.1"}, io.Discard)
	if c.UserAgent == nil || *c.UserAgent != "cgminer/4.12.1" {
		t.Error(c.UserAgent)
	}
	c, _ = parseConfig([]string{"--url", "stratum+tcp://p:1", "--userpass", "u:p", "--stratum-user-agent="}, io.Discard)
	if c.UserAgent == nil || *c.UserAgent != "" { // explicitly empty is sent, like Python's ""
		t.Error("empty user agent")
	}
}

func TestPasswordsOnTheCommandLineAreRefused(t *testing.T) {
	for _, f := range []string{"-rp", "--rabbitmq-password", "--pg-password", "--bitcoin-rpc-password"} {
		_, err := parseConfig([]string{"-u", "stratum+tcp://p:1", "-up", "u:p", f, "hunter2"}, io.Discard)
		if err == nil || strings.Contains(err.Error(), "hunter2") {
			t.Errorf("%s: %v", f, err)
		}
	}
}

// The node-tip and chain-classification flags are accepted and ignored for one release: an unknown flag would make
// the parser exit, crash-looping deployments that still pass one. Any value parses, and each passed flag (only those,
// not the BITCOIN_* env vars) gets one warning.
func TestRemovedTipFlagsAreIgnoredWithAWarning(t *testing.T) {
	t.Setenv("BITCOIN_RPC_HOST", "node")
	t.Setenv("BITCOIN_ZMQ_BLOCK", "tcp://node:28332")
	values := map[string]string{"bitcoin-zmq-block": "tcp://bitcoin-node:28332", "bitcoin-rpc-user": "user",
		"bitcoin-rpc-host": "localhost", "bitcoin-rpc-port": "8332", "bitcoin-rpc-scheme": "ftp",
		"bitcoin-rpc-ca-file": "/certs/ca.pem", "bitcoin-rpc-timeout": "3.0", "btc-chain-divergence-threshold": "6",
		"btc-tip-stale-seconds": "1800", "bch-confirmation-url": "https://example.invalid/block",
		"bch-confirmation-timeout": "not-a-number"}
	if len(values) != len(ignoredTipFlags) {
		t.Fatalf("test covers %d of %d flags", len(values), len(ignoredTipFlags))
	}
	base := []string{"-u", "stratum+tcp://p:1", "-up", "u:p"}
	for _, f := range ignoredTipFlags {
		for _, args := range [][]string{{"--" + f, values[f]}, {"--" + f + "=" + values[f]}, {"-" + f, values[f]}} {
			c, err := parseConfig(append(append([]string(nil), base...), args...), io.Discard)
			if err != nil {
				t.Errorf("%v: %v", args, err)
				continue
			}
			want := "flag --" + f + " is ignored: chain classification moved to read time (docs/design/one-templates-table.md)"
			if len(c.Warnings) != 1 || c.Warnings[0] != want {
				t.Errorf("%v: warnings %q", args, c.Warnings)
			}
		}
	}
	all := append([]string(nil), base...)
	for _, f := range ignoredTipFlags {
		all = append(all, "--"+f, values[f])
	}
	if c, err := parseConfig(all, io.Discard); err != nil || len(c.Warnings) != len(ignoredTipFlags) {
		t.Error(err, c)
	}
	if c, err := parseConfig(base, io.Discard); err != nil || len(c.Warnings) != 0 {
		t.Error("env vars alone must not warn:", err, c)
	}
}

// What run() does with the warnings: the collector logs each once at startup and keeps running.
func TestIgnoredFlagWarningIsLogged(t *testing.T) {
	c, err := parseConfig([]string{"-u", "stratum+tcp://p:1", "-up", "u:p", "--btc-chain-divergence-threshold", "6"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	logStartupWarnings(slog.New(slog.NewTextHandler(&out, nil)), c)
	if got := out.String(); strings.Count(got, "level=WARN") != 1 ||
		!strings.Contains(got, "flag --btc-chain-divergence-threshold is ignored: chain classification moved to read time") {
		t.Error(got)
	}
}

func TestEnvDefaultsAndNewSettings(t *testing.T) {
	t.Setenv("COLLECTOR_REPLICA", "b")
	t.Setenv("COLLECTOR_SITE", "site-2")
	t.Setenv("COLLECTOR_HTTP_PORT", "8080")
	t.Setenv("PG_PASSWORD", "pg-secret")
	c, err := parseConfig([]string{"-u", "stratum+tcp://p:1", "-up", "u", "--ready-max-notify-age", "3"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if c.Replica != "b" || c.Site != "site-2" || c.HTTPPort != 8080 || c.PGPassword != "pg-secret" ||
		c.ReadyMaxNotifyAgeMin != 3 {
		t.Errorf("%+v", c)
	}
	c, _ = parseConfig([]string{"-u", "stratum+tcp://p:1", "-up", "u", "--collector-replica", "c"}, io.Discard)
	if c.Replica != "c" {
		t.Error("flag must win over env")
	}
}

func TestInvalidConfig(t *testing.T) {
	for _, args := range [][]string{
		{"-up", "u:p"},
		{"-u", "stratum+tcp://p:1"},
		{"-u", "tcp://p:1", "-up", "u"},
		{"-u", "stratum+tcp://p:1", "-up", "u", "-l", "debug"}, // argparse choices are case-sensitive
		{"-u", "stratum+tcp://p:1", "-up", "u", "--no-such-flag"},
	} {
		if _, err := parseConfig(args, io.Discard); err == nil {
			t.Errorf("%v: expected an error", args)
		}
	}
}

// The RabbitMQ settings have env fallbacks like the Postgres and Bitcoin ones; flags win.
func TestRabbitMQSettingsFromEnv(t *testing.T) {
	t.Setenv("RABBITMQ_HOST", "mq.example")
	t.Setenv("RABBITMQ_PORT", "5673")
	t.Setenv("RABBITMQ_USERNAME", "envuser")
	t.Setenv("RABBITMQ_EXCHANGE", "env_exchange")
	t.Setenv("RABBITMQ_PASSWORD", "mq-secret")
	c, err := parseConfig([]string{"--url", "stratum+tcp://p:1", "--userpass", "u:p"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if c.RabbitHost != "mq.example" || c.RabbitPort != 5673 || c.RabbitUser != "envuser" || c.RabbitExchange != "env_exchange" {
		t.Errorf("%+v", c)
	}
	c, err = parseConfig([]string{"--url", "stratum+tcp://p:1", "--userpass", "u:p", "-r", "flaghost", "-ru", "flaguser",
		"-re", "flag_exchange", "--rabbitmq-port", "5674"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if c.RabbitHost != "flaghost" || c.RabbitPort != 5674 || c.RabbitUser != "flaguser" || c.RabbitExchange != "flag_exchange" {
		t.Errorf("flags should win: %+v", c)
	}
}
