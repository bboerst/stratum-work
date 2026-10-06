// Command testminer is a tiny single-threaded CPU Stratum V1 miner with
// version rolling, used by the regtest integration harness. It is not meant
// for real mining.
package main

import (
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	url := flag.String("url", "127.0.0.1:3333", "stratum host:port (stratum+tcp:// prefix allowed)")
	user := flag.String("user", "testminer", "worker username")
	pass := flag.String("pass", "x", "worker password")
	dur := flag.Duration("duration", 0, "stop after this long (0 = until signalled)")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	addr := strings.TrimPrefix(*url, "stratum+tcp://")
	stop := make(chan struct{})
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		var timeout <-chan time.Time
		if *dur > 0 {
			timeout = time.After(*dur)
		}
		select {
		case <-sig:
		case <-timeout:
		}
		close(stop)
	}()

	var total stats
	for {
		m, err := dial(addr, *user, *pass, log)
		if err != nil {
			log.Warn("connect failed; retrying", "addr", addr, "err", err)
		} else {
			m.run(stop)
			total.add(m.stats())
			log.Info("session ended", "accepted", total.Accepted, "rejected", total.Rejected)
		}
		select {
		case <-stop:
			log.Info("testminer done", "accepted", total.Accepted, "rejected", total.Rejected, "submitted", total.Submitted)
			return
		case <-time.After(2 * time.Second):
		}
	}
}
