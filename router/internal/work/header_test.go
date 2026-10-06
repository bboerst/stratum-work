package work

import (
	"encoding/hex"
	"testing"
)

// Bitcoin block 125552 (well-known header vector).
func TestHeaderHashBlock125552(t *testing.T) {
	prevDisplay := "00000000000008a3a41b85b8b29ad444def299fee21793cd8b9e567eab02cd81"
	merkleDisplay := "2b12fcf1b09288fcaff797d71e950e71ae42b91e8bdb2304758dfcffc2b620e3"
	stratumPrev := DisplayToStratumPrevHash(prevDisplay)
	var root [32]byte
	copy(root[:], reverse(mustHex(merkleDisplay)))
	h, err := BuildHeader(1, stratumPrev, root, "4dd7f5c7", "1a44b9f2", "9546a142")
	if err != nil {
		t.Fatal(err)
	}
	hash := DoubleSHA256(h[:])
	got := hex.EncodeToString(reverse(hash[:]))
	want := "00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d"
	if got != want {
		t.Fatalf("hash = %s want %s", got, want)
	}
}

func TestMerkleRootNoBranches(t *testing.T) {
	cb := mustHex("01000000")
	root, err := MerkleRoot(cb, nil)
	if err != nil {
		t.Fatal(err)
	}
	if root != DoubleSHA256(cb) {
		t.Fatal("root with no branches must equal coinbase txid")
	}
}

func TestRolledVersion(t *testing.T) {
	if v := RolledVersion(0x20000000, 0x1fffe000|0x7, 0x1fffe000); v != 0x3fffe000 {
		t.Fatalf("got %x", v)
	}
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}
