import argparse
import json
import logging
import socket
import sys
import time
import uuid
from datetime import datetime
from urllib.parse import urlparse
import select

import pika
from pymongo import MongoClient
from pycoin.symbols.btc import network
import socks

LOG = logging.getLogger()

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
        earliest moment a complete line is available, before JSON parsing."""
        receipt_ts_ns = None
        while True:
            split_buf = self.buf.split(b"\n", maxsplit=1)
            r = split_buf[0]
            if r == b'':
                try:
                    new_buf = self.sock.recv(4096)
                    if receipt_ts_ns is None:
                        receipt_ts_ns = time.time_ns()
                except Exception as e:
                    LOG.debug(f"Error receiving data: {e}")
                    raise EOFError
                if len(new_buf) == 0:
                    raise EOFError
                self.buf += new_buf
                continue
            if receipt_ts_ns is None:
                receipt_ts_ns = time.time_ns()
            try:
                resp = json.loads(r)
                if len(split_buf) == 2:
                    self.buf = split_buf[1]
                else:
                    self.buf = b""
                return resp, receipt_ts_ns
            except (json.decoder.JSONDecodeError, ConnectionResetError) as e:
                LOG.debug(f"Error decoding JSON: {e} | raw ({len(r)} bytes): {r[:500]}")
                new_buf = b""
                try:
                    new_buf = self.sock.recv(4096)
                except Exception as e:
                    LOG.debug(f"Error receiving data: {e}")
                    raise EOFError
                if len(new_buf) == 0:
                    raise EOFError
                self.buf += new_buf

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

        while True:
            msg, ts = self.get_msg()
            if isinstance(msg, dict) and msg.get("id") == request_id:
                LOG.debug(f"Received response for request {request_id}: {msg}")
                return msg
            LOG.info(f"Queued server notification while awaiting response {request_id}: {msg}")
            self.pending_notifications.append((msg, ts))

    def connect_to_rabbitmq(self):
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
            event_time = hex(receipt_ts_ns)[2:]
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
        coinbase = network.Tx.from_hex(coinbase1 + extranonce1 + "00"*extranonce2_length + coinbase2)
        height = int.from_bytes(coinbase.txs_in[0].script[1:4], byteorder='little')
    except Exception as e:
        print(e)
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
    return document

def insert_notification(document, db_url, db_name, db_username, db_password):
    LOG.debug(f"Attempting to insert document into MongoDB: {document}")
    client = MongoClient(f"mongodb://{db_username}:{db_password}@{db_url}")
    db = client[db_name]
    collection = db["mining_notify"]
    result = collection.insert_one(document)
    LOG.info(f"Inserted document with id {result.inserted_id}")
    client.close()
    LOG.debug("MongoDB connection closed")

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
    args = parser.parse_args()

    if args.pool_name is None:
        args.pool_name = urlparse(args.url).hostname

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

if __name__ == "__main__":
    main()