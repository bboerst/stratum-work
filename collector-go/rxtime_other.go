//go:build !linux

package main

import "net"

// Non-Linux: no kernel receive timestamps (the line reader falls back to the clock after Read() returns) and no
// TCP_INFO RTT (latency falls back to the application-level probe).
type rxConn struct{}

func newRxConn(net.Conn) *rxConn                  { return nil }
func (r *rxConn) read([]byte) (int, int64, error) { return 0, 0, nil }
func sampleTCPRTTUs(net.Conn) (int64, bool)       { return 0, false }
