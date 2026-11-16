package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/go-zeromq/zmq4"
)

// ZMQ subscribers for `sequence` and `rawtx`. Each runs in its own goroutine, stamps the receipt time right after
// the read returns (wall clock, UTC µs: the pure-Go ZMQ library gives no kernel receive timestamps), decodes, and
// hands the event to the recorder over a buffered channel. rawtx bodies are parsed here, off the state goroutine.

// decodeSequence decodes a sequence message's body and counter frame.
func decodeSequence(body, counter []byte, at int64) (SeqEvent, error) {
	if len(counter) != 4 {
		return SeqEvent{}, fmt.Errorf("sequence counter frame of %d bytes", len(counter))
	}
	if len(body) < 33 {
		return SeqEvent{}, fmt.Errorf("sequence body of %d bytes", len(body))
	}
	ev := SeqEvent{Kind: body[32], Hash: reversed32(body[:32]), ZSeq: binary.LittleEndian.Uint32(counter), At: at}
	switch ev.Kind {
	case 'A', 'R':
		if len(body) != 41 {
			return SeqEvent{}, fmt.Errorf("sequence %c body of %d bytes", ev.Kind, len(body))
		}
		ev.MSeq = binary.LittleEndian.Uint64(body[33:])
	case 'C', 'D':
		if len(body) != 33 {
			return SeqEvent{}, fmt.Errorf("sequence %c body of %d bytes", ev.Kind, len(body))
		}
	default:
		return SeqEvent{}, fmt.Errorf("unknown sequence type %q", ev.Kind)
	}
	return ev, nil
}

type Subscriber struct {
	Topic    string
	Endpoint string
	Retry    time.Duration
	Handle   func(body, counter []byte, at int64)
	log      *slog.Logger

	up       atomic.Bool
	messages atomic.Int64
}

func (s *Subscriber) Up() bool { return s.up.Load() }

func (s *Subscriber) Run(ctx context.Context) {
	for ctx.Err() == nil {
		err := s.follow(ctx)
		s.up.Store(false)
		if ctx.Err() != nil {
			return
		}
		s.log.Warn("ZMQ subscriber error, reconnecting", "topic", s.Topic, "endpoint", s.Endpoint, "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(s.Retry):
		}
	}
}

func (s *Subscriber) follow(ctx context.Context) error {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	sub := zmq4.NewSub(sctx, zmq4.WithAutomaticReconnect(true), zmq4.WithDialerRetry(s.Retry),
		zmq4.WithDialerMaxRetries(-1), zmq4.WithDialerTimeout(10*time.Second))
	defer sub.Close()
	if err := sub.SetOption(zmq4.OptionSubscribe, s.Topic); err != nil {
		return err
	}
	if err := sub.Dial(s.Endpoint); err != nil {
		return err
	}
	s.up.Store(true)
	s.log.Info("ZMQ subscribed", "topic", s.Topic, "endpoint", s.Endpoint)
	for {
		msg, err := sub.Recv()
		at := time.Now().UnixMicro()
		if err != nil {
			return err
		}
		if len(msg.Frames) != 3 || string(msg.Frames[0]) != s.Topic {
			continue
		}
		s.messages.Add(1)
		s.Handle(msg.Frames[1], msg.Frames[2], at)
	}
}

// Feeds wires both subscribers to the recorder's channels.
type Feeds struct {
	Seq, Raw *Subscriber
	SeqCh    chan SeqEvent
	RawCh    chan RawEvent
}

func NewFeeds(seqEndpoint, rawEndpoint string, keepRaw bool, m *Metrics, log *slog.Logger) *Feeds {
	f := &Feeds{SeqCh: make(chan SeqEvent, 200_000), RawCh: make(chan RawEvent, 50_000)}
	f.Seq = &Subscriber{Topic: "sequence", Endpoint: seqEndpoint, Retry: 5 * time.Second, log: log,
		Handle: func(body, counter []byte, at int64) {
			ev, err := decodeSequence(body, counter, at)
			if err != nil {
				log.Warn("undecodable sequence message", "err", err)
				return
			}
			f.SeqCh <- ev
		}}
	f.Raw = &Subscriber{Topic: "rawtx", Endpoint: rawEndpoint, Retry: 5 * time.Second, log: log,
		Handle: func(body, counter []byte, at int64) {
			if len(counter) != 4 {
				return
			}
			ev := RawEvent{ZSeq: binary.LittleEndian.Uint32(counter), At: at}
			tx, err := ParseTx(body, keepRaw)
			if err != nil {
				m.RawUnparsable.Add(1)
			} else {
				ev.Tx = tx
			}
			f.RawCh <- ev
		}}
	return f
}

// Start runs both subscribers (they reconnect on their own). WaitUp blocks until both are dialed, then a little
// longer for the subscriptions to reach the publisher (ZMQ's "slow joiner"): events published before that are lost
// without a counter gap, so the snapshot must come after.
func (f *Feeds) Start(ctx context.Context) {
	go f.Seq.Run(ctx)
	go f.Raw.Run(ctx)
}

func (f *Feeds) WaitUp(ctx context.Context, settle time.Duration) error {
	t := time.NewTicker(50 * time.Millisecond)
	defer t.Stop()
	for !f.Seq.Up() || !f.Raw.Up() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
	select {
	case <-time.After(settle):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (f *Feeds) Up() map[string]bool {
	return map[string]bool{"sequence": f.Seq.Up(), "rawtx": f.Raw.Up()}
}

func (f *Feeds) Messages() map[string]int64 {
	return map[string]int64{"sequence": f.Seq.messages.Load(), "rawtx": f.Raw.messages.Load()}
}
