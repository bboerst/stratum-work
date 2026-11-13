"""Non-blocking RabbitMQ publisher for mining.notify templates (#141).

RabbitMQ feeds the website's live view; history goes to the database. Publishing used to happen synchronously
inside the Stratum read loop (pika BlockingConnection + retries with sleeps), so a slow or flapping broker stalled
template collection and, after the retries ran out, raised out of the loop and forced a reconnect to the pool: a gap
in collected templates. This module gives publishing the same shape as the Postgres sink (pgsink.PostgresSink):

  * submit() appends to a bounded queue and returns immediately. It never blocks and never raises.
  * A background thread owns the one pika connection, publishes, and reconnects with exponential backoff.
  * Realtime semantics: when the queue is full the oldest message is dropped, and messages that waited longer than
    max_age_s are dropped instead of being published late. Both are counted, never silent.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable, Optional

LOG = logging.getLogger(__name__)

# pika logs every failed connection attempt at ERROR with a full traceback (three entries per attempt). The publisher
# catches those errors and logs one WARNING line per attempt with the exception type, so pika's own output during a
# broker outage is pure noise. The collector uses pika only through this module.
logging.getLogger("pika").setLevel(logging.CRITICAL)


@dataclass(frozen=True)
class RabbitMQConfig:
    host: str
    port: int
    username: str
    password: str
    exchange: str
    heartbeat_s: int = 30                  # broker and client detect a dead connection within ~2 heartbeats
    blocked_connection_timeout_s: float = 30.0
    socket_timeout_s: float = 10.0


class RabbitMQPublisher:
    """Background, never-blocking publisher to a fanout exchange."""

    def __init__(self, config: RabbitMQConfig, max_queue: int = 2_000, max_age_s: float = 60.0,
                 connect: Optional[Callable[[RabbitMQConfig], object]] = None, stats_interval: float = 600.0,
                 clock: Callable[[], float] = time.monotonic, max_backoff_s: float = 30.0):
        self.config = config
        self.max_age_s = max_age_s
        self.max_backoff_s = max_backoff_s
        self._connect_fn = connect or self._pika_connect
        self._clock = clock
        self._queue: deque = deque(maxlen=max_queue)   # (enqueued_at, document)
        self._cond = threading.Condition()
        self._stop = False
        self._stop_event = threading.Event()   # backoff waits on this, so new submissions can't cut it short
        self._conn = None
        self._channel = None
        self._thread: Optional[threading.Thread] = None
        self.stats_interval = stats_interval
        self._last_stats_log = clock()
        self.stats = {"submitted": 0, "published": 0, "dropped_queue_full": 0, "dropped_stale": 0,
                      "dropped_unserializable": 0, "broker_errors": 0, "reconnects": 0}

    # ── public ──────────────────────────────────────────────────────────────────────────────────────
    def start(self) -> "RabbitMQPublisher":
        self._thread = threading.Thread(target=self._run, name="rabbitmq-publisher", daemon=True)
        self._thread.start()
        return self

    def submit(self, document: dict) -> None:
        """Queue a document for publishing. Never blocks, never raises."""
        with self._cond:
            if len(self._queue) == self._queue.maxlen:
                self.stats["dropped_queue_full"] += 1
            self._queue.append((self._clock(), document))
            self.stats["submitted"] += 1
            self._cond.notify()

    def close(self, timeout: float = 5.0) -> None:
        """Stop the worker after a best-effort flush of what's queued."""
        with self._cond:
            self._stop = True
            self._cond.notify()
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout)
        self._disconnect()

    def queued(self) -> int:
        return len(self._queue)

    # ── worker ──────────────────────────────────────────────────────────────────────────────────────
    @staticmethod
    def _pika_connect(config: RabbitMQConfig):
        import pika  # the collector already depends on pika; imported here so tests can inject a fake
        params = pika.ConnectionParameters(
            host=config.host, port=config.port, virtual_host="/",
            credentials=pika.PlainCredentials(config.username, config.password),
            heartbeat=config.heartbeat_s, blocked_connection_timeout=config.blocked_connection_timeout_s,
            socket_timeout=config.socket_timeout_s, connection_attempts=1,
        )
        return pika.BlockingConnection(params)

    def _ensure_connected(self) -> None:
        if self._channel is not None and getattr(self._channel, "is_open", True):
            return
        self._disconnect()
        self._conn = self._connect_fn(self.config)
        self._channel = self._conn.channel()
        self._channel.exchange_declare(exchange=self.config.exchange, exchange_type="fanout", durable=True)
        LOG.info("RabbitMQ publisher connected to %s:%s (exchange %r)", self.config.host, self.config.port,
                 self.config.exchange)

    def _disconnect(self) -> None:
        conn, self._conn, self._channel = self._conn, None, None
        try:
            if conn is not None and getattr(conn, "is_open", True):
                conn.close()
        except Exception:  # pragma: no cover - best effort
            pass

    def _take(self) -> Optional[tuple]:
        """Next (enqueued_at, document), or None after ~1 s idle (so heartbeats get serviced) or on stop."""
        with self._cond:
            if not self._queue and not self._stop:
                self._cond.wait(timeout=1.0)
            return self._queue.popleft() if self._queue else None

    def _requeue_front(self, item: tuple) -> None:
        with self._cond:
            if len(self._queue) == self._queue.maxlen:
                self.stats["dropped_queue_full"] += 1
                return
            self._queue.appendleft(item)

    def _service_heartbeats(self) -> None:
        # A BlockingConnection only answers heartbeats while its owner calls into it. When idle, do that here.
        if self._conn is not None:
            self._conn.process_data_events(time_limit=0)

    def _publish(self, document: dict) -> None:
        try:
            body = json.dumps(document)
        except (TypeError, ValueError) as exc:
            self.stats["dropped_unserializable"] += 1
            LOG.warning("RabbitMQ publisher: dropping unserializable template (job_id=%r): %s",
                        document.get("job_id"), exc)
            return
        self._channel.basic_publish(exchange=self.config.exchange, routing_key="", body=body)
        self.stats["published"] += 1
        LOG.debug("Published mining.notify job_id=%s to RabbitMQ", document.get("job_id"))

    def _maybe_log_stats(self) -> None:
        if self._clock() - self._last_stats_log >= self.stats_interval:
            self._last_stats_log = self._clock()
            LOG.info("RabbitMQ publisher stats: %s, queued=%s", self.stats, self.queued())

    def _run(self) -> None:
        backoff = 1.0
        while True:
            self._maybe_log_stats()
            item = self._take()
            try:
                self._ensure_connected()
                if item is None:
                    if self._stop:
                        return
                    self._service_heartbeats()
                    continue
                enqueued_at, document = item
                if self._clock() - enqueued_at > self.max_age_s:
                    self.stats["dropped_stale"] += 1   # realtime only: too late to be useful on the live view
                    continue
                self._publish(document)
                backoff = 1.0
            except Exception as exc:
                self.stats["broker_errors"] += 1
                if item is not None:
                    self._requeue_front(item)
                self._disconnect()
                if self._stop:
                    return
                LOG.warning("RabbitMQ publisher: broker error (%s); reconnecting in %.0fs, %d queued",
                            type(exc).__name__, backoff, self.queued())
                self.stats["reconnects"] += 1
                self._sleep(backoff)
                backoff = min(backoff * 2, self.max_backoff_s)

    def _sleep(self, seconds: float) -> None:
        # Not self._cond: submit() notifies it for every template, which would turn the backoff into a reconnect
        # attempt per template while the broker is down. Only close() ends the wait early.
        self._stop_event.wait(timeout=seconds)
