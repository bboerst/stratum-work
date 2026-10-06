// Command zmqnotify subscribes to bitcoind's ZMQ `hashblock` topic and pings
// an HTTP endpoint (e.g. DATUM gateway's /NOTIFY) on every new block.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/go-zeromq/zmq4"
)

const (
	topic         = "hashblock"
	notifyTimeout = 5 * time.Second
	minBackoff    = time.Second
	idleTimeout   = 2 * time.Hour // far longer than any normal gap between blocks
	maxBackoff    = 30 * time.Second
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	endpoint := os.Getenv("ZMQ_ENDPOINT")
	url := os.Getenv("NOTIFY_URL")
	if endpoint == "" || url == "" {
		log.Error("ZMQ_ENDPOINT and NOTIFY_URL are required")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	n := &notifier{url: url, client: &http.Client{Timeout: notifyTimeout}, log: log}
	log.Info("zmqnotify starting", "endpoint", endpoint)
	runLoop(ctx, endpoint, n, log)
	log.Info("zmqnotify stopped")
}

// notifier issues a GET to url for each block message.
type notifier struct {
	url    string
	client *http.Client
	log    *slog.Logger
}

// Notify GETs the notify URL. Non-2xx responses are errors.
func (n *notifier) Notify(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, notifyTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, n.url, nil)
	if err != nil {
		return err
	}
	resp, err := n.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("notify: status %d", resp.StatusCode)
	}
	return nil
}

// Handle processes one ZMQ message; only `hashblock` messages trigger a
// notify. Failures are logged, not returned (the next block retries).
func (n *notifier) Handle(ctx context.Context, frames [][]byte) {
	if len(frames) == 0 || string(frames[0]) != topic {
		return
	}
	var hash string
	if len(frames) > 1 {
		hash = fmt.Sprintf("%x", frames[1])
	}
	if err := n.Notify(ctx); err != nil {
		n.log.Warn("notify failed", "block", hash, "err", err)
		return
	}
	n.log.Info("notified", "block", hash)
}

// runLoop subscribes and reconnects with exponential backoff until ctx ends.
func runLoop(ctx context.Context, endpoint string, n *notifier, log *slog.Logger) {
	backoff := minBackoff
	for ctx.Err() == nil {
		start := time.Now()
		err := subscribe(ctx, endpoint, n)
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > maxBackoff {
			backoff = minBackoff
		}
		log.Warn("zmq subscription ended; reconnecting", "err", err, "backoff", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

func subscribe(ctx context.Context, endpoint string, n *notifier) error {
	sub := zmq4.NewSub(ctx)
	defer sub.Close()
	if err := sub.Dial(endpoint); err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	if err := sub.SetOption(zmq4.OptionSubscribe, topic); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	// Watchdog: bitcoind blocks arrive ~every 10 min; if nothing arrives for
	// idleTimeout the TCP session may be half-open, so recreate the socket.
	// Closing the socket unblocks Recv.
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	wctx, wcancel := context.WithCancel(ctx)
	defer wcancel()
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-wctx.Done():
				return
			case <-t.C:
				if time.Since(time.Unix(0, last.Load())) > idleTimeout {
					_ = sub.Close()
					return
				}
			}
		}
	}()
	for {
		msg, err := sub.Recv()
		last.Store(time.Now().UnixNano())
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, io.EOF) {
				return errors.New("connection closed")
			}
			return fmt.Errorf("recv: %w", err)
		}
		n.Handle(ctx, msg.Frames)
	}
}
