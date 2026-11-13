//go:build linux

package main

import (
	"errors"
	"net"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Kernel receive timestamps (SO_TIMESTAMPNS): the time the data reached the socket, taken by the kernel. Unlike a
// clock read after Read() returns, it doesn't move when our goroutine is scheduled late, the GC runs, or the read
// loop was busy with the previous message. For TCP, the timestamp returned with a recvmsg is that of the most
// recently received segment included in the read, i.e. the arrival of the bytes that completed the data returned.

type rxConn struct {
	raw  syscallConn
	oob  []byte
	ok   bool // SO_TIMESTAMPNS enabled
	last int64
}

type syscallConn interface {
	Read(func(fd uintptr) bool) error
	Control(func(fd uintptr)) error
}

func newRxConn(c net.Conn) *rxConn {
	tc, ok := c.(*net.TCPConn)
	if !ok {
		return nil
	}
	raw, err := tc.SyscallConn()
	if err != nil {
		return nil
	}
	r := &rxConn{raw: raw, oob: make([]byte, unix.CmsgSpace(int(unsafe.Sizeof(unix.Timespec{}))))}
	_ = raw.Control(func(fd uintptr) {
		r.ok = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_TIMESTAMPNS, 1) == nil
	})
	if !r.ok {
		return nil
	}
	return r
}

var errEOF = errors.New("EOF")

// read reads into p and returns (n, kernel receive time in ns or 0 if none was attached).
func (r *rxConn) read(p []byte) (int, int64, error) {
	var n, oobn int
	var rerr error
	err := r.raw.Read(func(fd uintptr) bool {
		n, oobn, _, _, rerr = unix.Recvmsg(int(fd), p, r.oob, 0)
		return !(rerr == unix.EAGAIN || rerr == unix.EWOULDBLOCK)
	})
	if err == nil {
		err = rerr
	}
	if err != nil {
		return 0, 0, err
	}
	if n == 0 {
		return 0, 0, errEOF
	}
	var ts int64
	if msgs, perr := unix.ParseSocketControlMessage(r.oob[:oobn]); perr == nil {
		for _, m := range msgs {
			if m.Header.Level == unix.SOL_SOCKET && m.Header.Type == unix.SCM_TIMESTAMPNS &&
				len(m.Data) >= int(unsafe.Sizeof(unix.Timespec{})) {
				t := (*unix.Timespec)(unsafe.Pointer(&m.Data[0]))
				ts = time.Unix(int64(t.Sec), int64(t.Nsec)).UnixNano()
			}
		}
	}
	return n, ts, nil
}
