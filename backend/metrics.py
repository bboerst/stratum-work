"""Prometheus metrics on /metrics (off unless BACKEND_METRICS_PORT is set).

Text format 0.0.4, written with the standard library like the collector's: two series don't need a client library.

- stratum_backend_zmq_block_saved_seconds (histogram): a ZMQ `hashblock`'s receipt (blocks.seen_at) to that block saved
  (after getblock, the analyses and the block processor's queue). Only blocks saved with seen_via "zmq".
- stratum_backend_reconcile_blocks_saved_total (counter): blocks saved as seen live with seen_via "reconcile": the
  best-chain reconciliation found them missing (ZMQ didn't announce them, e.g. a reorg's other blocks, or saving the
  announced block failed). Blocks mined while the backend was stopped are stored by the startup sync as synced and
  not counted.
- stratum_backend_template_sets_lowest_height (gauge): the lowest height the transaction-set counts reach, set by the
  in-process history walk (TEMPLATE_SETS_BACKFILL) after each chunk; absent until it has run.
"""
import bisect
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Sequence

logger = logging.getLogger("backend")

NS = "stratum_backend_"


def _fmt(v: float) -> str:
    if v == float("inf"):
        return "+Inf"
    return repr(float(v))


class Counter:
    def __init__(self, name: str, help_text: str):
        self.name, self.help = name, help_text
        self._lock = threading.Lock()
        self._value = 0.0

    def inc(self, n: float = 1) -> None:
        with self._lock:
            self._value += n

    @property
    def value(self) -> float:
        with self._lock:
            return self._value

    def render(self) -> str:
        return f"# HELP {self.name} {self.help}\n# TYPE {self.name} counter\n{self.name} {_fmt(self.value)}\n"


class Gauge:
    """A value set from time to time; not rendered until it has been set."""

    def __init__(self, name: str, help_text: str):
        self.name, self.help = name, help_text
        self._lock = threading.Lock()
        self._value = None

    def set(self, v: float) -> None:
        with self._lock:
            self._value = float(v)

    @property
    def value(self):
        with self._lock:
            return self._value

    def render(self) -> str:
        v = self.value
        if v is None:
            return ""
        return f"# HELP {self.name} {self.help}\n# TYPE {self.name} gauge\n{self.name} {_fmt(v)}\n"


class Histogram:
    def __init__(self, name: str, help_text: str, buckets: Sequence[float]):
        self.name, self.help = name, help_text
        self.bounds = sorted(buckets)
        self._lock = threading.Lock()
        self._counts = [0] * (len(self.bounds) + 1)   # per bucket (not cumulative); the last is +Inf
        self._sum = 0.0

    def observe(self, v: float) -> None:
        i = bisect.bisect_left(self.bounds, v)   # le: v <= bound
        with self._lock:
            self._counts[i] += 1
            self._sum += v

    def snapshot(self):
        """(cumulative counts per bound incl. +Inf, sum, count)."""
        with self._lock:
            counts, total = list(self._counts), self._sum
        cum, acc = [], 0
        for c in counts:
            acc += c
            cum.append(acc)
        return cum, total, acc

    def render(self) -> str:
        cum, total, count = self.snapshot()
        out = [f"# HELP {self.name} {self.help}", f"# TYPE {self.name} histogram"]
        for bound, c in zip(list(self.bounds) + [float("inf")], cum):
            out.append(f'{self.name}_bucket{{le="{_fmt(bound)}"}} {c}')
        out.append(f"{self.name}_sum {_fmt(total)}")
        out.append(f"{self.name}_count {count}")
        return "\n".join(out) + "\n"


# Typical saves take under a second; a slow node or a long queue has taken up to 40 s.
ZMQ_TO_SAVED_BUCKETS = (0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 7.5, 10, 20, 40)

zmq_block_saved_seconds = Histogram(
    NS + "zmq_block_saved_seconds",
    "Seconds from a ZMQ hashblock's receipt (blocks.seen_at) to the block saved, for blocks saved with seen_via zmq.",
    ZMQ_TO_SAVED_BUCKETS)
reconcile_blocks_saved_total = Counter(
    NS + "reconcile_blocks_saved_total",
    "Blocks saved as seen live with seen_via reconcile: found missing by the best-chain reconciliation, not via ZMQ.")

template_sets_lowest_height = Gauge(
    NS + "template_sets_lowest_height",
    "Lowest height the transaction-set counts reach, set by the in-process history walk after each chunk.")

REGISTRY = (zmq_block_saved_seconds, reconcile_blocks_saved_total, template_sets_lowest_height)


def render() -> str:
    return "".join(m.render() for m in REGISTRY)


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?", 1)[0] != "/metrics":
            self.send_error(404)
            return
        body = render().encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):   # no access log per scrape
        pass


def serve(port: int, host: str = "0.0.0.0") -> ThreadingHTTPServer:
    """Serve /metrics on a daemon thread. Returns the server (server_address has the bound port; port 0 = any)."""
    server = ThreadingHTTPServer((host, port), _Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True, name="metrics").start()
    logger.info("Metrics on :%d/metrics", server.server_address[1])
    return server
