import argparse
import json
import logging
import threading
import socket
import sys
import time
import uuid
from datetime import datetime
from urllib.parse import urlparse
import select

try:
    import pika
except ImportError:  # pragma: no cover - exercised in lightweight test envs
    pika = None

try:
    from pymongo import MongoClient
except ImportError:  # pragma: no cover - exercised in lightweight test envs
    MongoClient = None

try:
    from pycoin.symbols.btc import network
except ImportError:  # pragma: no cover - exercised in lightweight test envs
    network = None

try:
    import socks
except ImportError:  # pragma: no cover - exercised in lightweight test envs
    socks = None

try:
    import zmq
except ImportError:  # pragma: no cover - exercised in lightweight test envs
    zmq = None

try:
    from collector.chain_detection import (
        BCHConfirmationCache,
        BCHConfirmer,
        ChainClassifier,
        TipState,
    )
except ImportError:  # pragma: no cover - allows `python3 collector/main.py`
    from chain_detection import (  # type: ignore
        BCHConfirmationCache,
        BCHConfirmer,
        ChainClassifier,
        TipState,
    )

LOG = logging.getLogger()

tip_state = TipState(
    current_height=None,
    last_update_monotonic=None,
    stale_after_seconds=1800,
)
bch_confirmer = BCHConfirmer(
    "https://api.blockchair.com/bitcoin-cash/raw/block",
    3.0,
    BCHConfirmationCache(),
)
chain_classifier = ChainClassifier(
    tip_state=tip_state,
    divergence_threshold=5,
    confirmer=bch_confirmer,
)
tip_state_lock = threading.Lock()
mongo_client_lock = threading.Lock()
cached_mongo_client = None
cached_mongo_collection = None
cached_mongo_config = None


def require_dependency(module, name):
    if module is None:
        raise RuntimeError(f"Missing optional dependency '{name}'")
    return module


def configure_chain_detection(args):
    tip_state.stale_after_seconds = args.btc_tip_stale_seconds
    chain_classifier.divergence_threshold = args.btc_chain_divergence_threshold
    bch_confirmer.api_base_url = args.bch_confirmation_url.rstrip("/")
    bch_confirmer.timeout_seconds = args.bch_confirmation_timeout


def update_tip_state(height):
    with tip_state_lock:
        tip_state.current_height = height
        tip_state.last_update_monotonic = time.monotonic()


def close_rpc_connection(conn):
    raw_conn = getattr(conn, "_AuthServiceProxy__conn", None)
    raw_close = getattr(raw_conn, "close", None)
    if callable(raw_close):
        raw_close()
        return

    close_method = getattr(conn, "close", None)
    if callable(close_method):
        close_method()


def normalize_mongo_host(db_url):
    host = db_url
    for prefix in ("mongodb+srv://", "mongodb://"):
        if host.startswith(prefix):
            return host[len(prefix):]
    return host


def get_mongo_collection(db_url, db_name, db_username, db_password):
    require_dependency(MongoClient, "pymongo")
    global cached_mongo_client, cached_mongo_collection, cached_mongo_config

    config = (db_url, db_name, db_username, db_password)
    with mongo_client_lock:
        if cached_mongo_collection is not None and cached_mongo_config == config:
            return cached_mongo_collection

        if cached_mongo_client is not None:
            cached_mongo_client.close()

        host = normalize_mongo_host(db_url)
        cached_mongo_client = MongoClient(
            f"mongodb://{db_username}:{db_password}@{host}"
        )
        cached_mongo_collection = cached_mongo_client[db_name]["mining_notify"]
        cached_mongo_config = config
        return cached_mongo_collection


def close_cached_mongo_client():
    global cached_mongo_client, cached_mongo_collection, cached_mongo_config

    with mongo_client_lock:
        if cached_mongo_client is not None:
            cached_mongo_client.close()
        cached_mongo_client = None
        cached_mongo_collection = None
        cached_mongo_config = None


def fetch_local_btc_tip_height(args):
    try:
        from bitcoinrpc.authproxy import AuthServiceProxy
    except ImportError as exc:  # pragma: no cover - depends on local env
        raise RuntimeError("Missing optional dependency 'python-bitcoinrpc'") from exc

    rpc_url = (
        f"http://{args.bitcoin_rpc_user}:{args.bitcoin_rpc_password}"
        f"@{args.bitcoin_rpc_host}:{args.bitcoin_rpc_port}"
    )
    conn = AuthServiceProxy(rpc_url, timeout=args.bitcoin_rpc_timeout)
    try:
        return int(conn.getblockcount())
    finally:
        close_rpc_connection(conn)


def initialize_tip_state(args):
    height = fetch_local_btc_tip_height(args)
    update_tip_state(height)
    LOG.info("Initialized BTC tip state at height %s", height)


def listen_for_btc_tip_updates(args):
    require_dependency(zmq, "pyzmq")
    context = zmq.Context.instance()
    while True:
        socket_obj = None
        try:
            socket_obj = context.socket(zmq.SUB)
            socket_obj.setsockopt(zmq.SUBSCRIBE, b"rawblock")
            socket_obj.setsockopt(zmq.SUBSCRIBE, b"hashblock")
            socket_obj.connect(args.bitcoin_zmq_block)
            LOG.info("BTC tip listener connected to %s", args.bitcoin_zmq_block)
            while True:
                parts = socket_obj.recv_multipart()
                if len(parts) < 2:
                    continue
                height = fetch_local_btc_tip_height(args)
                update_tip_state(height)
                LOG.debug("Updated BTC tip state to height %s", height)
        except Exception as exc:
            LOG.warning("BTC tip listener error: %s", exc)
            time.sleep(5)
        finally:
            if socket_obj is not None:
                socket_obj.close()


def start_tip_listener(args):
    if zmq is None:
        LOG.warning("BTC tip listener unavailable: missing optional dependency 'pyzmq'")
        return None
    listener = threading.Thread(
        target=listen_for_btc_tip_updates,
        args=(args,),
        name="btc-tip-listener",
        daemon=True,
    )
    listener.start()
    return listener


def classify_notification_chain(height: int, prev_hash: str) -> str | None:
    try:
        if height <= 0 or not prev_hash:
            return None
        with tip_state_lock:
            return chain_classifier.classify(height=height, prev_hash=prev_hash)
    except Exception as exc:
        LOG.warning(
            "Chain classification skipped for height=%s prev_hash=%s: %s",
            height,
            prev_hash[:16],
            exc,
        )
        return None

class Watcher:
    def __init__(self, url, userpass, pool_name, rabbitmq_host, rabbitmq_port, rabbitmq_username, rabbitmq_password, rabbitmq_exchange, db_url, db_name, db_username, db_password, use_proxy=False, proxy_host=None, proxy_port=None, enable_stratum_client=False, stratum_client_port=None, rabbitmq_enabled=True, db_enabled=True):
        self.buf = b""
        self.id = 1
        self.userpass = userpass
        self.pool_name = pool_name
        self.rabbitmq_exchange = rabbitmq_exchange
        self.rabbitmq_host = rabbitmq_host
        self.rabbitmq_port = rabbitmq_port
        self.rabbitmq_username = rabbitmq_username
        self.rabbitmq_password = rabbitmq_password
        self.rabbitmq_exchange = rabbitmq_exchange
        self.rabbitmq_enabled = rabbitmq_enabled
        self.db_url = db_url
        self.db_name = db_name
        self.db_username = db_username
        self.db_password = db_password
        self.db_enabled = db_enabled
        self.purl = self.parse_url(url)
        self.extranonce1 = None
        self.extranonce2_length = -1
        self.pending_notifications = []
        self.current_difficulty = None
        self.use_proxy = use_proxy
        self.proxy_host = proxy_host
        self.proxy_port = proxy_port
        self.sock = None
        self.connection = None
        self.channel = None
        self.max_retries = 5
        self.retry_delay = 5
        self.enable_stratum_client = enable_stratum_client
        self.stratum_client_port = stratum_client_port
        self.avg_rtt = 0  # Exponential moving average of RTT in nanoseconds
        self.last_recv_ts_ns = 0

    def parse_url(self, url):
        purl = urlparse(url)
        if purl.scheme != "stratum+tcp":
            raise ValueError(
                f"Unrecognized scheme {purl.scheme}, only 'stratum+tcp' is allowed"
            )
        if purl.hostname is None:
            raise ValueError(f"No hostname provided")
        if purl.port is None:
            raise ValueError(f"No port provided")
        if purl.path != "":
            raise ValueError(f"URL has a path {purl.path}, this is not valid")
        return purl

    def init_socket(self):
        LOG.info("Initializing socket")
        if self.use_proxy:
            require_dependency(socks, "PySocks")
            LOG.info(f"Using proxy: {self.proxy_host}:{self.proxy_port}")
            self.sock = socks.socksocket()
            self.sock.set_proxy(socks.SOCKS5, self.proxy_host, self.proxy_port)
        else:
            LOG.info("Using direct connection")
            self.sock = socket.socket()
        self.sock.settimeout(600)
        LOG.info("Socket initialized with 600 seconds timeout")

    def close(self):
        if self.sock:
            LOG.info(f"Closing connection to {self.purl.geturl()}")
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
                LOG.info("Socket shutdown successful")
            except OSError as e:
                LOG.warning(f"Error during socket shutdown: {e}")
            self.sock.close()
            LOG.info(f"Socket closed. Disconnected from {self.purl.geturl()}")
        self.sock = None

    def get_msg(self):
        """Return (parsed_msg, receipt_ts_ns). Timestamp is captured at the
        exact moment the socket read returns."""
        while True:
            while b"\n" not in self.buf:
                try:
                    new_buf = self.sock.recv(4096)
                    if len(new_buf) == 0:
                        raise EOFError
                    self.buf += new_buf
                    # Capture the timestamp of the actual network receive event
                    self.last_recv_ts_ns = time.time_ns()
                except Exception as e:
                    LOG.debug(f"Error receiving data: {e}")
                    raise EOFError

            line, self.buf = self.buf.split(b"\n", 1)
            
            if not line:
                continue

            receipt_ts_ns = getattr(self, 'last_recv_ts_ns', time.time_ns())

            try:
                resp = json.loads(line)
                return resp, receipt_ts_ns
            except Exception as e:
                LOG.debug(f"Error decoding JSON: {e} | raw ({len(line)} bytes): {line[:500]}")
                # If we fail to decode, skip this garbage line and try the next one
                continue

    def send_jsonrpc(self, method, params):
        request_id = self.id
        data = {
            "id": request_id,
            "method": method,
            "params": params,
        }
        self.id += 1

        LOG.debug(f"Sending: {data}")
        json_data = json.dumps(data) + "\n"
        self.sock.send(json_data.encode())
        rtt_start = time.time_ns()

        while True:
            msg, ts = self.get_msg()
            if isinstance(msg, dict) and msg.get("id") == request_id:
                LOG.debug(f"Received response for request {request_id}: {msg}")
                # Calculate RTT and update EMA
                rtt = time.time_ns() - rtt_start
                if self.avg_rtt == 0:
                    self.avg_rtt = rtt
                else:
                    self.avg_rtt = int(self.avg_rtt * 0.8 + rtt * 0.2)
                return msg
            LOG.info(f"Queued server notification while awaiting response {request_id}: {msg}")
            self.pending_notifications.append((msg, ts))

    def connect_to_rabbitmq(self):
        require_dependency(pika, "pika")
        for attempt in range(self.max_retries):
            try:
                credentials = pika.PlainCredentials(self.rabbitmq_username, self.rabbitmq_password)
                self.connection = pika.BlockingConnection(pika.ConnectionParameters(self.rabbitmq_host, self.rabbitmq_port, '/', credentials))
                self.channel = self.connection.channel()
                self.channel.exchange_declare(exchange=self.rabbitmq_exchange, exchange_type='fanout', durable=True)
                LOG.info("Successfully connected to RabbitMQ")
                return
            except Exception as e:
                LOG.error(f"Failed to connect to RabbitMQ (attempt {attempt + 1}/{self.max_retries}): {e}")
                if attempt < self.max_retries - 1:
                    time.sleep(self.retry_delay)
                else:
                    raise

    def publish_to_rabbitmq(self, message):
        for attempt in range(self.max_retries):
            try:
                LOG.info(f"Publishing message to RabbitMQ: {json.dumps(message)}")
                self.channel.basic_publish(exchange=self.rabbitmq_exchange, routing_key='', body=json.dumps(message))
                return
            except Exception as e:
                LOG.error(f"Failed to publish to RabbitMQ (attempt {attempt + 1}/{self.max_retries}): {e}")
                if attempt < self.max_retries - 1:
                    time.sleep(self.retry_delay)
                    self.connect_to_rabbitmq()  # Try to reconnect
                else:
                    raise

    def connect_to_stratum(self):
        for attempt in range(self.max_retries):
            try:
                self.init_socket()
                # Reset RTT average on new connection
                self.avg_rtt = 0
                LOG.info(f"Attempting to connect to {self.purl.hostname}:{self.purl.port}")
                self.sock.connect((self.purl.hostname, self.purl.port))
                LOG.info(f"Successfully connected to server {self.purl.geturl()}")

                if not self.enable_stratum_client:
                    LOG.info("Sending mining.subscribe request")
                    sub_resp = self.send_jsonrpc("mining.subscribe", [])
                    if sub_resp.get("error"):
                        LOG.warning(f"Subscribe error from pool: {sub_resp}")
                    if sub_resp.get("result") is not None:
                        self.extranonce1, self.extranonce2_length = sub_resp["result"][-2:]
                        LOG.info(f"Subscribed: extranonce1={self.extranonce1} extranonce2_length={self.extranonce2_length}")
                    else:
                        LOG.warning(f"Subscribe response missing result: {sub_resp}")

                    LOG.info("Sending mining.authorize request")
                    auth_resp = self.send_jsonrpc("mining.authorize", self.userpass.split(":"))
                    if auth_resp.get("result") is True:
                        LOG.info("Successfully authorized with the pool")
                    else:
                        LOG.warning(f"Authorization rejected by pool: {auth_resp}")
                return
            except Exception as e:
                LOG.error(f"Failed to connect to stratum server (attempt {attempt + 1}/{self.max_retries}): {e}")
                self.close()
                if attempt < self.max_retries - 1:
                    time.sleep(self.retry_delay)
                else:
                    raise

    def _drain_pending_notifications(self):
        for msg, ts in self.pending_notifications:
            self._process_notification(msg, None, ts)
        self.pending_notifications.clear()

    def _process_notification(self, msg, raw_bytes, receipt_ts_ns):
        method = msg.get("method") if isinstance(msg, dict) else None
        if method == "mining.notify":
            # Subtract estimated one-way latency from receipt timestamp
            if self.avg_rtt > 0:
                latency_adjusted_ts = receipt_ts_ns - int(self.avg_rtt / 2)
            else:
                latency_adjusted_ts = receipt_ts_ns
            event_time = hex(latency_adjusted_ts)[2:]
            LOG.info(f"mining.notify job_id={msg['params'][0]} prev_hash={msg['params'][1][:16]}... clean={msg['params'][8]}")
            LOG.debug(f"mining.notify full payload: {msg}")
            document = create_notification_document(msg, self.pool_name, self.extranonce1, self.extranonce2_length, event_time)
            if self.db_enabled:
                insert_notification(document, self.db_url, self.db_name, self.db_username, self.db_password)
            if self.rabbitmq_enabled:
                self.publish_to_rabbitmq(document)
        elif method == "mining.set_difficulty":
            self.current_difficulty = msg.get("params", [None])[0]
            LOG.info(f"mining.set_difficulty: {self.current_difficulty}")
        elif method:
            LOG.info(f"Server notification: {method} params={msg.get('params')}")
        else:
            LOG.debug(f"Non-notification message: {msg}")

    def get_stratum_work(self, keep_alive=False):
        LOG.info("Starting get_stratum_work")
        last_subscribe_time = time.time()
        while True:
            try:
                if not self.sock:
                    self.connect_to_stratum()
                    self._drain_pending_notifications()
                n, receipt_ts = self.get_msg()
                self._process_notification(n, None, receipt_ts)
                if keep_alive and time.time() - last_subscribe_time > 480:
                    LOG.info("Keep-alive interval reached")
                    self.send_jsonrpc("mining.subscribe", [])
                    last_subscribe_time = time.time()
                    LOG.info("Keep-alive cycle completed")
            except (EOFError, ConnectionResetError, socket.timeout) as e:
                LOG.error(f"Connection error: {e}")
                self.close()
                time.sleep(self.retry_delay)
                self.connect_to_stratum()
                self._drain_pending_notifications()
            except Exception as e:
                LOG.error(f"Unexpected error: {e}")
                self.close()
                time.sleep(self.retry_delay)
                self.connect_to_stratum()
                self._drain_pending_notifications()

    def run_proxy(self, client_socket):
        """
        Runs the proxy mode: relays messages between the attached mining device (client_socket)
        and the pool connection (self.sock). Also processes mining.notify messages as usual.
        """
        pool_buf = b""
        client_buf = b""
        LOG.info("Starting proxy between mining device and pool")
        while True:
            try:
                rlist, _, _ = select.select([self.sock, client_socket], [], [])
            except Exception as e:
                LOG.error(f"Select error: {e}")
                break
            if self.sock in rlist:
                try:
                    data = self.sock.recv(4096)
                    recv_ts = time.time_ns()
                except Exception as e:
                    LOG.error(f"Error receiving from pool: {e}")
                    break
                if not data:
                    LOG.error("Pool closed connection")
                    break
                pool_buf += data
                while b"\n" in pool_buf:
                    line, pool_buf = pool_buf.split(b"\n", 1)
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except Exception as e:
                        msg = None
                    if msg:
                        self._process_notification(msg, line, recv_ts)
                    if msg and "result" in msg and isinstance(msg["result"], list) and len(msg["result"]) >= 2:
                        self.extranonce1 = msg["result"][-2]
                        self.extranonce2_length = msg["result"][-1]
                    try:
                        client_socket.sendall(line + b"\n")
                    except Exception as e:
                        LOG.error(f"Error sending to client: {e}")
                        break
            if client_socket in rlist:
                try:
                    data = client_socket.recv(4096)
                except Exception as e:
                    LOG.error(f"Error receiving from client: {e}")
                    break
                if not data:
                    LOG.info("Client closed connection")
                    break
                client_buf += data
                while b"\n" in client_buf:
                    line, client_buf = client_buf.split(b"\n", 1)
                    if not line:
                        continue
                    try:
                        self.sock.sendall(line + b"\n")
                    except Exception as e:
                        LOG.error(f"Error sending to pool: {e}")
                        break

def create_notification_document(data, pool_name, extranonce1, extranonce2_length, timestamp):
    notification_id = str(uuid.uuid4())
    coinbase1 = data["params"][2]
    coinbase2 = data["params"][3]
    coinbase = None
    height = 0
    try:
        if network is None:
            raise RuntimeError("Missing optional dependency 'pycoin'")
        coinbase = network.Tx.from_hex(coinbase1 + extranonce1 + "00"*extranonce2_length + coinbase2)
        height = int.from_bytes(coinbase.txs_in[0].script[1:4], byteorder='little')
    except Exception as e:
        LOG.debug("Failed to derive template height from coinbase: %s", e)
    document = {
        "_id": notification_id,
        "timestamp": timestamp,
        "pool_name": pool_name,
        "height": height,
        "job_id": data["params"][0],
        "prev_hash": data["params"][1],
        "coinbase1": coinbase1,
        "coinbase2": coinbase2,
        "merkle_branches": data["params"][4],
        "version": data["params"][5],
        "nbits": data["params"][6],
        "ntime": data["params"][7],
        "clean_jobs": data["params"][8],
        "extranonce1": extranonce1,
        "extranonce2_length": extranonce2_length
    }
    chain_family = classify_notification_chain(height, data["params"][1])
    if chain_family is not None:
        document["chain_family"] = chain_family
    return document

def insert_notification(document, db_url, db_name, db_username, db_password):
    LOG.debug(f"Attempting to insert document into MongoDB: {document}")
    collection = get_mongo_collection(db_url, db_name, db_username, db_password)
    result = collection.insert_one(document)
    LOG.info(f"Inserted document with id {result.inserted_id}")

def main():
    parser = argparse.ArgumentParser(
        description="Subscribe to a Stratum endpoint and listen for new work"
    )
    parser.add_argument("-u", "--url", required=True, help="The URL of the stratum server, including port. Ex: stratum+tcp://beststratumpool.com:3333")
    parser.add_argument(
        "-up", "--userpass", required=True, help="Username and password combination separated by a colon (:)"
    )
    parser.add_argument(
        "-p", "--pool-name", default=None, help="The name of the pool (defaults to hostname from --url)"
    )
    parser.add_argument(
        "-r", "--rabbitmq-host", default="localhost", help="The hostname or IP address of the RabbitMQ server (default: localhost)"
    )
    parser.add_argument(
        "-rpc", "--rabbitmq-port", default=5672, help="The port of the RabbitMQ server (default: 5672)"
    )
    parser.add_argument(
        "-ru", "--rabbitmq-username", default=None, help="The username for RabbitMQ authentication"
    )
    parser.add_argument(
        "-rp", "--rabbitmq-password", default=None, help="The password for RabbitMQ authentication"
    )
    parser.add_argument(
        "-re", "--rabbitmq-exchange", default="mining_notify_exchange", help="The name of the RabbitMQ exchange (default: mining_notify_exchange)"
    )
    parser.add_argument(
        "-d", "--db-url", default="localhost", help="MongoDB server URL"
    )
    parser.add_argument(
        "-dn", "--db-name", default="stratum-logger", help="MongoDB database name"
    )
    parser.add_argument(
        "-du", "--db-username", default=None, help="MongoDB username"
    )
    parser.add_argument(
        "-dp", "--db-password", default=None, help="MongoDB password"
    )
    parser.add_argument(
        "-k", "--keep-alive", action="store_true", help="Enable sending periodic subscribe requests to keep the connection alive"
    )
    parser.add_argument(
        "-l", "--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Set the logging level (default: INFO)"
    )
    parser.add_argument(
        "--use-proxy", action="store_true", help="Use a proxy for the connection"
    )
    parser.add_argument(
        "--proxy-host", default="localhost", help="Proxy hostname (default: localhost)"
    )
    parser.add_argument(
        "--proxy-port", type=int, default=9050, help="Proxy port (default: 9050)"
    )
    parser.add_argument(
        "--enable-stratum-client", action="store_true", help="Enable acting as a Stratum client proxy for a mining device"
    )
    parser.add_argument(
        "--stratum-client-port", type=int, default=3333, help="Port to listen for Stratum client connections (default: 3333)"
    )
    parser.add_argument(
        "--bitcoin-zmq-block",
        default="tcp://bitcoin-node:28332",
        help="Bitcoin node ZMQ block endpoint (default: tcp://bitcoin-node:28332)",
    )
    parser.add_argument(
        "--bitcoin-rpc-user",
        default="user",
        help="Bitcoin RPC username (default: user)",
    )
    parser.add_argument(
        "--bitcoin-rpc-password",
        default="password",
        help="Bitcoin RPC password",
    )
    parser.add_argument(
        "--bitcoin-rpc-host",
        default="localhost",
        help="Bitcoin RPC host (default: localhost)",
    )
    parser.add_argument(
        "--bitcoin-rpc-port",
        default="8332",
        help="Bitcoin RPC port (default: 8332)",
    )
    parser.add_argument(
        "--bitcoin-rpc-timeout",
        type=float,
        default=3.0,
        help="Bitcoin RPC timeout in seconds (default: 3.0)",
    )
    parser.add_argument(
        "--btc-chain-divergence-threshold",
        type=int,
        default=5,
        help="Height divergence threshold before non-BTC confirmation (default: 5)",
    )
    parser.add_argument(
        "--btc-tip-stale-seconds",
        type=int,
        default=1800,
        help="Seconds before local BTC tip data is considered stale (default: 1800)",
    )
    parser.add_argument(
        "--bch-confirmation-url",
        default="https://api.blockchair.com/bitcoin-cash/raw/block",
        help="BCH block confirmation API base URL",
    )
    parser.add_argument(
        "--bch-confirmation-timeout",
        type=float,
        default=3.0,
        help="BCH confirmation timeout in seconds (default: 3.0)",
    )
    args = parser.parse_args()

    if args.pool_name is None:
        args.pool_name = urlparse(args.url).hostname

    configure_chain_detection(args)

    rabbitmq_enabled = args.rabbitmq_username is not None and args.rabbitmq_password is not None
    db_enabled = args.db_username is not None and args.db_password is not None

    log_level = getattr(logging, args.log_level.upper(), None)
    if not isinstance(log_level, int):
        raise ValueError(f"Invalid log level: {args.log_level}")

    logging.basicConfig(
        stream=sys.stdout,
        format="%(asctime)s %(levelname)s: %(message)s",
        level=log_level,
    )
    LOG.info(f"Logging level set to {args.log_level.upper()}")
    LOG.info(f"Pool name: {args.pool_name}")
    try:
        initialize_tip_state(args)
    except Exception as exc:
        LOG.warning("Initial BTC tip setup failed; classification disabled until tip data is available: %s", exc)
    start_tip_listener(args)

    backends = []
    if rabbitmq_enabled:
        backends.append("RabbitMQ")
    if db_enabled:
        backends.append("MongoDB")
    if backends:
        LOG.info(f"Enabled backends: {', '.join(backends)}")
    else:
        LOG.info("Running in connect-only mode (no RabbitMQ or MongoDB backends enabled)")

    if args.enable_stratum_client:
        server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server_socket.bind(('', args.stratum_client_port))
        server_socket.listen(1)
        LOG.info(f"Listening for Stratum client connections on port {args.stratum_client_port}")
        while True:
            try:
                client_conn, client_addr = server_socket.accept()
                LOG.info(f"Accepted connection from {client_addr}")
                w = Watcher(
                    args.url, args.userpass, args.pool_name,
                    args.rabbitmq_host, args.rabbitmq_port, args.rabbitmq_username, args.rabbitmq_password, args.rabbitmq_exchange,
                    args.db_url, args.db_name, args.db_username, args.db_password,
                    args.use_proxy, args.proxy_host, args.proxy_port,
                    enable_stratum_client=True, stratum_client_port=args.stratum_client_port,
                    rabbitmq_enabled=rabbitmq_enabled, db_enabled=db_enabled
                )
                if rabbitmq_enabled:
                    w.connect_to_rabbitmq()
                w.connect_to_stratum()
                w.run_proxy(client_conn)
            except KeyboardInterrupt:
                break
            except Exception as e:
                LOG.error(f"Error in proxy mode: {e}")
            finally:
                try:
                    w.close()
                    if rabbitmq_enabled and w.connection:
                        w.connection.close()
                    if db_enabled:
                        close_cached_mongo_client()
                except Exception:
                    pass
                try:
                    client_conn.close()
                except Exception:
                    pass
        server_socket.close()
    else:
        while True:
            w = Watcher(
                args.url, args.userpass, args.pool_name,
                args.rabbitmq_host, args.rabbitmq_port, args.rabbitmq_username, args.rabbitmq_password, args.rabbitmq_exchange,
                args.db_url, args.db_name, args.db_username, args.db_password,
                args.use_proxy, args.proxy_host, args.proxy_port,
                enable_stratum_client=False,
                rabbitmq_enabled=rabbitmq_enabled, db_enabled=db_enabled
            )
            try:
                if rabbitmq_enabled:
                    w.connect_to_rabbitmq()
                w.get_stratum_work(keep_alive=args.keep_alive)
            except KeyboardInterrupt:
                break
            finally:
                w.close()
                if rabbitmq_enabled and w.connection:
                    w.connection.close()
                if db_enabled:
                    close_cached_mongo_client()

if __name__ == "__main__":
    main()
