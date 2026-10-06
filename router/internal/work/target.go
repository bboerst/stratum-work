package work

import (
	"crypto/sha256"
	"math/big"
)

var diff1 = new(big.Int).Lsh(big.NewInt(0xFFFF), 208)

func DoubleSHA256(b []byte) [32]byte {
	f := sha256.Sum256(b)
	return sha256.Sum256(f[:])
}

func DiffToTarget(diff float64) *big.Int {
	if diff <= 0 {
		diff = 1e-12
	}
	t := new(big.Float).Quo(new(big.Float).SetInt(diff1), big.NewFloat(diff))
	out, _ := t.Int(nil)
	return out
}

func HashToBig(hash [32]byte) *big.Int {
	return new(big.Int).SetBytes(reverse(hash[:]))
}

func MeetsTarget(hash [32]byte, target *big.Int) bool {
	return HashToBig(hash).Cmp(target) <= 0
}

func HashDifficulty(hash [32]byte) float64 {
	h := HashToBig(hash)
	if h.Sign() == 0 {
		return 1e300
	}
	d, _ := new(big.Float).Quo(new(big.Float).SetInt(diff1), new(big.Float).SetInt(h)).Float64()
	return d
}
