package main

import (
	"fmt"
	"strings"
	"testing"
)

// Ported 1:1 from collector/tests/test_coinbase.py.

var prefix = "01000000" + "01" + strings.Repeat("00", 32) + "ffffffff"

func cb1(script string, scriptLen int) string {
	n := scriptLen
	if n < 0 {
		n = len(script)/2 + 10
	}
	return "01000000" + "01" + strings.Repeat("00", 32) + "ffffffff" + fmt.Sprintf("%02x", n) + script
}

func TestRealMainnetCoinbase1Prefixes(t *testing.T) {
	for _, c := range []string{
		prefix + "560393e20e194d696e6564206279",
		prefix + "640393e20e2cfabe6d6dc5a4e656",
		"02000000" + "01" + strings.Repeat("00", 32) + "ffffffff" + "4c0393e20e01000c",
	} {
		if h, ok := parseBIP34Height(c); !ok || h != 975507 {
			t.Errorf("%s: got %d %v", c[:20], h, ok)
		}
	}
}

func TestHonorsPushLength(t *testing.T) {
	cases := map[string]int64{"023412aa": 0x1234, "04b1c2a300": 0x00A3C2B1, "0111": 0x11, "028000": 128, "51": 1, "60": 16}
	for script, want := range cases {
		if h, ok := parseBIP34Height(cb1(script, -1)); !ok || h != want {
			t.Errorf("%s: got %d %v, want %d", script, h, ok, want)
		}
	}
}

func TestReturnsNoneInsteadOfGuessing(t *testing.T) {
	cases := map[string]string{
		"not hex":                           strings.Repeat("zz", 50),
		"empty":                             "",
		"truncated before prevout":          "0100000001" + strings.Repeat("00", 10),
		"not a coinbase (non-null prevout)": "01000000" + "01" + strings.Repeat("11", 32) + "ffffffff" + "0a0393e20e",
		"two inputs":                        "01000000" + "02" + strings.Repeat("00", 32) + "ffffffff" + "0a0393e20e",
		"empty scriptSig":                   cb1("", 0),
		"truncated push":                    cb1("0393e2", 10),
		"push longer than scriptSig":        cb1("0393e20e", 2),
		"negative number":                   cb1("0393e28e", -1),
		"starts with a non-push opcode":     cb1("6a0393e20e", -1),
		"OP_0":                              cb1("00", -1),
	}
	for name, c := range cases {
		if h, ok := parseBIP34Height(c); ok {
			t.Errorf("%s: expected no height, got %d", name, h)
		}
	}
}

func TestVarintScriptLength(t *testing.T) {
	c := "01000000" + "01" + strings.Repeat("00", 32) + "ffffffff" + "fd0001" + "0393e20e"
	if h, ok := parseBIP34Height(c); !ok || h != 975507 {
		t.Errorf("got %d %v", h, ok)
	}
}
