"""Line cap (#105): a peer that sends data without a newline must not grow the collector's buffer without bound."""
import json
import socket
import threading
import time
import unittest

from collector import main as collector_main
from collector.main import MAX_LINE_BYTES, LineTooLong, append_capped
from collector.tests.test_latency_integration import NOTIFY_PARAMS, make_watcher


class ChunkSocket:
    """recv() hands out the given chunks, then b"" (EOF); records the largest buffer seen through the watcher."""

    def __init__(self, chunks):
        self.chunks = list(chunks)

    def recv(self, _n):
        return self.chunks.pop(0) if self.chunks else b""


def notify_line(job):
    return json.dumps({"id": None, "method": "mining.notify", "params": [job] + NOTIFY_PARAMS[1:]}).encode() + b"\n"


class AppendCappedTests(unittest.TestCase):
    def test_appends_below_the_cap(self):
        self.assertEqual(append_capped(b"ab", b"cd", "pool"), b"abcd")

    def test_raises_once_the_cap_is_passed_without_a_newline(self):
        with self.assertRaises(LineTooLong):
            append_capped(b"x" * MAX_LINE_BYTES, b"y", "pool")

    def test_a_newline_in_the_new_data_completes_the_line(self):
        self.assertTrue(append_capped(b"x" * MAX_LINE_BYTES, b"\n", "pool").endswith(b"\n"))

    def test_line_too_long_is_handled_like_a_dropped_connection(self):
        self.assertTrue(issubclass(LineTooLong, EOFError))


class GetMsgTests(unittest.TestCase):
    def test_endless_data_without_newline_is_cut_off_and_the_buffer_freed(self):
        w = make_watcher()
        chunk = b"x" * 4096
        w.sock = ChunkSocket([chunk] * (MAX_LINE_BYTES // 4096 + 50))
        start = time.monotonic()
        with self.assertRaises(LineTooLong):
            w.get_msg()
        self.assertLess(time.monotonic() - start, 5)
        self.assertEqual(w.buf, b"")
        self.assertGreater(len(w.sock.chunks), 0)  # stopped reading at the cap, not at EOF

    def test_lines_split_across_reads_and_sharing_a_read_still_parse(self):
        w = make_watcher()
        a, b = notify_line("a"), notify_line("b")
        data = a + b
        w.sock = ChunkSocket([data[:10], data[10:len(a) + 5], data[len(a) + 5:]])
        self.assertEqual(w.get_msg()[0]["params"][0], "a")
        self.assertEqual(w.get_msg()[0]["params"][0], "b")

    def test_a_large_line_within_the_cap_is_accepted(self):
        w = make_watcher()
        big = {"id": None, "method": "mining.notify",
               "params": ["big", "00" * 32, "ab" * (MAX_LINE_BYTES // 2 - 1024)] + NOTIFY_PARAMS[3:]}
        data = json.dumps(big).encode() + b"\n"
        self.assertLess(len(data), MAX_LINE_BYTES)
        w.sock = ChunkSocket([data[i:i + 4096] for i in range(0, len(data), 4096)])
        self.assertEqual(w.get_msg()[0]["params"][0], "big")

    def test_close_drops_a_partial_line(self):
        w = make_watcher()
        w.buf = b'{"partial'
        w.close()
        self.assertEqual(w.buf, b"")
        w.sock = ChunkSocket([notify_line("next")])
        self.assertEqual(w.get_msg()[0]["params"][0], "next")


class ProxyCapTests(unittest.TestCase):
    """The relay loop (stratum-client mode) caps both directions too."""

    def _run_proxy(self, pool_data=b"", client_data=b""):
        w = make_watcher()
        pool_side, w.sock = socket.socketpair()
        client_side, client_sock = socket.socketpair()
        t = threading.Thread(target=w.run_proxy, args=(client_sock,), daemon=True)
        t.start()
        for sock, data in ((pool_side, pool_data), (client_side, client_data)):
            if data:
                threading.Thread(target=self._send_quietly, args=(sock, data), daemon=True).start()
        t.join(10)
        alive = t.is_alive()
        for s in (pool_side, client_side, w.sock, client_sock):
            s.close()
        return alive

    @staticmethod
    def _send_quietly(sock, data):
        try:
            sock.sendall(data)
        except OSError:
            pass  # the proxy dropped the connection, as intended

    def test_pool_flood_without_newline_ends_the_relay(self):
        self.assertFalse(self._run_proxy(pool_data=b"x" * (MAX_LINE_BYTES + 65536)))

    def test_client_flood_without_newline_ends_the_relay(self):
        self.assertFalse(self._run_proxy(client_data=b"y" * (MAX_LINE_BYTES + 65536)))


if __name__ == "__main__":
    unittest.main()
