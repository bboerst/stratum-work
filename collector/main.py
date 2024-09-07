import argparse
import json
import logging
import socket
import sys
import time
import uuid
from datetime import datetime
from urllib.parse import urlparse

import pika
from pymongo import MongoClient
from pycoin.symbols.btc import network
import socks

LOG = logging.getLogger()

class Watcher:
    def __init__(self, url, userpass, pool_name, rabbitmq_host, rabbitmq_port, rabbitmq_username, rabbitmq_password, rabbitmq_exchange, db_url, db_name, db_username, db_password, use_proxy=False, proxy_host=None, proxy_port=None):
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
        self.db_url = db_url
        self.db_name = db_name
        self.db_username = db_username
        self.db_password = db_password
        self.purl = self.parse_url(url)
        self.extranonce1 = None
        self.extranonce2_length = -1
        self.use_proxy = use_proxy
        self.proxy_host = proxy_host
        self.proxy_port = proxy_port
        self.init_socket()
        self.connection = None
        self.channel = None

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
        LOG.info(f"Closing connection to {self.purl.geturl()}")
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
            LOG.info("Socket shutdown successful")
        except OSError as e:
            LOG.warning(f"Error during socket shutdown: {e}")
        self.sock.close()
        LOG.info(f"Socket closed. Disconnected from {self.purl.geturl()}")

    def get_msg(self):
        while True:
            split_buf = self.buf.split(b"\n", maxsplit=1)
            r = split_buf[0]
            if r == b'':
                # If r is an empty byte string, continue reading data from the socket
                try:
                    new_buf = self.sock.recv(4096)
                except Exception as e:
                    LOG.debug(f"Error receiving data: {e}")
                    self.close()
                    raise EOFError
                if len(new_buf) == 0:
                    self.close()
                self.buf += new_buf
                continue
            try:
                resp = json.loads(r)
                if len(split_buf) == 2:
                    self.buf = split_buf[1]
                else:
                    self.buf = b""
                return resp
            except (json.decoder.JSONDecodeError, ConnectionResetError) as e:
                LOG.debug(f"Error decoding JSON: {e}")
                new_buf = b""
                try:
                    new_buf = self.sock.recv(4096)
                except Exception as e:
                    LOG.debug(f"Error receiving data: {e}")
                    self.close()
                    raise EOFError
                if len(new_buf) == 0:
                    self.close()
                self.buf += new_buf

    def send_jsonrpc(self, method, params):
        data = {
            "id": self.id,
            "method": method,
            "params": params,
        }
        self.id += 1

        LOG.debug(f"Sending: {data}")
        json_data = json.dumps(data) + "\n"
        self.sock.send(json_data.encode())

        resp = self.get_msg()

        if resp["id"] == 1 and resp["result"] is not None:
            self.extranonce1, self.extranonce2_length = resp["result"][-2:]

        LOG.debug(f"Received: {resp}")

    def connect_to_rabbitmq(self):
        credentials = pika.PlainCredentials(self.rabbitmq_username, self.rabbitmq_password)
        self.connection = pika.BlockingConnection(pika.ConnectionParameters(self.rabbitmq_host, self.rabbitmq_port, '/', credentials))
        self.channel = self.connection.channel()
        self.channel.exchange_declare(exchange=self.rabbitmq_exchange, exchange_type='fanout', durable=True)

    def publish_to_rabbitmq(self, message):
        LOG.info(f"Publishing message to RabbitMQ: {json.dumps(message)}")
        self.channel.basic_publish(exchange=self.rabbitmq_exchange, routing_key='', body=json.dumps(message))

    def get_stratum_work(self, keep_alive=False):
        LOG.info("Starting get_stratum_work")
        self.sock.setblocking(True)
        LOG.info("Socket set to blocking mode")
        if self.use_proxy:
            LOG.info(f"Connecting through proxy: {self.proxy_host}:{self.proxy_port}")
        LOG.info(f"Attempting to connect to {self.purl.hostname}:{self.purl.port}")
        try:
            self.sock.connect((self.purl.hostname, self.purl.port))
            LOG.info(f"Successfully connected to server {self.purl.geturl()}")
        except Exception as e:
            LOG.error(f"Failed to connect to server: {e}")
            raise

        LOG.info("Sending mining.subscribe request")
        self.send_jsonrpc("mining.subscribe", [])
        LOG.info("Successfully subscribed to pool notifications")

        LOG.info("Sending mining.authorize request")
        self.send_jsonrpc("mining.authorize", self.userpass.split(":"))
        LOG.info("Successfully authorized with the pool")

        last_subscribe_time = time.time()

        while True:
            try:
                n = self.get_msg()
                LOG.debug(f"Received notification: {n}")
            except Exception as e:
                LOG.error(f"Error receiving message: {e}")
                self.close()
                return

            if "method" in n and n["method"] == "mining.notify":
                LOG.info("Received mining.notify message")
                document = create_notification_document(n, self.pool_name, self.extranonce1, self.extranonce2_length)
                insert_notification(document, self.db_url, self.db_name, self.db_username, self.db_password)
                self.publish_to_rabbitmq(document)

            if keep_alive and time.time() - last_subscribe_time > 480:
                LOG.info("Keep-alive interval reached")
                LOG.info(f"Disconnecting from server for keep alive {self.purl.geturl()}")
                self.close()
                time.sleep(1)
                LOG.info("Reinitializing socket")
                self.init_socket()
                LOG.info(f"Reconnecting to server {self.purl.geturl()}")
                self.sock.connect((self.purl.hostname, self.purl.port))
                LOG.info(f"Successfully reconnected to server {self.purl.geturl()}")
                LOG.info("Resubscribing to pool notifications")
                self.send_jsonrpc("mining.subscribe", [])
                LOG.info("Reauthorizing with the pool")
                self.send_jsonrpc("mining.authorize", self.userpass.split(":"))
                LOG.info("Sending subscribe request to keep connection alive")
                self.send_jsonrpc("mining.subscribe", [])
                last_subscribe_time = time.time()
                LOG.info("Keep-alive cycle completed")

def create_notification_document(data, pool_name, extranonce1, extranonce2_length):
    notification_id = str(uuid.uuid4())
    now = datetime.utcnow()

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
        "timestamp": now.isoformat(),  # Convert datetime to ISO 8601 formatted string
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
    client = MongoClient(db_url, username=db_username, password=db_password)
    db = client[db_name]
    collection = db.mining_notify

    collection.insert_one(document)
    client.close()

def main():
    parser = argparse.ArgumentParser(
        description="Subscribe to a Stratum endpoint and listen for new work"
    )
    parser.add_argument("-u", "--url", required=True, help="The URL of the stratum server, including port. Ex: stratum+tcp://beststratumpool.com:3333")
    parser.add_argument(
        "-up", "--userpass", required=True, help="Username and password combination separated by a colon (:)"
    )
    parser.add_argument(
        "-p", "--pool-name", required=True, help="The name of the pool"
    )
    parser.add_argument(
        "-r", "--rabbitmq-host", default="localhost", help="The hostname or IP address of the RabbitMQ server (default: localhost)"
    )
    parser.add_argument(
        "-rpc", "--rabbitmq-port", default=5672, help="The port of the RabbitMQ server (default: 5672)"
    )
    parser.add_argument(
        "-ru", "--rabbitmq-username", required=True, help="The username for RabbitMQ authentication"
    )
    parser.add_argument(
        "-rp", "--rabbitmq-password", required=True, help="The password for RabbitMQ authentication"
    )
    parser.add_argument(
        "-re", "--rabbitmq-exchange", default="mining_notify_exchange", help="The name of the RabbitMQ exchange (default: mining_notify_exchange)"
    )
    parser.add_argument(
        "-d", "--db-url", default="mongodb://localhost:27017", help="The URL of the MongoDB database (default: mongodb://localhost:27017)"
    )
    parser.add_argument(
        "-dn", "--db-name", required=True, help="The name of the MongoDB database"
    )
    parser.add_argument(
        "-du", "--db-username", required=True, help="The username for MongoDB authentication"
    )
    parser.add_argument(
        "-dp", "--db-password", required=True, help="The password for MongoDB authentication"
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
    args = parser.parse_args()

    logging.basicConfig(
        stream=sys.stdout,
        format="%(asctime)s %(levelname)s: %(message)s",
        level=getattr(logging, args.log_level),
    )

    while True:
        w = Watcher(args.url, args.userpass, args.pool_name, args.rabbitmq_host, args.rabbitmq_port, args.rabbitmq_username, args.rabbitmq_password, args.rabbitmq_exchange, args.db_url, args.db_name, args.db_username, args.db_password, args.use_proxy, args.proxy_host, args.proxy_port)
        try:
            w.connect_to_rabbitmq()
            w.get_stratum_work(keep_alive=args.keep_alive)
        except KeyboardInterrupt:
            break
        finally:
            w.close()
            if w.connection:
                w.connection.close()

if __name__ == "__main__":
    main()