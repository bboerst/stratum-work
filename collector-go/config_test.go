package main

import (
	"io"
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
		c.RabbitPassword != "mq-secret" || c.UserAgent != nil || c.ProbeInterval != 60 || c.Divergence != 5 ||
		c.TipStaleSeconds != 1800 || c.HandshakeTimeout != 30 || c.ReadTimeout != 600 || c.HTTPPort != 0 ||
		c.ReadyMaxNotifyAgeMin != 10 || c.StratumClientPort != 3333 || c.ZMQBlock != "tcp://bitcoin-node:28332" {
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

func TestEnvDefaultsAndNewSettings(t *testing.T) {
	t.Setenv("COLLECTOR_REPLICA", "b")
	t.Setenv("COLLECTOR_SITE", "ash")
	t.Setenv("COLLECTOR_HTTP_PORT", "8080")
	t.Setenv("PG_PASSWORD", "pg-secret")
	t.Setenv("BITCOIN_RPC_PASSWORD", "")
	c, err := parseConfig([]string{"-u", "stratum+tcp://p:1", "-up", "u", "--ready-max-notify-age", "3"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if c.Replica != "b" || c.Site != "ash" || c.HTTPPort != 8080 || c.PGPassword != "pg-secret" ||
		c.RPCPassword != "password" || c.ReadyMaxNotifyAgeMin != 3 {
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
		{"-u", "stratum+tcp://p:1", "-up", "u", "--bitcoin-rpc-scheme", "ftp"},
		{"-u", "stratum+tcp://p:1", "-up", "u", "--no-such-flag"},
	} {
		if _, err := parseConfig(args, io.Discard); err == nil {
			t.Errorf("%v: expected an error", args)
		}
	}
}
