package work

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
)

type Job struct {
	Version    uint32
	PrevHash   string
	Coinb1     string
	Coinb2     string
	Branches   []string
	NBits      string
	NTime      string
	Clean      bool
	UpstreamID string
}

func BuildCoinbase(coinb1, en1, en2, coinb2 string) ([]byte, error) {
	return hex.DecodeString(coinb1 + en1 + en2 + coinb2)
}

func MerkleRoot(coinbase []byte, branches []string) ([32]byte, error) {
	h := DoubleSHA256(coinbase)
	buf := make([]byte, 64)
	for _, b := range branches {
		br, err := hex.DecodeString(b)
		if err != nil || len(br) != 32 {
			return h, fmt.Errorf("bad merkle branch %q", b)
		}
		copy(buf[:32], h[:])
		copy(buf[32:], br)
		h = DoubleSHA256(buf)
	}
	return h, nil
}

func BuildHeader(version uint32, prevHashStratum string, merkleRoot [32]byte, ntime, nbits, nonce string) ([80]byte, error) {
	var h [80]byte
	prev, err := hex.DecodeString(prevHashStratum)
	if err != nil || len(prev) != 32 {
		return h, fmt.Errorf("bad prevhash")
	}
	nt, err1 := parseU32(ntime)
	nb, err2 := parseU32(nbits)
	nn, err3 := parseU32(nonce)
	if err1 != nil || err2 != nil || err3 != nil {
		return h, fmt.Errorf("bad ntime/nbits/nonce")
	}
	binary.LittleEndian.PutUint32(h[0:4], version)
	copy(h[4:36], swapWords(prev))
	copy(h[36:68], merkleRoot[:])
	binary.LittleEndian.PutUint32(h[68:72], nt)
	binary.LittleEndian.PutUint32(h[72:76], nb)
	binary.LittleEndian.PutUint32(h[76:80], nn)
	return h, nil
}

func RolledVersion(jobVersion, submitted, mask uint32) uint32 {
	return (jobVersion &^ mask) | (submitted & mask)
}
