import os
import time
import json
import uuid
import logging
from threading import RLock

import pika


logger = logging.getLogger("backend.rabbitmq")


RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
RABBITMQ_PORT = int(os.getenv("RABBITMQ_PORT", "5672"))
RABBITMQ_USERNAME = os.getenv("RABBITMQ_USERNAME", "mquser")
RABBITMQ_PASSWORD = os.getenv("RABBITMQ_PASSWORD", "mqpassword")
RABBITMQ_EXCHANGE = os.getenv("RABBITMQ_EXCHANGE", "blocks")
RABBITMQ_HEARTBEAT = int(os.getenv("RABBITMQ_HEARTBEAT", "30"))
RABBITMQ_CONNECTION_TIMEOUT = int(os.getenv("RABBITMQ_CONNECTION_TIMEOUT", "10"))
RABBITMQ_SOCKET_TIMEOUT = int(os.getenv("RABBITMQ_SOCKET_TIMEOUT", "5"))
RABBITMQ_RETRY_DELAY = int(os.getenv("RABBITMQ_RETRY_DELAY", "2"))
RABBITMQ_MAX_RETRIES = int(os.getenv("RABBITMQ_MAX_RETRIES", "5"))


class RabbitMQManager:
    def __init__(self, host, port, username, password, exchange,
                 heartbeat=RABBITMQ_HEARTBEAT,
                 connection_timeout=RABBITMQ_CONNECTION_TIMEOUT,
                 socket_timeout=RABBITMQ_SOCKET_TIMEOUT):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.exchange = exchange
        self.heartbeat = heartbeat
        self.connection_timeout = connection_timeout
        self.socket_timeout = socket_timeout
        self.connection = None
        self.channel = None
        # BlockingConnection/Channel are not thread-safe. Use a reentrant lock so
        # the same thread can call nested methods that also acquire the lock.
        self.lock = RLock()
        self.last_reconnect_attempt = 0
        self.reconnect_cooldown = 2
        self.connect()

    def connect(self):
        with self.lock:
            if self.connection:
                try:
                    if not self.connection.is_closed:
                        self.connection.close()
                except Exception as e:
                    logger.warning(f"Error closing existing RabbitMQ connection: {e}")

            max_retries = RABBITMQ_MAX_RETRIES
            retry_delay = RABBITMQ_RETRY_DELAY

            for attempt in range(max_retries):
                try:
                    url = f"amqp://{self.username}:{self.password}@{self.host}:{self.port}/%2F"
                    params = pika.URLParameters(url)

                    params.heartbeat = self.heartbeat
                    params.socket_timeout = self.socket_timeout
                    params.blocked_connection_timeout = self.connection_timeout
                    params.retry_delay = 1
                    params.connection_attempts = 3

                    params.tcp_options = {
                        'TCP_KEEPIDLE': 60,
                        'TCP_KEEPINTVL': 10,
                        'TCP_KEEPCNT': 5
                    }

                    logger.info(f"Connecting to RabbitMQ at {self.host}:{self.port} (heartbeat={self.heartbeat}s)")
                    self.connection = pika.BlockingConnection(params)

                    self.channel = self.connection.channel()
                    self.channel.basic_qos(prefetch_count=1)
                    self.channel.exchange_declare(
                        exchange=self.exchange,
                        exchange_type='fanout',
                        durable=True
                    )

                    logger.info(f"Successfully connected to RabbitMQ at {self.host}:{self.port}")
                    self.last_reconnect_attempt = time.time()
                    return True
                except (pika.exceptions.AMQPConnectionError,
                        pika.exceptions.ConnectionClosedByBroker,
                        pika.exceptions.ConnectionWrongStateError,
                        pika.exceptions.StreamLostError) as e:
                    logger.error(f"Failed to connect to RabbitMQ (attempt {attempt+1}/{max_retries}): {e}")
                    if attempt < max_retries - 1:
                        time.sleep(retry_delay)
                        retry_delay = min(retry_delay * 1.5, 10)
                except Exception as e:
                    logger.error(f"Unexpected error connecting to RabbitMQ (attempt {attempt+1}/{max_retries}): {e}")
                    if attempt < max_retries - 1:
                        time.sleep(retry_delay)
                        retry_delay = min(retry_delay * 1.5, 10)

            logger.error("Failed to connect to RabbitMQ after all retries")
            return False

    def ensure_connection(self):
        current_time = time.time()
        with self.lock:
            if not self.connection or self.connection.is_closed:
                if current_time - self.last_reconnect_attempt < self.reconnect_cooldown:
                    logger.warning("RabbitMQ reconnection in cooldown period, skipping reconnect attempt")
                    return False
                logger.info("RabbitMQ connection is closed, attempting to reconnect")
                return self.connect()

            try:
                # Drive heartbeats and I/O in a controlled, serialized manner
                self.connection.process_data_events(time_limit=0)
            except (pika.exceptions.ConnectionClosed,
                    pika.exceptions.ChannelClosed,
                    pika.exceptions.AMQPConnectionError,
                    pika.exceptions.StreamLostError) as e:
                logger.warning(f"RabbitMQ connection error during health check: {e}")
                return self.connect()
            except Exception as e:
                logger.warning(f"Error checking RabbitMQ connection health: {e}")
                return self.connect()
            return True

    def publish(self, doc, max_retries=3):
        retry_delay = RABBITMQ_RETRY_DELAY
        message_type = doc.get('type', 'unknown')

        for attempt in range(max_retries):
            try:
                if not self.ensure_connection():
                    if attempt < max_retries - 1:
                        logger.warning(f"Failed to ensure RabbitMQ connection, retrying in {retry_delay}s")
                        time.sleep(retry_delay)
                        retry_delay = min(retry_delay * 1.5, 10)
                        continue
                    else:
                        logger.error("Failed to publish: could not establish RabbitMQ connection")
                        return False

                message_body = json.dumps(doc)

                try:
                    # Serialize publish and any I/O driving to avoid cross-thread access
                    with self.lock:
                        self.channel.basic_publish(
                            exchange=self.exchange,
                            routing_key='',
                            body=message_body,
                            properties=pika.BasicProperties(
                                delivery_mode=2,
                                content_type='application/json',
                                message_id=str(uuid.uuid4()),
                                timestamp=int(time.time())
                            ),
                            mandatory=False
                        )

                        # Drive heartbeats/I-O after publish to keep the connection healthy
                        self.connection.process_data_events(time_limit=0)

                    logger.info(f"Published message to RabbitMQ: {message_type}")
                    return True
                except (pika.exceptions.UnroutableError, pika.exceptions.NackError) as e:
                    logger.error(f"Message routing error (attempt {attempt+1}/{max_retries}): {e}")
                    with self.lock:
                        self.connection = None
                        self.channel = None

            except (pika.exceptions.ConnectionClosed,
                    pika.exceptions.ChannelClosed,
                    pika.exceptions.AMQPConnectionError,
                    pika.exceptions.StreamLostError) as e:
                logger.error(f"RabbitMQ connection error (attempt {attempt+1}/{max_retries}): {e}")
                with self.lock:
                    self.connection = None
                    self.channel = None

                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                    retry_delay = min(retry_delay * 1.5, 10)

            except Exception as e:
                logger.error(f"Unexpected error publishing to RabbitMQ (attempt {attempt+1}/{max_retries}): {e}")
                with self.lock:
                    self.connection = None
                    self.channel = None

                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                    retry_delay = min(retry_delay * 1.5, 10)
                else:
                    logger.error("Failed to publish to RabbitMQ after all retries")
                    return False

        return False


rabbitmq_manager = RabbitMQManager(
    host=RABBITMQ_HOST,
    port=RABBITMQ_PORT,
    username=RABBITMQ_USERNAME,
    password=RABBITMQ_PASSWORD,
    exchange=RABBITMQ_EXCHANGE,
)


def publish_to_rabbitmq(doc):
    return rabbitmq_manager.publish(doc)


def heartbeat_task():
    """Periodically check and maintain the RabbitMQ connection."""
    HEARTBEAT_INTERVAL = 15
    logger.info("Starting RabbitMQ heartbeat task")
    while True:
        try:
            # Serialize heartbeat I/O with publishes and other connection ops
            with rabbitmq_manager.lock:
                if rabbitmq_manager.connection and not rabbitmq_manager.connection.is_closed:
                    try:
                        rabbitmq_manager.connection.process_data_events(time_limit=0)
                        logger.debug("RabbitMQ heartbeat check successful")
                    except Exception as e:
                        logger.warning(f"RabbitMQ heartbeat check failed: {e}")
                        rabbitmq_manager.connect()
                else:
                    logger.warning("RabbitMQ connection is closed during heartbeat check, reconnecting")
                    rabbitmq_manager.connect()
        except Exception as e:
            logger.error(f"Error in RabbitMQ heartbeat task: {e}")
        time.sleep(HEARTBEAT_INTERVAL)


def start_heartbeat_thread():
    import threading
    thread = threading.Thread(target=heartbeat_task, daemon=True)
    thread.start()
    return thread


