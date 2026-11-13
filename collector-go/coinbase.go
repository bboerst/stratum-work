package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
)

// Port of collector/coinbase.py (parse_bip34_height). coinbase1 is the coinbase transaction up to the extranonce:
//
//	version (4) | [segwit marker 00 01] | input count (varint, = 1) | prevout (32 x 00 + ffffffff)
//	| scriptSig length (varint) | scriptSig ...      <- the BIP34 height push is the first scriptSig item
//
// Returns ok=false (never a guess) for invalid hex, a non-coinbase prevout, a truncated push, a negative number,
// or a scriptSig that doesn't start with a height.

var nullPrevout = append(bytes.Repeat([]byte{0}, 32), 0xff, 0xff, 0xff, 0xff)

func readVarint(data []byte, pos int) (uint64, int, bool) {
	if pos >= len(data) {
		return 0, 0, false
	}
	first := data[pos]
	switch {
	case first < 0xfd:
		return uint64(first), pos + 1, true
	case first == 0xfd:
		if pos+3 > len(data) {
			return 0, 0, false
		}
		return uint64(binary.LittleEndian.Uint16(data[pos+1:])), pos + 3, true
	case first == 0xfe:
		if pos+5 > len(data) {
			return 0, 0, false
		}
		return uint64(binary.LittleEndian.Uint32(data[pos+1:])), pos + 5, true
	default:
		if pos+9 > len(data) {
			return 0, 0, false
		}
		return binary.LittleEndian.Uint64(data[pos+1:]), pos + 9, true
	}
}

func parseBIP34Height(coinbase1Hex string) (int64, bool) {
	data, err := hex.DecodeString(coinbase1Hex)
	if err != nil {
		return 0, false
	}
	pos := 4 // version
	if pos+1 >= len(data) {
		return 0, false
	}
	if data[pos] == 0x00 && data[pos+1] == 0x01 { // segwit marker + flag
		pos += 2
	}
	nInputs, pos, ok := readVarint(data, pos)
	if !ok || nInputs != 1 || pos+36 > len(data) || !bytes.Equal(data[pos:pos+36], nullPrevout) {
		return 0, false
	}
	pos += 36
	scriptLen, pos, ok := readVarint(data, pos)
	if !ok || scriptLen == 0 || pos >= len(data) {
		return 0, false
	}
	op := int(data[pos])
	switch {
	case op >= 0x01 && op <= 0x08:
		end := pos + 1 + op
		if end > len(data) || uint64(op) > scriptLen-1 {
			return 0, false
		}
		push := data[pos+1 : end]
		if push[len(push)-1]&0x80 != 0 { // negative CScriptNum: never a valid height
			return 0, false
		}
		var v int64
		for i := len(push) - 1; i >= 0; i-- {
			v = v<<8 | int64(push[i])
		}
		return v, true
	case op >= 0x51 && op <= 0x60: // OP_1 .. OP_16
		return int64(op - 0x50), true
	}
	return 0, false
}
