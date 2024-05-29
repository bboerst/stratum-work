import argparse
import json
import logging
import socket
import sys
import time
import uuid
from datetime import datetime
from urllib.parse import urlparse

from pymongo import MongoClient

LOG = logging.getLogger()

class Watcher:
    def __init__(self, url, userpass, pool_name, db_url):
        self.buf = b""
        self.id = 1
        self.userpass = userpass
        self.pool_name = pool_name
        self.db_url = db_url
        self.purl = self.parse_url(url)
        self.init_socket()

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
        self.sock = socket.socket()
        self.sock.settimeout(600)

    def close(self):
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()
        LOG.info(f"Disconnected from {self.purl.geturl()}")

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
        LOG.debug(f"Received: {resp}")

    def get_stratum_work(self, db_name, db_username, db_password):
        self.sock.setblocking(True)
        self.sock.connect((self.purl.hostname, self.purl.port))
        LOG.info(f"Connected to server {self.purl.geturl()}")

        self.send_jsonrpc("mining.subscribe", [])
        LOG.info("Subscribed to pool notifications")

        self.send_jsonrpc("mining.authorize", self.userpass.split(":"))
        LOG.info("Authed with the pool")

        while True:
            try:
                n = self.get_msg()
                LOG.debug(f"Received notification: {n}")
            except Exception as e:
                LOG.info(f"Received exception: {e}")
                self.close()
                return

            if "method" in n and n["method"] == "mining.notify":
                insert_notification(n, self.pool_name, self.db_url, db_name, db_username, db_password)

def insert_notification(data, pool_name, db_url, db_name, db_username, db_password):
    client = MongoClient(db_url, username=db_username, password=db_password)
    db = client[db_name]
    collection = db.mining_notify

    notification_id = str(uuid.uuid4())
    now = datetime.utcnow()

    document = {
        "_id": notification_id,
        "timestamp": now,
        "pool_name": pool_name,
        "job_id": data["params"][0],
        "prev_hash": data["params"][1],
        "coinbase1": data["params"][2],
        "coinbase2": data["params"][3],
        "merkle_branches": data["params"][4],
        "version": data["params"][5],
        "nbits": data["params"][6],
        "ntime": data["params"][7],
        "clean_jobs": data["params"][8]
    }

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
        "-l", "--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="Set the logging level (default: INFO)"
    )
    args = parser.parse_args()

    logging.basicConfig(
        stream=sys.stdout,
        format="%(asctime)s %(levelname)s: %(message)s",
        level=getattr(logging, args.log_level),
    )

    while True:
        w = Watcher(args.url, args.userpass, args.pool_name, args.db_url)
        try:
            w.get_stratum_work(args.db_name, args.db_username, args.db_password)
        except KeyboardInterrupt:
            break
        finally:
            w.close()

if __name__ == "__main__":
    main()