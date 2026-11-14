package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// Port of collector/rmqsink.py: a background, never-blocking publisher to a fanout exchange for the website's live
// view.
//   - Submit appends to a bounded queue and returns at once; when full, the oldest message is dropped (counted).
//   - Messages that waited longer than maxAge are dropped instead of being published late (counted).
//   - One goroutine owns the connection, publishes, and reconnects with exponential backoff (1 s -> 30 s). The
//     backoff waits only on Close, so a stream of new submissions can't turn it into a reconnect per template.
// The message body is json.dumps(document) exactly as the Python collector publishes it (Document.JSON).

type RabbitMQConfig struct {
	Host, Username, Password, Exchange string
	Port                               int
	Heartbeat                          time.Duration // 30 s
	BlockedConnectionTimeout           time.Duration // 30 s
	SocketTimeout                      time.Duration // 10 s (connect)
}

type amqpConn interface {
	Channel() (amqpChannel, error)
	IsClosed() bool
	Close() error
}

type amqpChannel interface {
	ExchangeDeclare(name, kind string, durable bool) error
	Publish(exchange string, body []byte) error
	IsClosed() bool
}

type rmqItem struct {
	enqueued time.Time
	doc      *Document
}

type RabbitMQPublisher struct {
	cfg           RabbitMQConfig
	maxQueue      int
	maxAge        time.Duration
	maxBackoff    time.Duration
	statsInterval time.Duration
	connect       func(RabbitMQConfig) (amqpConn, error)
	now           func() time.Time
	sleep         func(time.Duration) // backoff wait; returns early only on Close
	log           *slog.Logger

	mu     sync.Mutex
	cond   *sync.Cond
	queue  []rmqItem
	stop   bool
	stopCh chan struct{}
	done   chan struct{}
	stats  map[string]int64

	conn amqpConn
	ch   amqpChannel
}

var rmqStatKeys = []string{"submitted", "published", "dropped_queue_full", "dropped_stale", "dropped_unserializable",
	"broker_errors", "reconnects"}

func NewRabbitMQPublisher(cfg RabbitMQConfig, log *slog.Logger) *RabbitMQPublisher {
	p := &RabbitMQPublisher{cfg: cfg, maxQueue: 2000, maxAge: 60 * time.Second, maxBackoff: 30 * time.Second,
		statsInterval: 10 * time.Minute, connect: amqpDial, now: time.Now, log: log, stopCh: make(chan struct{}),
		done: make(chan struct{}), stats: map[string]int64{}}
	for _, k := range rmqStatKeys {
		p.stats[k] = 0
	}
	p.cond = sync.NewCond(&p.mu)
	p.sleep = func(d time.Duration) {
		select {
		case <-p.stopCh:
		case <-time.After(d):
		}
	}
	return p
}

func (p *RabbitMQPublisher) Start() *RabbitMQPublisher {
	go p.run()
	return p
}

// Submit queues a document for publishing. Never blocks on I/O.
func (p *RabbitMQPublisher) Submit(d *Document) {
	p.mu.Lock()
	if len(p.queue) >= p.maxQueue {
		p.queue[0] = rmqItem{}
		p.queue = p.queue[1:]
		p.stats["dropped_queue_full"]++
	}
	p.queue = append(p.queue, rmqItem{p.now(), d})
	p.stats["submitted"]++
	p.mu.Unlock()
	p.cond.Signal()
}

func (p *RabbitMQPublisher) Queued() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.queue)
}

func (p *RabbitMQPublisher) Stats() map[string]int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make(map[string]int64, len(p.stats))
	for k, v := range p.stats {
		out[k] = v
	}
	return out
}

func (p *RabbitMQPublisher) count(k string) {
	p.mu.Lock()
	p.stats[k]++
	p.mu.Unlock()
}

// Close stops the worker after a best-effort flush (waits at most timeout).
func (p *RabbitMQPublisher) Close(timeout time.Duration) {
	p.mu.Lock()
	if !p.stop {
		p.stop = true
		close(p.stopCh)
	}
	p.mu.Unlock()
	p.cond.Broadcast()
	select {
	case <-p.done:
	case <-time.After(timeout):
	}
}

// take returns the next item, or ok=false after ~1 s idle (so a dropped connection is noticed) or when stopping.
func (p *RabbitMQPublisher) take() (rmqItem, bool, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.queue) == 0 && !p.stop {
		t := time.AfterFunc(time.Second, p.cond.Broadcast)
		p.cond.Wait()
		t.Stop()
	}
	if len(p.queue) == 0 {
		return rmqItem{}, false, p.stop
	}
	it := p.queue[0]
	p.queue[0] = rmqItem{}
	p.queue = p.queue[1:]
	return it, true, p.stop
}

func (p *RabbitMQPublisher) requeueFront(it rmqItem) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.queue) >= p.maxQueue {
		p.stats["dropped_queue_full"]++
		return
	}
	p.queue = append([]rmqItem{it}, p.queue...)
}

func (p *RabbitMQPublisher) ensureConnected() error {
	if p.ch != nil && !p.ch.IsClosed() && p.conn != nil && !p.conn.IsClosed() {
		return nil
	}
	p.disconnect()
	conn, err := p.connect(p.cfg)
	if err != nil {
		return err
	}
	ch, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return err
	}
	if err := ch.ExchangeDeclare(p.cfg.Exchange, "fanout", true); err != nil {
		_ = conn.Close()
		return err
	}
	p.conn, p.ch = conn, ch
	p.log.Info("rabbitmq publisher connected", "host", p.cfg.Host, "port", p.cfg.Port, "exchange", p.cfg.Exchange)
	return nil
}

func (p *RabbitMQPublisher) disconnect() {
	if p.conn != nil && !p.conn.IsClosed() {
		_ = p.conn.Close()
	}
	p.conn, p.ch = nil, nil
}

func (p *RabbitMQPublisher) run() {
	defer close(p.done)
	defer p.disconnect()
	backoff := time.Second
	lastStats := p.now()
	for {
		if p.now().Sub(lastStats) >= p.statsInterval {
			lastStats = p.now()
			p.log.Info("rabbitmq publisher stats", "stats", fmtStats(p.Stats(), rmqStatKeys), "queued", p.Queued())
		}
		it, ok, stopping := p.take()
		err := p.ensureConnected()
		if err == nil {
			if !ok {
				if stopping {
					return
				}
				continue
			}
			if p.now().Sub(it.enqueued) > p.maxAge {
				p.count("dropped_stale") // realtime only: too late to be useful on the live view
				continue
			}
			if err = p.ch.Publish(p.cfg.Exchange, it.doc.JSON()); err == nil {
				p.count("published")
				backoff = time.Second
				continue
			}
		}
		p.count("broker_errors")
		if ok {
			p.requeueFront(it)
		}
		p.disconnect()
		if stopping {
			return
		}
		p.log.Warn("rabbitmq publisher: broker error; reconnecting", "err", err, "in", backoff, "queued", p.Queued())
		p.count("reconnects")
		p.sleep(backoff)
		backoff = min(backoff*2, p.maxBackoff)
	}
}

// ── amqp091 implementation ───────────────────────────────────────────────────────────────────────────────────────

type amqpRealConn struct {
	c       *amqp.Connection
	blocked chan amqp.Blocking
}

type amqpRealChannel struct{ ch *amqp.Channel }

func amqpDial(cfg RabbitMQConfig) (amqpConn, error) {
	// Credentials in amqp.Config (not a URL), so a dial error can't echo the password.
	uri := amqp.URI{Scheme: "amqp", Host: cfg.Host, Port: cfg.Port, Vhost: "/"}
	c, err := amqp.DialConfig(uri.String(), amqp.Config{
		SASL:      []amqp.Authentication{&amqp.PlainAuth{Username: cfg.Username, Password: cfg.Password}},
		Vhost:     "/",
		Heartbeat: cfg.Heartbeat,
		Locale:    "en_US",
		Dial:      amqp.DefaultDial(cfg.SocketTimeout),
		Properties: amqp.Table{
			"connection_name": "stratum-work-collector-go",
		},
	})
	if err != nil {
		var ae *amqp.Error
		if errors.As(err, &ae) {
			return nil, fmt.Errorf("amqp: %s (code %d)", ae.Reason, ae.Code)
		}
		var ne net.Error
		if errors.As(err, &ne) {
			return nil, ne
		}
		return nil, errors.New("amqp: dial failed")
	}
	rc := &amqpRealConn{c: c, blocked: c.NotifyBlocked(make(chan amqp.Blocking, 4))}
	go rc.watchBlocked(cfg.BlockedConnectionTimeout)
	return rc, nil
}

// watchBlocked closes a connection the broker keeps blocked (resource alarm) for longer than timeout, like pika's
// blocked_connection_timeout; the publisher then reconnects.
func (r *amqpRealConn) watchBlocked(timeout time.Duration) {
	var timer *time.Timer
	for b := range r.blocked {
		if timer != nil {
			timer.Stop()
			timer = nil
		}
		if b.Active {
			timer = time.AfterFunc(timeout, func() { _ = r.c.CloseDeadline(time.Now().Add(time.Second)) })
		}
	}
	if timer != nil {
		timer.Stop()
	}
}

func (r *amqpRealConn) Channel() (amqpChannel, error) {
	ch, err := r.c.Channel()
	if err != nil {
		return nil, err
	}
	return &amqpRealChannel{ch}, nil
}

func (r *amqpRealConn) IsClosed() bool { return r.c.IsClosed() }
func (r *amqpRealConn) Close() error   { return r.c.CloseDeadline(time.Now().Add(2 * time.Second)) }

func (c *amqpRealChannel) ExchangeDeclare(name, kind string, durable bool) error {
	return c.ch.ExchangeDeclare(name, kind, durable, false, false, false, nil)
}

func (c *amqpRealChannel) Publish(exchange string, body []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.ch.PublishWithContext(ctx, exchange, "", false, false, amqp.Publishing{Body: body})
}

func (c *amqpRealChannel) IsClosed() bool { return c.ch.IsClosed() }
