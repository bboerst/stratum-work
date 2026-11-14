package main

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Ported from collector/tests/test_rmqsink.py.

var testRMQCfg = RabbitMQConfig{Host: "rabbitmq", Port: 5672, Username: "u", Password: "p", Exchange: "mining_notify_exchange"}

type fakeBroker struct {
	mu            sync.Mutex
	failConnects  int
	failPublishes int
	hang          time.Duration
	connects      int
	declared      []string
	published     []string // job ids
	exchanges     map[string]bool
	conns         []*fakeAMQPConn
}

type fakeAMQPConn struct {
	b      *fakeBroker
	closed atomic.Bool
}

type fakeAMQPChannel struct {
	c      *fakeAMQPConn
	closed atomic.Bool
}

func (b *fakeBroker) connect(RabbitMQConfig) (amqpConn, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.connects++
	if b.failConnects > 0 {
		b.failConnects--
		return nil, errors.New("connection refused")
	}
	c := &fakeAMQPConn{b: b}
	b.conns = append(b.conns, c)
	return c, nil
}

func (c *fakeAMQPConn) Channel() (amqpChannel, error) { return &fakeAMQPChannel{c: c}, nil }
func (c *fakeAMQPConn) IsClosed() bool                { return c.closed.Load() }
func (c *fakeAMQPConn) Close() error                  { c.closed.Store(true); return nil }

func (ch *fakeAMQPChannel) ExchangeDeclare(name, kind string, durable bool) error {
	ch.c.b.mu.Lock()
	defer ch.c.b.mu.Unlock()
	ch.c.b.declared = append(ch.c.b.declared, name+"/"+kind+"/"+map[bool]string{true: "durable", false: "transient"}[durable])
	return nil
}

func (ch *fakeAMQPChannel) Publish(exchange string, body []byte) error {
	b := ch.c.b
	b.mu.Lock()
	hang := b.hang
	b.mu.Unlock()
	if hang > 0 {
		time.Sleep(hang)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failPublishes > 0 {
		b.failPublishes--
		ch.closed.Store(true)
		return errors.New("connection reset by peer")
	}
	v, err := pyLoads(body)
	if err != nil {
		return err
	}
	job, _ := v.get("job_id")
	b.published = append(b.published, job.s)
	if b.exchanges == nil {
		b.exchanges = map[string]bool{}
	}
	b.exchanges[exchange] = true
	return nil
}

func (ch *fakeAMQPChannel) IsClosed() bool { return ch.closed.Load() || ch.c.closed.Load() }

func (b *fakeBroker) snapshot() (int, []string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.connects, append([]string(nil), b.published...)
}

func jobDoc(id string) *Document {
	d := testDoc(nil)
	d.Params[pJobID] = pyString(id)
	return d
}

func makePub(b *fakeBroker) *RabbitMQPublisher {
	p := NewRabbitMQPublisher(testRMQCfg, quietLog)
	p.connect = b.connect
	p.maxBackoff = 50 * time.Millisecond
	p.sleep = func(d time.Duration) { time.Sleep(min(d, 50*time.Millisecond)) }
	return p
}

func TestPublishesInOrderToTheFanoutExchange(t *testing.T) {
	b := &fakeBroker{}
	p := makePub(b).Start()
	for _, j := range []string{"j0", "j1", "j2", "j3", "j4"} {
		p.Submit(jobDoc(j))
	}
	if !waitFor(func() bool { _, pub := b.snapshot(); return len(pub) == 5 }, 5*time.Second) {
		t.Fatal("not published")
	}
	p.Close(time.Second)
	_, pub := b.snapshot()
	if want := "j0 j1 j2 j3 j4"; join(pub) != want {
		t.Error(pub)
	}
	if len(b.exchanges) != 1 || !b.exchanges["mining_notify_exchange"] || b.declared[0] != "mining_notify_exchange/fanout/durable" {
		t.Error(b.exchanges, b.declared)
	}
}

func join(s []string) string {
	out := ""
	for i, x := range s {
		if i > 0 {
			out += " "
		}
		out += x
	}
	return out
}

func TestSubmitNeverBlocksWhileTheBrokerHangs(t *testing.T) {
	b := &fakeBroker{hang: 2 * time.Second}
	p := makePub(b).Start()
	start := time.Now()
	for i := 0; i < 200; i++ {
		p.Submit(jobDoc("j"))
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Error("submit must return immediately")
	}
	p.Close(100 * time.Millisecond)
}

func TestSubmitNeverRaisesWhileTheBrokerIsDown(t *testing.T) {
	b := &fakeBroker{failConnects: 10_000}
	p := makePub(b).Start()
	for i := 0; i < 10; i++ {
		p.Submit(jobDoc("j"))
	}
	if !waitFor(func() bool { c, _ := b.snapshot(); return c >= 3 }, 5*time.Second) {
		t.Fatal("no reconnect attempts")
	}
	if p.Stats()["broker_errors"] < 3 {
		t.Error(p.Stats())
	}
	if _, pub := b.snapshot(); len(pub) != 0 {
		t.Error(pub)
	}
	p.Close(200 * time.Millisecond)
}

func TestReconnectsAndDeliversAfterTheBrokerReturns(t *testing.T) {
	b := &fakeBroker{failConnects: 3, failPublishes: 1}
	p := makePub(b).Start()
	for _, j := range []string{"j0", "j1", "j2"} {
		p.Submit(jobDoc(j))
	}
	if !waitFor(func() bool { _, pub := b.snapshot(); return len(pub) == 3 }, 5*time.Second) {
		t.Fatal(p.Stats())
	}
	p.Close(time.Second)
	if _, pub := b.snapshot(); join(pub) != "j0 j1 j2" { // the failed one requeued
		t.Error(pub)
	}
	if p.Stats()["reconnects"] < 4 {
		t.Error(p.Stats())
	}
}

func TestBackoffIsNotCutShortByNewSubmissions(t *testing.T) {
	b := &fakeBroker{failConnects: 10_000}
	p := NewRabbitMQPublisher(testRMQCfg, quietLog) // real sleep
	p.connect = b.connect
	p.maxBackoff = time.Second
	p.Start()
	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) { // a template every 10 ms during the outage
		p.Submit(jobDoc("x"))
		time.Sleep(10 * time.Millisecond)
	}
	if c, _ := b.snapshot(); c > 4 {
		t.Errorf("%d connect attempts in 1.5 s", c)
	}
	p.Close(200 * time.Millisecond)
}

func TestQueueOverflowDropsTheOldestAndCountsIt(t *testing.T) {
	p := makePub(&fakeBroker{failConnects: 10_000}) // not started
	p.maxQueue = 10
	for i := 0; i < 25; i++ {
		p.Submit(jobDoc("j" + string(rune('a'+i))))
	}
	if p.Queued() != 10 || p.Stats()["dropped_queue_full"] != 15 || p.queue[0].doc.Params[pJobID].s != "jp" {
		t.Error(p.Queued(), p.Stats())
	}
}

func TestStaleMessagesAreDroppedNotPublishedLate(t *testing.T) {
	now := time.Unix(1000, 0)
	var mu sync.Mutex
	b := &fakeBroker{}
	p := makePub(b)
	p.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	p.Submit(jobDoc("old"))
	mu.Lock()
	now = now.Add(61 * time.Second) // it waited out a broker outage
	mu.Unlock()
	p.Submit(jobDoc("fresh"))
	p.Start()
	if !waitFor(func() bool { _, pub := b.snapshot(); return len(pub) == 1 }, 5*time.Second) {
		t.Fatal(p.Stats())
	}
	p.Close(time.Second)
	if _, pub := b.snapshot(); pub[0] != "fresh" || p.Stats()["dropped_stale"] != 1 {
		t.Error(pub, p.Stats())
	}
}

// Python test_unserializable_documents_are_dropped_and_counted: a Document always serializes (JSON never fails),
// so the counter exists for parity and stays 0.
func TestUnserializableCounterExists(t *testing.T) {
	if _, ok := makePub(&fakeBroker{}).Stats()["dropped_unserializable"]; !ok {
		t.Error("missing counter")
	}
}

// Python test_idle_publisher_services_heartbeats: amqp091 answers heartbeats on its own goroutine; what the idle
// loop must do is notice a dropped connection and reconnect without any traffic.
func TestIdlePublisherReconnectsADroppedConnection(t *testing.T) {
	b := &fakeBroker{}
	p := makePub(b).Start()
	if !waitFor(func() bool { c, _ := b.snapshot(); return c == 1 }, 3*time.Second) {
		t.Fatal("no initial connect")
	}
	b.mu.Lock()
	b.conns[0].closed.Store(true) // broker dropped it
	b.mu.Unlock()
	if !waitFor(func() bool { c, _ := b.snapshot(); return c == 2 }, 3*time.Second) {
		t.Error("idle publisher did not reconnect")
	}
	p.Close(time.Second)
}

func TestSubmitIsThreadSafe(t *testing.T) {
	b := &fakeBroker{}
	p := makePub(b).Start()
	var wg sync.WaitGroup
	for g := 0; g < 4; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 100; i++ {
				p.Submit(jobDoc("x"))
			}
		}()
	}
	wg.Wait()
	if !waitFor(func() bool { _, pub := b.snapshot(); return len(pub) == 400 }, 5*time.Second) {
		t.Fatal(p.Stats())
	}
	p.Close(time.Second)
	if p.Stats()["submitted"] != 400 {
		t.Error(p.Stats())
	}
}
