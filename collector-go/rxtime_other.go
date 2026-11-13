//go:build !linux

package main

import "net"

// Non-Linux: no kernel receive timestamps; lineReader falls back to the clock after Read() returns.
type rxConn struct{}

func newRxConn(net.Conn) *rxConn                  { return nil }
func (r *rxConn) read([]byte) (int, int64, error) { return 0, 0, nil }
