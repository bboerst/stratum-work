// Command router is the Stratum V1 hashrate router.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/bboerst/stratum-work/router/internal/admin"
	"github.com/bboerst/stratum-work/router/internal/config"
	"github.com/bboerst/stratum-work/router/internal/publish"
	"github.com/bboerst/stratum-work/router/internal/router"
)

const publishInterval = 10 * time.Second

func main() {
	os.Exit(run())
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func run() int {
	configPath := flag.String("config", envOr("CONFIG_PATH", "/etc/router/config.yaml"), "config file path (env CONFIG_PATH)")
	exchange := flag.String("amqp-exchange", envOr("AMQP_EXCHANGE", "mining_notify_exchange"), "AMQP exchange (env AMQP_EXCHANGE)")
	logLevel := flag.String("log-level", envOr("LOG_LEVEL", "info"), "log level (env LOG_LEVEL)")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: parseLevel(*logLevel)}))
	slog.SetDefault(log)

	token := os.Getenv("WORK_TOKEN")
	if token == "" {
		log.Error("WORK_TOKEN is required")
		return 2
	}
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Error("config load failed", "path", *configPath, "err", err)
		return 2
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	var pub publish.Publisher
	var amqpPub *publish.AMQP
	if url := os.Getenv("AMQP_URL"); url != "" {
		amqpPub = publish.NewAMQP(url, *exchange, log)
		pub = amqpPub
		log.Info("routing status publishing enabled", "exchange", *exchange)
	} else {
		log.Info("AMQP_URL not set; routing status publishing is disabled")
	}

	r := router.New(cfg, token, pub, log)

	var wg sync.WaitGroup
	runErr := make(chan error, 1)
	wg.Add(1)
	go func() {
		defer wg.Done()
		runErr <- r.Run(ctx)
	}()

	srv := &http.Server{
		Addr:              cfg.AdminListen,
		Handler:           admin.Handler(r.Status),
		ReadHeaderTimeout: 5 * time.Second,
	}
	adminErr := make(chan error, 1)
	go func() {
		log.Info("admin listening", "addr", cfg.AdminListen)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			adminErr <- err
		}
	}()

	if pub != nil {
		minWork := time.Duration(cfg.ThanksMinWorkMinutes) * time.Minute
		wg.Add(1)
		go func() {
			defer wg.Done()
			publish.Loop(ctx, r.Status, pub, publishInterval, minWork, log)
		}()
	}

	log.Info("router starting", "site", cfg.Site, "listen", cfg.Listen, "targets", len(cfg.Targets))

	code := 0
	select {
	case <-ctx.Done():
		log.Info("shutdown signal received")
	case err := <-runErr:
		if err != nil {
			log.Error("router stopped", "err", err)
			code = 1
		}
	case err := <-adminErr:
		log.Error("admin server failed", "err", err)
		code = 1
	}
	stop()

	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		log.Warn("admin shutdown", "err", err)
	}
	wg.Wait()
	if amqpPub != nil {
		_ = amqpPub.Close()
	}
	log.Info("router stopped")
	return code
}
