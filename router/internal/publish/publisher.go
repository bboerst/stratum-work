// Package publish builds the periodic routing status message and publishes
// it to RabbitMQ.
package publish

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/bboerst/stratum-work/router/internal/router"
)

// Publisher receives periodic routing status.
type Publisher = router.Publisher

const ths = 1e12

type Target struct {
	ID           string  `json:"id"`
	Pool         string  `json:"pool"`
	TargetThs    float64 `json:"target_ths"`
	DeliveredThs float64 `json:"delivered_ths"`
	Available    bool    `json:"available"`
}

type Remainder struct {
	ID             string  `json:"id"`
	DeliveredThs   float64 `json:"delivered_ths"`
	FallbackActive bool    `json:"fallback_active"`
}

type Worker struct {
	Name  string  `json:"name"`
	Ths   float64 `json:"ths"`
	Since string  `json:"since"`
}

// Routing is the "routing" message on the legacy stream exchange.
type Routing struct {
	Type      string    `json:"type"`
	Timestamp string    `json:"timestamp"`
	Site      string    `json:"site"`
	TotalThs  float64   `json:"total_ths"`
	Targets   []Target  `json:"targets"`
	Remainder Remainder `json:"remainder"`
	Workers   []Worker  `json:"workers"`
}

// BuildRouting converts a router Status into the routing message. Workers
// with less than minWork of valid work are omitted.
func BuildRouting(st router.Status, now time.Time, minWork time.Duration) Routing {
	m := Routing{
		Type:      "routing",
		Timestamp: strconv.FormatInt(now.UnixNano(), 16),
		Site:      st.Site,
		TotalThs:  st.TotalHs / ths,
		Targets:   make([]Target, 0, len(st.Targets)),
		Remainder: Remainder{
			ID:             st.Remainder.ID,
			DeliveredThs:   st.Remainder.DeliveredHs / ths,
			FallbackActive: st.Remainder.FallbackActive,
		},
		Workers: make([]Worker, 0, len(st.Workers)),
	}
	for _, t := range st.Targets {
		m.Targets = append(m.Targets, Target{
			ID: t.ID, Pool: t.Pool,
			TargetThs: t.TargetHs / ths, DeliveredThs: t.DeliveredHs / ths,
			Available: t.Available,
		})
	}
	minSec := minWork.Seconds()
	for _, w := range st.Workers {
		if w.WorkSeconds < minSec {
			continue
		}
		m.Workers = append(m.Workers, Worker{
			Name: w.Name, Ths: w.Hs / ths, Since: w.Since.UTC().Format(time.RFC3339),
		})
	}
	return m
}

// Loop publishes a routing message built from src every interval until ctx
// is cancelled. Publish errors are logged at debug level and the message is
// dropped (status is periodic).
func Loop(ctx context.Context, src func() router.Status, pub Publisher, every, minWork time.Duration, log *slog.Logger) {
	if log == nil {
		log = slog.Default()
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			if err := pub.Publish(BuildRouting(src(), now, minWork)); err != nil {
				log.Debug("routing status dropped", "err", err)
			}
		}
	}
}

// ErrDisconnected is returned by AMQP.Publish while no channel is open.
var ErrDisconnected = errors.New("amqp: not connected")

const (
	minBackoff = time.Second
	maxBackoff = 30 * time.Second
)

// AMQP publishes JSON messages to a durable fanout exchange, reconnecting in
// the background. The URL is never logged.
type AMQP struct {
	url, exchange string
	log           *slog.Logger

	mu   sync.Mutex
	conn *amqp.Connection
	ch   *amqp.Channel

	stop chan struct{}
	done chan struct{}
	once sync.Once
}

// NewAMQP starts a background connection loop and returns immediately.
func NewAMQP(url, exchange string, log *slog.Logger) *AMQP {
	if log == nil {
		log = slog.Default()
	}
	a := &AMQP{url: url, exchange: exchange, log: log,
		stop: make(chan struct{}), done: make(chan struct{})}
	go a.run()
	return a
}

func (a *AMQP) run() {
	defer close(a.done)
	backoff := minBackoff
	for {
		closed, err := a.connect()
		if err != nil {
			a.log.Warn("amqp connect failed", "exchange", a.exchange, "err", err, "retry_in", backoff)
			select {
			case <-a.stop:
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, maxBackoff)
			continue
		}
		a.log.Info("amqp connected", "exchange", a.exchange)
		backoff = minBackoff
		select {
		case <-a.stop:
			a.teardown()
			return
		case err := <-closed.conn:
			a.teardown()
			a.log.Warn("amqp connection lost", "exchange", a.exchange, "err", err)
		case err := <-closed.ch:
			a.teardown()
			a.log.Warn("amqp channel lost", "exchange", a.exchange, "err", err)
		}
	}
}

// closeNotify holds one listener per amqp object. amqp091 closes each
// registered chan, so they must never be shared (double close panics).
type closeNotify struct{ conn, ch chan *amqp.Error }

func (a *AMQP) connect() (closeNotify, error) {
	conn, err := amqp.DialConfig(a.url, amqp.Config{Dial: amqp.DefaultDial(10 * time.Second)})
	if err != nil {
		return closeNotify{}, err
	}
	ch, err := conn.Channel()
	if err != nil {
		conn.Close()
		return closeNotify{}, err
	}
	if err := ch.ExchangeDeclare(a.exchange, amqp.ExchangeFanout, true, false, false, false, nil); err != nil {
		conn.Close()
		return closeNotify{}, err
	}
	closed := closeNotify{conn: make(chan *amqp.Error, 1), ch: make(chan *amqp.Error, 1)}
	conn.NotifyClose(closed.conn)
	ch.NotifyClose(closed.ch)
	a.mu.Lock()
	a.conn, a.ch = conn, ch
	a.mu.Unlock()
	return closed, nil
}

func (a *AMQP) teardown() {
	a.mu.Lock()
	conn := a.conn
	a.conn, a.ch = nil, nil
	a.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

// Publish marshals status to JSON and publishes it persistently. It returns
// ErrDisconnected (message dropped) while not connected.
func (a *AMQP) Publish(status any) error {
	body, err := json.Marshal(status)
	if err != nil {
		return err
	}
	a.mu.Lock()
	ch := a.ch
	a.mu.Unlock()
	if ch == nil {
		return ErrDisconnected
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return ch.PublishWithContext(ctx, a.exchange, "", false, false, amqp.Publishing{
		ContentType:  "application/json",
		DeliveryMode: amqp.Persistent,
		Timestamp:    time.Now(),
		Body:         body,
	})
}

// Close stops the reconnect loop and closes the connection.
func (a *AMQP) Close() error {
	a.once.Do(func() { close(a.stop) })
	<-a.done
	return nil
}
