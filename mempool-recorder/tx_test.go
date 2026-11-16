package main

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

type vectors struct {
	Txs []struct {
		Desc, Hex, Txid, Wtxid string
		Size, Vsize, Weight    int
		FirstPrevoutTxid       string `json:"first_prevout_txid"`
		FirstPrevoutVout       uint32 `json:"first_prevout_vout"`
	}
	Genesis struct {
		Hex, Hash    string
		CoinbaseTxid string `json:"coinbase_txid"`
	} `json:"genesis_block"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestParseTxMainnetVectors(t *testing.T) {
	for _, v := range loadVectors(t).Txs {
		raw, _ := hex.DecodeString(v.Hex)
		tx, err := ParseTx(raw, true)
		if err != nil {
			t.Fatalf("%s: %v", v.Desc, err)
		}
		if tx.Txid.Display() != v.Txid || tx.Wtxid.Display() != v.Wtxid {
			t.Errorf("%s: txid %s wtxid %s, want %s %s", v.Desc, tx.Txid, tx.Wtxid, v.Txid, v.Wtxid)
		}
		if tx.Size != v.Size || tx.Weight != v.Weight || tx.VSize() != v.Vsize {
			t.Errorf("%s: size %d weight %d vsize %d, want %d %d %d", v.Desc, tx.Size, tx.Weight, tx.VSize(), v.Size, v.Weight, v.Vsize)
		}
		if h, n := tx.Input(0); h.Display() != v.FirstPrevoutTxid || n != v.FirstPrevoutVout {
			t.Errorf("%s: first prevout %s:%d, want %s:%d", v.Desc, h, n, v.FirstPrevoutTxid, v.FirstPrevoutVout)
		}
		if string(tx.Raw) != string(raw) {
			t.Errorf("%s: raw bytes not kept", v.Desc)
		}
		// Truncations and trailing bytes are errors, never panics.
		for i := range raw {
			if _, err := ParseTx(raw[:i], false); err == nil {
				t.Fatalf("%s: truncated to %d bytes parsed", v.Desc, i)
			}
		}
		if _, err := ParseTx(append(append([]byte(nil), raw...), 0), false); err == nil {
			t.Errorf("%s: trailing byte accepted", v.Desc)
		}
	}
}

// Byte order: the genesis coinbase txid is displayed as 4a5e1e4b...; internally (in the block's merkle tree, and so
// in Stratum merkle_branches) its bytes are reversed: 3ba3edfd... The recorder stores the internal order.
func TestHashByteOrder(t *testing.T) {
	v := loadVectors(t).Genesis
	raw, _ := hex.DecodeString(v.Hex)
	blk, err := ParseBlock(raw)
	if err != nil {
		t.Fatal(err)
	}
	if blk.Hash.Display() != v.Hash || len(blk.Txs) != 1 {
		t.Fatalf("block %s with %d txs", blk.Hash, len(blk.Txs))
	}
	cb := blk.Txs[0].Txid
	if cb.Display() != v.CoinbaseTxid {
		t.Fatalf("coinbase txid %s, want %s", cb, v.CoinbaseTxid)
	}
	const internal = "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a"
	if hex.EncodeToString(cb[:]) != internal {
		t.Errorf("internal bytes %x, want %s", cb[:], internal)
	}
	// The genesis merkle root (header bytes 36..68) is the coinbase txid in internal order.
	if hex.EncodeToString(raw[36:68]) != internal {
		t.Errorf("merkle root in header %x", raw[36:68])
	}
	p, err := ParseDisplayHash(v.CoinbaseTxid)
	if err != nil || p != cb {
		t.Errorf("ParseDisplayHash round trip: %v %v", p, err)
	}
	if _, err := ParseDisplayHash("zz"); err == nil {
		t.Error("bad hash accepted")
	}
}

func TestParseBlockRejectsGarbage(t *testing.T) {
	raw, _ := hex.DecodeString(loadVectors(t).Genesis.Hex)
	for i := range raw {
		if _, err := ParseBlock(raw[:i]); err == nil {
			t.Fatalf("truncated block (%d bytes) parsed", i)
		}
	}
	bad := append([]byte(nil), raw...)
	bad[80] = 0xff // absurd transaction count
	if _, err := ParseBlock(bad); err == nil {
		t.Error("absurd count accepted")
	}
}

func FuzzParseTx(f *testing.F) {
	for _, v := range []string{"0100000001", "02000000000101"} {
		b, _ := hex.DecodeString(v)
		f.Add(b)
	}
	f.Fuzz(func(_ *testing.T, b []byte) { _, _ = ParseTx(b, false) })
}
