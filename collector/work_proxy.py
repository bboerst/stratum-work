"""Work mode: a Stratum V1 proxy that owns one pool account and serves one router.

The upstream pool session is kept open permanently (reconnecting with backoff);
the router connects downstream, authenticates with the shared internal token and
receives the pool's extranonce1/extranonce2_size, difficulty and jobs verbatim.
Submits are forwarded under the pool username and every pool verdict is
published as a ``share`` message; every job is published as a ``mode=work``
template.
"""

import dataclasses
import hmac
import itertools
import json
import logging
import queue
import socket
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlparse

try:
    import pika
except ImportError:  # pragma: no cover - exercised in lightweight test envs
    pika = None

LOG = logging.getLogger(__name__)

VERSION_ROLLING_MASK = "1fffe000"
CONFIGURE_PARAMS = [
    ["version-rolling"],
    {"version-rolling.mask": VERSION_ROLLING_MASK, "version-rolling.min-bit-count": 2},
]
SUBSCRIPTION_IDS = [["mining.notify", "w"], ["mining.set_difficulty", "w"]]
FORWARDED_METHODS = (
    "mining.notify",
    "mining.set_difficulty",
    "mining.set_extranonce",
    "mining.set_version_mask",
)

ERR_OTHER = [20, "Other/Unknown", None]
ERR_UPSTREAM_DOWN = [20, "Upstream unavailable", None]
ERR_UPSTREAM_LOST = [20, "Upstream disconnected", None]
ERR_UPSTREAM_TIMEOUT = [20, "Upstream timeout", None]
ERR_UNAUTHORIZED = [24, "Unauthorized worker", None]

MAX_LINE_BYTES = 64 * 1024


def _default_document_factory(*args, **kwargs):
    try:
        from collector.main import create_notification_document
    except ImportError:  # pragma: no cover - allows `python3 collector/main.py`
        from main import create_notification_document  # type: ignore
    return create_notification_document(*args, **kwargs)


class _LineReader:
    """Newline-delimited JSON reader. Records the wall-clock time of each recv."""

    def __init__(self, sock, max_line=MAX_LINE_BYTES):
        self.sock = sock
        self.buf = b""
        self.max_line = max_line
        self.last_recv_ts_ns = time.time_ns()

    def next(self):
        while True:
            while b"\n" not in self.buf:
                if len(self.buf) > self.max_line:
                    raise EOFError("line too long")
                data = self.sock.recv(4096)
                if not data:
                    raise EOFError("connection closed")
                self.buf += data
                self.last_recv_ts_ns = time.time_ns()
            line, self.buf = self.buf.split(b"\n", 1)
            if len(line) > self.max_line:
                raise EOFError("line too long")
            if not line.strip():
                continue
            try:
                return json.loads(line)
            except ValueError:
                LOG.debug("Skipping undecodable line (%d bytes)", len(line))


def _send_line(sock, obj):
    sock.sendall((json.dumps(obj) + "\n").encode())


def _reject_reason(resp):
    """Element 1 of a stratum error array (or a JSON-RPC 2 error message); else None."""
    error = resp.get("error")
    if isinstance(error, (list, tuple)) and len(error) >= 2 and error[1] is not None:
        return str(error[1])
    if isinstance(error, dict) and error.get("message") is not None:
        return str(error["message"])
    return None


class _Session:
    """A downstream connection. Only an authorized one becomes the proxy's router session.

    Never call send()/reply() while holding WorkProxy._lock: a stuck router must not
    stall the upstream reader. Lock order is ``send_lock`` -> ``WorkProxy._lock``.
    """

    def __init__(self, sock, addr):
        self.sock = sock
        self.addr = addr
        self.send_lock = threading.Lock()
        self._close_lock = threading.Lock()
        self.authorized = False
        self._closed = threading.Event()

    @property
    def closed(self):
        return self._closed.is_set()

    def _write(self, obj):
        _send_line(self.sock, obj)

    def send(self, obj):
        if self.closed:
            return False
        try:
            with self.send_lock:
                self._write(obj)
            return True
        except OSError as e:  # includes socket.timeout: a partial write leaves the stream unusable
            LOG.warning("Send to router %s failed: %s; closing", self.addr[0], e)
            self.close()
            return False

    def send_locked(self, obj):
        """send() for callers already holding send_lock."""
        if self.closed:
            return False
        try:
            self._write(obj)
            return True
        except OSError as e:
            LOG.warning("Send to router %s failed: %s; closing", self.addr[0], e)
            self.close()
            return False

    def reply(self, req_id, result=None, error=None):
        return self.send({"id": req_id, "result": result, "error": error})

    def close(self):
        with self._close_lock:
            if self._closed.is_set():
                return
            self._closed.set()
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


@dataclass
class _PendingSubmit:
    session: _Session
    downstream_id: object
    job_id: object
    sent_monotonic_ns: int
    difficulty: object


class WorkProxy:
    def __init__(
        self,
        pool_url,
        username,
        password,
        token,
        publisher,
        meta,
        pool_name,
        *,
        document_factory=None,
        user_agent=None,
        backoff_initial=1.0,
        backoff_max=30.0,
        handshake_timeout=15.0,
        read_timeout=180.0,
        ready_timeout=10.0,
        submit_timeout=120.0,
        send_timeout=10.0,
    ):
        purl = urlparse(pool_url)
        if purl.scheme != "stratum+tcp" or purl.hostname is None or purl.port is None:
            raise ValueError("pool URL must be stratum+tcp://host:port")
        self.pool_host = purl.hostname
        self.pool_port = purl.port
        self.username = username
        self._password = password
        self._token = token.encode() if isinstance(token, str) else token
        if not self._token:
            raise ValueError("work token is required")
        self.publisher = publisher
        self.meta = meta
        self.pool_name = pool_name
        self.document_factory = document_factory or _default_document_factory
        self.user_agent = user_agent
        self.port = None
        self.backoff_initial = backoff_initial
        self.backoff_max = backoff_max
        self.handshake_timeout = handshake_timeout
        self.read_timeout = read_timeout
        self.ready_timeout = ready_timeout
        self.submit_timeout = submit_timeout
        self.send_timeout = send_timeout

        # Guards upstream cache, pending submits, the router session and _conns.
        self._lock = threading.RLock()
        self._up_send_lock = threading.Lock()
        self._ids = itertools.count(1)
        self._up_sock = None
        self._ready = threading.Event()
        self._stop = threading.Event()
        self.en1 = None
        self.en2size = None
        self.configure_result = None
        self.difficulty = None
        self.latest_notify = None
        self._pending = {}
        self._session = None  # the authorized router connection
        self._conns = set()  # every open downstream connection
        self._listener = None
        self._threads = []

    # ------------------------------------------------------------------ lifecycle

    def start(self, listen_port, host="0.0.0.0"):
        """Start the upstream loop and the downstream listener (daemon threads); return the bound port."""
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((host, listen_port))
        listener.listen(4)
        # close() does not wake a blocked accept() on every platform.
        listener.settimeout(0.5)
        self._listener = listener
        for target, name in ((self._upstream_loop, "work-upstream"), (self._accept_loop, "work-accept")):
            t = threading.Thread(target=target, name=f"{name}-{self.pool_name}", daemon=True)
            t.start()
            self._threads.append(t)
        self.port = listener.getsockname()[1]
        LOG.info("Work proxy for %s listening on %s:%s", self.pool_name, host, self.port)
        return self.port

    def serve(self, listen_port, host="0.0.0.0"):
        """Blocking: start() and wait until stop()."""
        self.start(listen_port, host=host)
        try:
            while not self._stop.wait(1.0):
                pass
        finally:
            self.stop()

    def stop(self):
        self._stop.set()
        if self._listener is not None:
            try:
                self._listener.close()
            except OSError:
                pass
        with self._lock:
            self._session = None
            conns, self._conns = list(self._conns), set()
        for conn in conns:
            conn.close()
        self._close_upstream_socket()
        for t in self._threads:
            t.join(timeout=2.0)

    # ------------------------------------------------------------------ upstream

    def _upstream_loop(self):
        delay = self.backoff_initial
        while not self._stop.is_set():
            handshook = False
            try:
                reader = self._connect_upstream()
                handshook = True
                delay = self.backoff_initial
                while not self._stop.is_set():
                    self._handle_upstream(reader.next(), reader.last_recv_ts_ns)
            except Exception as e:
                if self._stop.is_set():
                    break
                LOG.warning("Upstream %s connection error: %s", self.pool_name, e)
            finally:
                self._drop_upstream()
            if self._stop.wait(delay):
                break
            if not handshook:
                delay = min(delay * 2, self.backoff_max)

    def _connect_upstream(self):
        LOG.info("Connecting to upstream %s:%s", self.pool_host, self.pool_port)
        sock = socket.create_connection((self.pool_host, self.pool_port), timeout=self.handshake_timeout)
        with self._lock:
            self._up_sock = sock
        self._record_endpoint_ip(sock)
        reader = _LineReader(sock)

        configure_id = self._send_upstream("mining.configure", CONFIGURE_PARAMS)
        try:
            resp = self._await_response(reader, configure_id)
        except socket.timeout:
            LOG.warning("Upstream %s did not answer mining.configure", self.pool_name)
            resp = {}
        result = resp.get("result")
        if isinstance(result, dict) and result.get("version-rolling") is True and not resp.get("error"):
            configure_result = dict(result)
        else:
            LOG.warning("Upstream %s rejected version rolling", self.pool_name)
            configure_result = {"version-rolling": False}

        subscribe_params = [self.user_agent] if self.user_agent else []
        resp = self._await_response(reader, self._send_upstream("mining.subscribe", subscribe_params))
        result = resp.get("result")
        if resp.get("error") or not isinstance(result, list) or len(result) < 2:
            raise RuntimeError(f"subscribe rejected: {resp.get('error')}")
        en1, en2size = result[-2], result[-1]

        resp = self._await_response(reader, self._send_upstream("mining.authorize", [self.username, self._password]))
        if resp.get("result") is not True:
            raise RuntimeError(f"authorize rejected: {resp.get('error')}")

        sock.settimeout(self.read_timeout)
        # The router session was already closed by _drop_upstream when the previous
        # upstream session ended, so it resubscribes against this one.
        with self._lock:
            self.en1, self.en2size = en1, en2size
            self.configure_result = configure_result
            self._ready.set()
        LOG.info("Upstream %s ready: extranonce1=%s extranonce2_size=%s", self.pool_name, en1, en2size)
        return reader

    def _record_endpoint_ip(self, sock):
        if self.meta is None:
            return
        try:
            self.meta = dataclasses.replace(self.meta, endpoint_ip=sock.getpeername()[0])
        except OSError as e:
            LOG.debug("Could not read pool endpoint IP: %s", e)

    def _send_upstream(self, method, params):
        with self._up_send_lock:
            sock = self._up_sock
            if sock is None:
                raise ConnectionError("upstream not connected")
            req_id = next(self._ids)
            _send_line(sock, {"id": req_id, "method": method, "params": params})
        return req_id

    def _await_response(self, reader, req_id):
        while True:
            msg = reader.next()
            if isinstance(msg, dict) and msg.get("id") == req_id and not msg.get("method"):
                return msg
            self._handle_upstream(msg, reader.last_recv_ts_ns)

    def _handle_upstream(self, msg, receipt_ts_ns):
        if not isinstance(msg, dict):
            return
        # Also expire here so stale submits are answered even when no new submits arrive.
        self._expire_pending()
        method = msg.get("method")
        if method:
            self._handle_upstream_notification(method, msg.get("params") or [], receipt_ts_ns)
            return
        with self._lock:
            pending = self._pending.pop(msg.get("id"), None)
        if pending is None:
            LOG.debug("Ignoring upstream response id=%s", msg.get("id"))
            return
        self._complete_submit(pending, msg, receipt_ts_ns)

    def _handle_upstream_notification(self, method, params, receipt_ts_ns):
        if method not in FORWARDED_METHODS:
            LOG.info("Upstream %s notification: %s", self.pool_name, method)
            return
        with self._lock:
            if method == "mining.notify":
                if len(params) < 9:
                    LOG.warning("Ignoring malformed mining.notify from %s", self.pool_name)
                    return
                self.latest_notify = params
            elif method == "mining.set_difficulty":
                self.difficulty = params[0] if params else None
            elif method == "mining.set_extranonce":
                if len(params) >= 2:
                    self.en1, self.en2size = params[0], params[1]
            elif method == "mining.set_version_mask":
                if params and (self.configure_result or {}).get("version-rolling") is True:
                    self.configure_result = {**self.configure_result, "version-rolling.mask": params[0]}
            en1, en2size = self.en1, self.en2size
            session = self._authorized_session()
        if session is not None:
            session.send({"id": None, "method": method, "params": params})
        if method == "mining.notify":
            LOG.info("mining.notify job_id=%s clean=%s", params[0], params[8])
            document = self.document_factory(
                {"params": params}, self.pool_name, en1, en2size,
                hex(receipt_ts_ns)[2:], meta=self.meta,
            )
            self._publish(document)
        elif method == "mining.set_difficulty":
            LOG.info("mining.set_difficulty: %s", self.difficulty)

    def _complete_submit(self, pending, resp, receipt_ts_ns):
        accepted = resp.get("result") is True and not resp.get("error")
        response_ms = (time.monotonic_ns() - pending.sent_monotonic_ns) / 1e6
        share = {
            "type": "share",
            "timestamp": hex(receipt_ts_ns)[2:],
            "pool_name": self.pool_name,
            "site": self.meta.site if self.meta else None,
            "connection_id": self.meta.connection_id if self.meta else None,
            "mode": "work",
            "account": self.meta.account if self.meta and self.meta.account else self.username,
            "job_id": pending.job_id,
            "share_difficulty": None,
            "pool_difficulty": pending.difficulty,
            "accepted": accepted,
            "reject_reason": None if accepted else _reject_reason(resp),
            "response_ms": response_ms,
        }
        pending.session.send({"id": pending.downstream_id, "result": resp.get("result"), "error": resp.get("error")})
        self._publish(share)

    def _drop_upstream(self):
        self._close_upstream_socket()
        with self._lock:
            was_ready = self._ready.is_set()
            self._ready.clear()
            self.latest_notify = None
            self.difficulty = None
            pending, self._pending = self._pending, {}
            # On losing a ready session, close every downstream connection so the
            # router sees the target go down (fails over / backs off) and later
            # resubscribes for the new en1. Failed retries while already down
            # leave connections alone; they are refused by authorize.
            conns = []
            if was_ready:
                self._session = None
                conns, self._conns = list(self._conns), set()
        for p in pending.values():
            p.session.reply(p.downstream_id, error=ERR_UPSTREAM_LOST)
        if conns:
            LOG.info("Upstream %s down; closing %d downstream connection(s)", self.pool_name, len(conns))
        for conn in conns:
            conn.close()

    def _close_upstream_socket(self):
        with self._up_send_lock:
            sock, self._up_sock = self._up_sock, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            sock.close()

    def _publish(self, message):
        try:
            self.publisher.publish(message)
        except Exception as e:
            LOG.error("Publish failed: %s", e)

    # ------------------------------------------------------------------ downstream

    def _authorized_session(self):
        session = self._session
        if session is not None and session.authorized and not session.closed:
            return session
        return None

    def _accept_loop(self):
        while not self._stop.is_set():
            try:
                sock, addr = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                if self._stop.is_set():
                    break
                time.sleep(0.1)
                continue
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            # Bounds blocking sends: a router that stops reading is closed rather
            # than stalling the upstream reader.
            sock.settimeout(self.send_timeout)
            session = _Session(sock, addr)
            with self._lock:
                self._conns.add(session)
            LOG.info("Downstream connection from %s", addr[0])
            threading.Thread(
                target=self._serve_session, args=(session,),
                name=f"work-downstream-{self.pool_name}", daemon=True,
            ).start()

    def _serve_session(self, session):
        reader = _LineReader(session.sock)
        try:
            while not session.closed and not self._stop.is_set():
                try:
                    msg = reader.next()
                except socket.timeout:
                    continue
                if isinstance(msg, dict):
                    self._handle_downstream(session, msg)
        except (EOFError, OSError) as e:
            LOG.info("Downstream connection from %s closed: %s", session.addr[0], e)
        finally:
            session.close()
            with self._lock:
                self._conns.discard(session)
                if self._session is session:
                    self._session = None

    def _handle_downstream(self, session, msg):
        req_id = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or []
        if method == "mining.configure":
            if not self._ready.wait(self.ready_timeout):
                session.reply(req_id, error=ERR_UPSTREAM_DOWN)
                return
            with self._lock:
                result = dict(self.configure_result)
            session.reply(req_id, result)
        elif method == "mining.subscribe":
            if not self._ready.wait(self.ready_timeout):
                session.reply(req_id, error=ERR_UPSTREAM_DOWN)
                return
            with self._lock:
                en1, en2size = self.en1, self.en2size
            session.reply(req_id, [SUBSCRIPTION_IDS, en1, en2size])
        elif method == "mining.authorize":
            self._authorize(session, req_id, params)
        elif method in ("mining.extranonce.subscribe", "mining.suggest_difficulty"):
            session.reply(req_id, True)
        elif method == "mining.submit":
            self._forward_submit(session, req_id, params)
        else:
            session.reply(req_id, error=ERR_OTHER)

    def _authorize(self, session, req_id, params):
        if not self._token_matches(params):
            LOG.warning("Downstream from %s failed token authentication", session.addr[0])
            self._reject_authorize(session, req_id)
            return
        # Hold the session's send lock across promotion and the initial
        # difficulty/notify so no forwarded notification can overtake them.
        with session.send_lock:
            with self._lock:
                if not self._ready.is_set():
                    old = None
                    promoted = False
                else:
                    promoted = True
                    old, self._session = self._session, session
                    session.authorized = True
                    difficulty, notify = self.difficulty, self.latest_notify
            if not promoted:
                LOG.warning("Refusing router from %s: upstream %s unavailable", session.addr[0], self.pool_name)
            else:
                session.send_locked({"id": req_id, "result": True, "error": None})
                if difficulty is not None:
                    session.send_locked({"id": None, "method": "mining.set_difficulty", "params": [difficulty]})
                if notify is not None:
                    session.send_locked({"id": None, "method": "mining.notify", "params": notify})
        if not promoted:
            self._reject_authorize(session, req_id)
            return
        if old is not None and old is not session:
            LOG.info("Router from %s replaces %s", session.addr[0], old.addr[0])
            old.close()
        LOG.info("Router from %s authorized", session.addr[0])

    @staticmethod
    def _reject_authorize(session, req_id):
        session.reply(req_id, False)
        session.close()

    def _token_matches(self, params):
        supplied = params[1] if len(params) >= 2 else None
        if not isinstance(supplied, str):
            return False
        return hmac.compare_digest(supplied.encode(), self._token)

    def _forward_submit(self, session, req_id, params):
        if not session.authorized:
            session.reply(req_id, error=ERR_UNAUTHORIZED)
            return
        if not isinstance(params, list) or len(params) < 5:
            session.reply(req_id, error=ERR_OTHER)
            return
        self._expire_pending()
        upstream_params = [self.username] + params[1:]
        with self._up_send_lock:
            sock = self._up_sock
            up_id = None
            if sock is not None and self._ready.is_set():
                up_id = next(self._ids)
                with self._lock:
                    self._pending[up_id] = _PendingSubmit(
                        session=session, downstream_id=req_id, job_id=params[1],
                        sent_monotonic_ns=time.monotonic_ns(), difficulty=self.difficulty,
                    )
                try:
                    _send_line(sock, {"id": up_id, "method": "mining.submit", "params": upstream_params})
                    return
                except OSError as e:
                    LOG.warning("Submit to upstream %s failed: %s", self.pool_name, e)
        if up_id is None:
            session.reply(req_id, error=ERR_UPSTREAM_DOWN)
            return
        with self._lock:
            pending = self._pending.pop(up_id, None)
        if pending is not None:
            session.reply(req_id, error=ERR_UPSTREAM_LOST)

    def _expire_pending(self):
        cutoff = time.monotonic_ns() - int(self.submit_timeout * 1e9)
        with self._lock:
            expired = [k for k, p in self._pending.items() if p.sent_monotonic_ns < cutoff]
            dropped = [self._pending.pop(k) for k in expired]
        for p in dropped:
            p.session.reply(p.downstream_id, error=ERR_UPSTREAM_TIMEOUT)


# ---------------------------------------------------------------------- publishers


class RabbitPublisher:
    def __init__(self, host, port, username, password, exchange, retries=5, retry_delay=5.0):
        if pika is None:
            raise RuntimeError("Missing optional dependency 'pika'")
        self.params = pika.ConnectionParameters(host, int(port), "/", pika.PlainCredentials(username, password))
        self.exchange = exchange
        self.retries = retries
        self.retry_delay = retry_delay
        self.connection = None
        self.channel = None

    def _connect(self):
        self.close()
        self.connection = pika.BlockingConnection(self.params)
        self.channel = self.connection.channel()
        self.channel.exchange_declare(exchange=self.exchange, exchange_type="fanout", durable=True)
        LOG.info("Connected to RabbitMQ")

    def publish(self, message):
        body = json.dumps(message)
        for attempt in range(self.retries):
            try:
                if self.channel is None:
                    self._connect()
                self.channel.basic_publish(exchange=self.exchange, routing_key="", body=body)
                return
            except Exception as e:
                LOG.error("RabbitMQ publish failed (attempt %s/%s): %s", attempt + 1, self.retries, e)
                self.channel = None
                if attempt < self.retries - 1:
                    time.sleep(self.retry_delay)
        LOG.error("Dropping %s message after %s attempts", message.get("type", "template"), self.retries)

    def close(self):
        if self.connection is not None:
            try:
                self.connection.close()
            except Exception:
                pass
        self.connection = None
        self.channel = None


class QueuedPublisher:
    """Publishes from a dedicated thread so broker stalls never block the stratum path."""

    def __init__(self, inner, maxsize=10000):
        self.inner = inner
        self.queue = queue.Queue(maxsize=maxsize)
        self.thread = threading.Thread(target=self._run, name="work-publisher", daemon=True)
        self.thread.start()

    def publish(self, message):
        try:
            self.queue.put_nowait(message)
        except queue.Full:
            LOG.error("Publish queue full; dropping %s message", message.get("type", "template"))

    def _run(self):
        while True:
            message = self.queue.get()
            try:
                self.inner.publish(message)
            except Exception as e:
                LOG.error("Publish failed: %s", e)


class NullPublisher:
    def publish(self, message):
        pass


def run(args, meta, document_factory=None, rabbitmq_enabled=True):
    username, _, password = args.userpass.partition(":")
    if rabbitmq_enabled:
        publisher = QueuedPublisher(RabbitPublisher(
            args.rabbitmq_host, args.rabbitmq_port, args.rabbitmq_username,
            args.rabbitmq_password, args.rabbitmq_exchange,
        ))
    else:
        LOG.info("RabbitMQ disabled; work mode will not publish templates or shares")
        publisher = NullPublisher()
    proxy = WorkProxy(
        args.url, username, password, args.work_token, publisher, meta, args.pool_name,
        document_factory=document_factory, user_agent=args.stratum_user_agent,
    )
    proxy.serve(args.stratum_client_port)
