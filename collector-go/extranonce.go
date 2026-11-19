package main

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Extranonce changes after the handshake (#263). A template's coinbase is coinbase1 + extranonce1 + extranonce2
// (extranonce2_length bytes) + coinbase2, so each template must carry the values in force when it was sent.
//
//   - mining.set_extranonce [extranonce1, extranonce2_size] replaces them for later jobs: applied (when valid) and
//     recorded as an ingest event of kind "extranonce", cause "set_extranonce".
//   - A response to the collector's own re-subscribe (latency probe, keep-alive) that carries other values is
//     recorded only (cause "resubscribe", applied false): the original subscription is assumed to stay in force,
//     and these rows check that assumption.
//
// Both run on the read goroutine, which also builds the documents, so no locking is needed.

// maxExtranonceBytes bounds what mining.set_extranonce may set: extranonce1's length and extranonce2_size.
const maxExtranonceBytes = 32

// checkSetExtranonce validates mining.set_extranonce params like a stored template's columns (extranonceColumns),
// plus sane sizes.
func checkSetExtranonce(p pyValue) error {
	if p.kind != pyList || len(p.items) != 2 {
		return errors.New("params: need [extranonce1, extranonce2_size]")
	}
	b, n, err := extranonceColumns(p.items[0], p.items[1])
	if err != nil {
		return err
	}
	if len(b) > maxExtranonceBytes {
		return fmt.Errorf("extranonce1: %d bytes, more than %d", len(b), maxExtranonceBytes)
	}
	if n < 0 || n > maxExtranonceBytes {
		return fmt.Errorf("extranonce2_size %d outside 0..%d", n, maxExtranonceBytes)
	}
	return nil
}

func sameExtranonce(en1, en2, old1, old2 pyValue) bool {
	return string(pyDumps(en1)) == string(pyDumps(old1)) && string(pyDumps(en2)) == string(pyDumps(old2))
}

// setExtranonce handles mining.set_extranonce. Invalid params are logged and recorded; the values stay as they were.
func (c *Collector) setExtranonce(msg pyValue, l line) {
	p, _ := msg.get("params")
	if err := checkSetExtranonce(p); err != nil {
		c.log.Warn("invalid mining.set_extranonce, ignored", "err", err, "params", truncate(string(pyDumps(p)), 300))
		c.extranonceEvent(l, "set_extranonce", false, map[string]any{
			"error": eventValue(pyString(err.Error())), "params": eventValue(p)})
		return
	}
	en1, en2 := p.items[0], p.items[1]
	if sameExtranonce(en1, en2, c.extranonce1, c.extranonce2) {
		c.log.Info("mining.set_extranonce with the values in force", "extranonce1", pyStrOf(en1),
			"extranonce2_length", pyStrOf(en2))
		return
	}
	c.log.Info("mining.set_extranonce applied", "old_extranonce1", pyStrOf(c.extranonce1),
		"old_extranonce2_length", pyStrOf(c.extranonce2), "extranonce1", pyStrOf(en1), "extranonce2_length", pyStrOf(en2))
	c.extranonceEvent(l, "set_extranonce", true, map[string]any{"new": extranonceDetail(en1, en2)})
	c.extranonce1, c.extranonce2 = en1, en2
}

// checkResubscribe compares a re-subscribe response with the values in force and records a difference (not applied).
func (c *Collector) checkResubscribe(msg pyValue, l line) {
	res, ok := msg.get("result")
	if !ok || res.kind != pyList || len(res.items) < 2 {
		return
	}
	en1, en2 := res.items[len(res.items)-2], res.items[len(res.items)-1]
	if sameExtranonce(en1, en2, c.extranonce1, c.extranonce2) {
		return
	}
	c.log.Info("re-subscribe response with other extranonce values, not applied", "extranonce1", pyStrOf(c.extranonce1),
		"extranonce2_length", pyStrOf(c.extranonce2), "response_extranonce1", truncate(pyStrOf(en1), 80),
		"response_extranonce2_length", truncate(pyStrOf(en2), 80))
	c.extranonceEvent(l, "resubscribe", false, map[string]any{"new": extranonceDetail(en1, en2)})
}

// extranonceEvent records one extranonce event at the line's receive time, with the values in force before it.
func (c *Collector) extranonceEvent(l line, cause string, applied bool, detail map[string]any) {
	detail["cause"] = cause
	detail["applied"] = applied
	detail["old"] = extranonceDetail(c.extranonce1, c.extranonce2)
	at := time.Unix(0, l.ts)
	c.event(IngestEvent{Kind: "extranonce", Start: at, End: at, Detail: detail})
}

func extranonceDetail(en1, en2 pyValue) map[string]any {
	return map[string]any{"extranonce1": eventValue(en1), "extranonce2_length": eventValue(en2)}
}

// eventValue is a pool-sent value as it goes into an event's jsonb detail: null, an integer or a short plain string
// as itself, anything else as its (ASCII, truncated) JSON text. jsonb refuses \u0000, and one refused row would
// drop the whole batch of events.
func eventValue(v pyValue) any {
	switch v.kind {
	case pyNull:
		return nil
	case pyInt:
		if n, err := strconv.ParseInt(v.s, 10, 64); err == nil {
			return n
		}
	case pyStr:
		if len(v.s) <= 128 && utf8.ValidString(v.s) && !strings.ContainsRune(v.s, 0) && !hasSurrogate(v.s) {
			return v.s
		}
	}
	return truncate(string(pyDumps(v)), 200)
}
