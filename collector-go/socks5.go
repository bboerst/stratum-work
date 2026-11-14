package main

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"time"
)

// Minimal SOCKS5 CONNECT client (RFC 1928, no authentication), equivalent to the Python collector's PySocks setup
// (socks.SOCKS5 with rdns=True): IP literals are sent as addresses, names are resolved by the proxy.
//
// Implemented here instead of golang.org/x/net/proxy because the collector needs the raw *net.TCPConn to the
// proxy for kernel receive timestamps. Through a proxy, that timestamp is when the bytes arrived from the proxy on
// our socket: for a local proxy (e.g. Tor on the same host) it is a few µs after the proxy received them, but it
// cannot include the proxy's own delay or the path behind it. The Python collector's timestamp has the same
// meaning (plus its user-space delay).

func dialSOCKS5(ctx context.Context, proxyAddr, targetHost string, targetPort int, timeout time.Duration) (net.Conn, error) {
	d := net.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "tcp", proxyAddr)
	if err != nil {
		return nil, fmt.Errorf("socks5: connect to proxy %s: %w", proxyAddr, err)
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if err := socks5Handshake(conn, targetHost, targetPort); err != nil {
		conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

func socks5Handshake(rw io.ReadWriter, host string, port int) error {
	if _, err := rw.Write([]byte{5, 1, 0}); err != nil { // version 5, one method: no authentication
		return fmt.Errorf("socks5: %w", err)
	}
	var sel [2]byte
	if _, err := io.ReadFull(rw, sel[:]); err != nil {
		return fmt.Errorf("socks5: reading method selection: %w", err)
	}
	if sel[0] != 5 {
		return errors.New("socks5: proxy is not a SOCKS5 server")
	}
	if sel[1] != 0 {
		return errors.New("socks5: proxy requires authentication")
	}
	req := []byte{5, 1, 0} // CONNECT
	if ip, err := netip.ParseAddr(host); err == nil {
		if ip.Is4() {
			b := ip.As4()
			req = append(append(req, 1), b[:]...)
		} else {
			b := ip.As16()
			req = append(append(req, 4), b[:]...)
		}
	} else {
		if len(host) > 255 {
			return errors.New("socks5: host name too long")
		}
		req = append(append(req, 3, byte(len(host))), host...)
	}
	req = binary.BigEndian.AppendUint16(req, uint16(port))
	if _, err := rw.Write(req); err != nil {
		return fmt.Errorf("socks5: %w", err)
	}
	var hdr [4]byte
	if _, err := io.ReadFull(rw, hdr[:]); err != nil {
		return fmt.Errorf("socks5: reading reply: %w", err)
	}
	if hdr[0] != 5 {
		return errors.New("socks5: bad reply version")
	}
	if hdr[1] != 0 {
		return fmt.Errorf("socks5: connect to %s failed: %s", net.JoinHostPort(host, strconv.Itoa(port)), socks5Status(hdr[1]))
	}
	var skip int
	switch hdr[3] {
	case 1:
		skip = 4
	case 4:
		skip = 16
	case 3:
		var l [1]byte
		if _, err := io.ReadFull(rw, l[:]); err != nil {
			return fmt.Errorf("socks5: %w", err)
		}
		skip = int(l[0])
	default:
		return errors.New("socks5: bad address type in reply")
	}
	if _, err := io.ReadFull(rw, make([]byte, skip+2)); err != nil { // bound address + port
		return fmt.Errorf("socks5: %w", err)
	}
	return nil
}

func socks5Status(c byte) string {
	msgs := map[byte]string{1: "general failure", 2: "connection not allowed by ruleset", 3: "network unreachable",
		4: "host unreachable", 5: "connection refused", 6: "TTL expired", 7: "command not supported",
		8: "address type not supported"}
	if m, ok := msgs[c]; ok {
		return m
	}
	return fmt.Sprintf("status %d", c)
}
