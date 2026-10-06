package main

import (
	"encoding/json"
	"testing"

	"github.com/bboerst/stratum-work/router/internal/work"
)

func TestDepositBits(t *testing.T) {
	const mask = 0x1fffe000
	if got := depositBits(0, mask); got != 0 {
		t.Fatalf("0 -> %08x", got)
	}
	if got := depositBits(1, mask); got != 0x00002000 {
		t.Fatalf("1 -> %08x", got)
	}
	if got := depositBits(3, mask); got != 0x00006000 {
		t.Fatalf("3 -> %08x", got)
	}
	if got := depositBits(0xffffffff, mask); got != mask {
		t.Fatalf("all -> %08x", got)
	}
}

func TestParseNotifyAndSearch(t *testing.T) {
	raw := `["j1","` + "00000000000000000000000000000000000000000000000000000000000abc01" + `",` +
		`"01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff20",` +
		`"ffffffff0100f2052a010000001976a914000000000000000000000000000000000000000088ac00000000",` +
		`["` + "0000000000000000000000000000000000000000000000000000000000001111" + `"],` +
		`"20000000","207fffff","66000000",true]`
	var params []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &params); err != nil {
		t.Fatal(err)
	}
	j, err := parseNotify(params)
	if err != nil {
		t.Fatal(err)
	}
	if j.ID != "j1" || j.Version != 0x20000000 || !j.Clean || len(j.Branches) != 1 {
		t.Fatalf("parsed %+v", j)
	}
	w := &workUnit{j: j, en1: "0102", en2Len: 6, mask: 0x1fffe000, target: work.DiffToTarget(0.001)}
	s, ok, err := search(w, 5, 1<<22, func() bool { return false })
	if err != nil || !ok {
		t.Fatalf("no share: ok=%v err=%v", ok, err)
	}
	if len(s.En2) != 12 || s.VersionBits == "" {
		t.Fatalf("share %+v", s)
	}
	var nonce uint32
	for _, c := range []byte(s.Nonce) {
		nonce <<= 4
		switch {
		case c >= '0' && c <= '9':
			nonce |= uint32(c - '0')
		default:
			nonce |= uint32(c-'a') + 10
		}
	}
	h, err := hashOne(w, s.En2, nonce, depositBits(5, w.mask))
	if err != nil || h != s.Hash || !work.MeetsTarget(h, w.target) {
		t.Fatalf("recomputed hash mismatch (err=%v)", err)
	}
	if aborted, ok, _ := search(w, 6, 1<<22, func() bool { return true }); ok {
		t.Fatalf("abort ignored: %+v", aborted)
	}
}
