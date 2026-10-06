package work

import (
	"encoding/hex"
	"strconv"
)

func reverse(b []byte) []byte {
	o := make([]byte, len(b))
	for i := range b {
		o[i] = b[len(b)-1-i]
	}
	return o
}

// DisplayToStratumPrevHash converts a display (big-endian) block hash to stratum mining.notify order.
func DisplayToStratumPrevHash(display string) string {
	raw, _ := hex.DecodeString(display)
	internal := reverse(raw) // header byte order
	return hex.EncodeToString(swapWords(internal))
}

// swapWords reverses the bytes of each 4-byte word (its own inverse).
func swapWords(b []byte) []byte {
	o := make([]byte, len(b))
	for i := 0; i+4 <= len(b); i += 4 {
		o[i], o[i+1], o[i+2], o[i+3] = b[i+3], b[i+2], b[i+1], b[i]
	}
	return o
}

func parseU32(h string) (uint32, error) {
	v, err := strconv.ParseUint(h, 16, 32)
	return uint32(v), err
}
