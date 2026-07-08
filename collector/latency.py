"""Pool->collector latency estimation.

One-way latency cannot be measured without a clock synchronized to the pool
server, so it is estimated as RTT/2:

- Direct connections: kernel-smoothed TCP RTT (`TCP_INFO.tcpi_rtt`), sampled
  right after we send data. Excludes server processing time.
- SOCKS-proxied connections: application-level RTT of id-matched stratum
  requests (kernel RTT only measures the hop to the local proxy). The minimum
  over a small window approximates pure transmission delay.

RTT/2 assumes a symmetric path; asymmetry is not detectable client-side.
"""

import socket
import struct
import threading
from collections import deque

# tcpi_rtt (microseconds) is the 16th u32 after 8 leading u8 fields in
# struct tcp_info (linux/tcp.h). Layout is append-only, so parsing the first
# 104 bytes is stable across kernel versions.
_TCP_INFO_FMT = "B" * 8 + "I" * 24
_TCP_INFO_LEN = struct.calcsize(_TCP_INFO_FMT)
_TCP_INFO_RTT_INDEX = 8 + 15

MAX_REASONABLE_RTT_NS = 30_000_000_000  # 30 s


def parse_tcp_info_rtt_us(buf):
    """Extract tcpi_rtt (microseconds) from a raw TCP_INFO buffer."""
    if buf is None or len(buf) < _TCP_INFO_LEN:
        return None
    fields = struct.unpack(_TCP_INFO_FMT, buf[:_TCP_INFO_LEN])
    rtt_us = fields[_TCP_INFO_RTT_INDEX]
    return rtt_us if rtt_us > 0 else None


def sample_tcp_rtt_us(sock):
    """Read the kernel's current smoothed RTT for a connected TCP socket.

    Returns microseconds, or None when unavailable (non-Linux, closed
    socket, SOCKS sockets where it would be misleading, etc.).
    """
    if not hasattr(socket, "TCP_INFO"):
        return None
    try:
        buf = sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, _TCP_INFO_LEN)
    except (OSError, ValueError):
        return None
    return parse_tcp_info_rtt_us(buf)


class LatencyTracker:
    """Aggregates RTT samples for one pool connection.

    Thread-safe: the probe thread records sends while the socket reader
    resolves responses.
    """

    def __init__(self, proxied=False, app_window=8):
        self.proxied = proxied
        self._lock = threading.Lock()
        self._app_rtt_ns = deque(maxlen=app_window)
        self._tcp_rtt_ns = None
        self._pending = {}  # request id -> send time (monotonic ns)

    def reset(self):
        with self._lock:
            self._app_rtt_ns.clear()
            self._tcp_rtt_ns = None
            self._pending.clear()

    def record_send(self, request_id, send_monotonic_ns):
        with self._lock:
            self._pending[request_id] = send_monotonic_ns

    def try_resolve(self, msg, recv_monotonic_ns):
        """Consume a response to a tracked request. Returns True when `msg`
        answered a tracked request id (caller should not process it further
        as a notification)."""
        if not isinstance(msg, dict):
            return False
        request_id = msg.get("id")
        if request_id is None:
            return False
        with self._lock:
            send_ns = self._pending.pop(request_id, None)
            if send_ns is None:
                return False
            rtt_ns = recv_monotonic_ns - send_ns
            if 0 < rtt_ns <= MAX_REASONABLE_RTT_NS:
                self._app_rtt_ns.append(rtt_ns)
            return True

    def record_tcp_rtt_us(self, rtt_us):
        if rtt_us is None:
            return
        rtt_ns = rtt_us * 1_000
        if 0 < rtt_ns <= MAX_REASONABLE_RTT_NS:
            with self._lock:
                self._tcp_rtt_ns = rtt_ns

    def prune_pending(self, now_monotonic_ns, max_age_ns):
        with self._lock:
            self._pending = {
                rid: ts
                for rid, ts in self._pending.items()
                if now_monotonic_ns - ts <= max_age_ns
            }

    def estimate(self):
        """Best current one-way latency estimate.

        Returns (latency_ms, method) with method in {"tcp", "app"}, or None.
        """
        with self._lock:
            if not self.proxied and self._tcp_rtt_ns is not None:
                return (self._tcp_rtt_ns / 2 / 1e6, "tcp")
            if self._app_rtt_ns:
                return (min(self._app_rtt_ns) / 2 / 1e6, "app")
        return None
