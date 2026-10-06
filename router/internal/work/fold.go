package work

import (
	"fmt"
	"strings"
)

type Fold struct {
	PrefixLen   int
	DownEn2Size int
	Pad         string
}

func PlanFold(targetEn2Size, prefixLen, downEn2Size int) (Fold, error) {
	padLen := targetEn2Size - prefixLen - downEn2Size
	if padLen < 0 {
		return Fold{}, fmt.Errorf("target extranonce2 size %d < prefix %d + downstream %d", targetEn2Size, prefixLen, downEn2Size)
	}
	return Fold{PrefixLen: prefixLen, DownEn2Size: downEn2Size, Pad: strings.Repeat("00", padLen)}, nil
}

func DownstreamCoinbase(job Job, targetEn1 string, f Fold) (string, string) {
	return job.Coinb1 + targetEn1, f.Pad + job.Coinb2
}

func UpstreamEn2(prefix, downEn2 string, f Fold) string {
	return prefix + downEn2 + f.Pad
}

func DownEn2Size(targetEn2Sizes []int, prefixLen int) (int, error) {
	if len(targetEn2Sizes) == 0 {
		return 0, fmt.Errorf("no targets")
	}
	min := targetEn2Sizes[0]
	for _, s := range targetEn2Sizes[1:] {
		if s < min {
			min = s
		}
	}
	if min-prefixLen < 2 {
		return 0, fmt.Errorf("smallest extranonce2 size %d leaves < 2 bytes downstream", min)
	}
	return min - prefixLen, nil
}
