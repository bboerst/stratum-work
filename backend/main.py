import os, time, threading, logging
from fastapi import FastAPI
from bitcoinrpc.authproxy import AuthServiceProxy, JSONRPCException
from pymongo import MongoClient
from pydantic import BaseModel
import uvicorn
from io import BytesIO
import zmq
import json
import pika
import requests
import uuid
import re
from datetime import datetime
import concurrent.futures
from queue import Queue
from contextlib import contextmanager
from threading import Lock
import random

# --- Logging Setup ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger("backend")

# --- Configuration (parameterized via environment variables) ---
RPC_USER = os.getenv("BITCOIN_RPC_USER", "user")
RPC_PASSWORD = os.getenv("BITCOIN_RPC_PASSWORD", "password")
RPC_HOST = os.getenv("BITCOIN_RPC_HOST", "localhost")
RPC_PORT = os.getenv("BITCOIN_RPC_PORT", "8332")
RPC_URL = f"http://{RPC_USER}:{RPC_PASSWORD}@{RPC_HOST}:{RPC_PORT}"
logger.info("Connecting to bitcoin RPC at %s:%s", RPC_HOST, RPC_PORT)

ZMQ_BLOCK = os.getenv("BITCOIN_ZMQ_BLOCK", "tcp://bitcoin-node:28332")
MIN_BLOCK_HEIGHT = int(os.getenv("MIN_BLOCK_HEIGHT", "882000"))

MONGO_URL = os.getenv("MONGODB_URL", "mongodb://mongodb:27017")
MONGO_DB = os.getenv("MONGODB_DB", "stratum-logger")
MONGO_USER = os.getenv("MONGODB_USERNAME", "mongouser")
MONGO_PASSWORD = os.getenv("MONGODB_PASSWORD", "mongopassword")

RABBITMQ_HOST = os.getenv("RABBITMQ_HOST", "rabbitmq")
RABBITMQ_PORT = int(os.getenv("RABBITMQ_PORT", "5672"))
RABBITMQ_USERNAME = os.getenv("RABBITMQ_USERNAME", "mquser")
RABBITMQ_PASSWORD = os.getenv("RABBITMQ_PASSWORD", "mqpassword")
RABBITMQ_EXCHANGE = os.getenv("RABBITMQ_EXCHANGE", "blocks")
RABBITMQ_HEARTBEAT = int(os.getenv("RABBITMQ_HEARTBEAT", "30"))  # Reduced from 60 to 30
RABBITMQ_CONNECTION_TIMEOUT = int(os.getenv("RABBITMQ_CONNECTION_TIMEOUT", "10"))
RABBITMQ_SOCKET_TIMEOUT = int(os.getenv("RABBITMQ_SOCKET_TIMEOUT", "5"))
RABBITMQ_RETRY_DELAY = int(os.getenv("RABBITMQ_RETRY_DELAY", "2"))
RABBITMQ_MAX_RETRIES = int(os.getenv("RABBITMQ_MAX_RETRIES", "5"))

POOL_LIST_URL = os.getenv("POOL_LIST_URL", "https://raw.githubusercontent.com/mempool/mining-pools/refs/heads/master/pools-v2.json")
POOL_UPDATE_INTERVAL = int(os.getenv("POOL_UPDATE_INTERVAL", "86400"))  # Default: once per day
LOCAL_POOL_FILE = os.getenv("LOCAL_POOL_FILE", "pool_definitions.json")  # Local fallback file

# --- Connections ---
def create_rpc_connection():
    for attempt in range(1, 6):
        try:
            conn = AuthServiceProxy(RPC_URL)
            conn.getblockcount()
            logger.info("Successfully connected to bitcoin RPC (attempt %d)", attempt)
            return conn
        except Exception as e:
            logger.error("RPC connection attempt %d failed: %s", attempt, e)
            # Reinitialize connection (do not log credentials)
            try:
                conn = AuthServiceProxy(RPC_URL)
                logger.info("Reinitialized bitcoin RPC connection on attempt %d", attempt)
                return conn
            except Exception as reinit_err:
                logger.error("Failed to reinitialize RPC connection on attempt %d: %s", attempt, reinit_err)
            time.sleep(2 ** attempt)
    raise Exception("Failed to connect to bitcoin RPC after multiple attempts")

bitcoin_rpc = create_rpc_connection()

try:
    mongo_client = MongoClient(MONGO_URL, username=MONGO_USER, password=MONGO_PASSWORD)
    db = mongo_client[MONGO_DB]
    blocks_coll = db.blocks
    pools_coll = db.pools
    logger.info("Connected to MongoDB at %s", MONGO_URL)
except Exception as e:
    logger.error("Error connecting to MongoDB: %s", e)
    raise

# --- RabbitMQ Connection Management ---
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
        self.lock = Lock()
        self.last_reconnect_attempt = 0
        self.reconnect_cooldown = 2
        self.connect()
    
    def connect(self):
        """Establish a connection to RabbitMQ"""
        with self.lock:
            # Close existing connection if it exists
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
                    # Use URLParameters for more robust connection handling
                    url = f"amqp://{self.username}:{self.password}@{self.host}:{self.port}/%2F"
                    params = pika.URLParameters(url)
                    
                    # Override default parameters with our custom settings
                    params.heartbeat = self.heartbeat
                    params.socket_timeout = self.socket_timeout
                    params.blocked_connection_timeout = self.connection_timeout
                    params.retry_delay = 1
                    params.connection_attempts = 3
                    
                    # Add TCP keepalive settings to prevent connection drops
                    params.tcp_options = {
                        'TCP_KEEPIDLE': 60,  # Start sending keepalive probes after 60 seconds
                        'TCP_KEEPINTVL': 10,  # Send keepalive probes every 10 seconds
                        'TCP_KEEPCNT': 5      # Drop connection after 5 failed probes
                    }
                    
                    logger.info(f"Connecting to RabbitMQ at {self.host}:{self.port} (heartbeat={self.heartbeat}s)")
                    self.connection = pika.BlockingConnection(params)
                    
                    self.channel = self.connection.channel()
                    # Set prefetch count to 1 to avoid overwhelming the channel
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
                        retry_delay = min(retry_delay * 1.5, 10)  # Exponential backoff with cap
                except Exception as e:
                    logger.error(f"Unexpected error connecting to RabbitMQ (attempt {attempt+1}/{max_retries}): {e}")
                    if attempt < max_retries - 1:
                        time.sleep(retry_delay)
                        retry_delay = min(retry_delay * 1.5, 10)  # Exponential backoff with cap
            
            logger.error("Failed to connect to RabbitMQ after all retries")
            return False
    
    def ensure_connection(self):
        """Ensure that the connection is active, reconnect if needed"""
        current_time = time.time()
        
        # Check if connection is closed or doesn't exist
        if not self.connection or self.connection.is_closed:
            # Check if we're in cooldown period
            if current_time - self.last_reconnect_attempt < self.reconnect_cooldown:
                logger.warning("RabbitMQ reconnection in cooldown period, skipping reconnect attempt")
                return False
            
            logger.info("RabbitMQ connection is closed, attempting to reconnect")
            return self.connect()
        
        # Check if connection is still alive
        try:
            # Process any pending events to keep the connection alive
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
        """Publish a message to RabbitMQ with retry logic"""
        retry_delay = RABBITMQ_RETRY_DELAY
        message_type = doc.get('type', 'unknown')
        
        for attempt in range(max_retries):
            try:
                # Ensure connection is active
                if not self.ensure_connection():
                    if attempt < max_retries - 1:
                        logger.warning(f"Failed to ensure RabbitMQ connection, retrying in {retry_delay}s")
                        time.sleep(retry_delay)
                        retry_delay = min(retry_delay * 1.5, 10)  # Exponential backoff with cap
                        continue
                    else:
                        logger.error("Failed to publish: could not establish RabbitMQ connection")
                        return False
                
                # Prepare message
                message_body = json.dumps(doc)
                
                # Publish message with more robust error handling
                try:
                    self.channel.basic_publish(
                        exchange=self.exchange,
                        routing_key='',
                        body=message_body,
                        properties=pika.BasicProperties(
                            delivery_mode=2,  # make message persistent
                            content_type='application/json',
                            message_id=str(uuid.uuid4()),  # Add unique message ID
                            timestamp=int(time.time())     # Add timestamp
                        ),
                        mandatory=False  # Don't require confirmation
                    )
                    
                    # Process any pending events to keep the connection alive
                    self.connection.process_data_events(time_limit=0)
                    
                    logger.info(f"Published message to RabbitMQ: {message_type}")
                    return True
                except (pika.exceptions.UnroutableError, pika.exceptions.NackError) as e:
                    # These are specific publishing errors
                    logger.error(f"Message routing error (attempt {attempt+1}/{max_retries}): {e}")
                    # Force reconnection on next attempt
                    self.connection = None
                    self.channel = None
            
            except (pika.exceptions.ConnectionClosed, 
                    pika.exceptions.ChannelClosed, 
                    pika.exceptions.AMQPConnectionError,
                    pika.exceptions.StreamLostError) as e:
                logger.error(f"RabbitMQ connection error (attempt {attempt+1}/{max_retries}): {e}")
                # Force reconnection on next attempt
                self.connection = None
                self.channel = None
                
                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                    retry_delay = min(retry_delay * 1.5, 10)  # Exponential backoff with cap
            
            except Exception as e:
                logger.error(f"Unexpected error publishing to RabbitMQ (attempt {attempt+1}/{max_retries}): {e}")
                # For unexpected errors, try to reconnect as well
                self.connection = None
                self.channel = None
                
                if attempt < max_retries - 1:
                    time.sleep(retry_delay)
                    retry_delay = min(retry_delay * 1.5, 10)  # Exponential backoff with cap
                else:
                    logger.error("Failed to publish to RabbitMQ after all retries")
                    return False
        
        return False

# Initialize RabbitMQ manager
rabbitmq_manager = RabbitMQManager(
    host=RABBITMQ_HOST,
    port=RABBITMQ_PORT,
    username=RABBITMQ_USERNAME,
    password=RABBITMQ_PASSWORD,
    exchange=RABBITMQ_EXCHANGE
)

# For backward compatibility, provide a publish_to_rabbitmq function
def publish_to_rabbitmq(doc):
    return rabbitmq_manager.publish(doc)

# --- FastAPI app and models ---
app = FastAPI()

# Create separate thread pools for old and new blocks
old_block_processor = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="old_block_processor")
new_block_processor = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="new_block_processor")

class BlockModel(BaseModel):
    height: int
    coinbase_script_sig: str
    block_hash: str
    timestamp: int

# Event to signal that block sync is complete.
sync_complete_event = threading.Event()

@app.get("/blocks")
def get_blocks(n: int = 20, before: int = None):
    try:
        # Build the query based on the before parameter
        query = {}
        if before is not None:
            # Include the 'before' height in the results to avoid gaps
            query["height"] = {"$lte": before}
        
        # Get one more block than requested to determine if there are more blocks
        blocks = list(blocks_coll.find(query, {"_id": 0}).sort("height", -1).limit(n + 1))
        
        # Check if we have more blocks
        has_more = len(blocks) > n
        if has_more:
            # Remove the extra block we fetched
            blocks = blocks[:n]
        
        # Log the block heights for debugging
        heights = [block["height"] for block in blocks]
        logger.info("API call /blocks succeeded: %d blocks returned, heights: %s", len(blocks), heights)
        
        # Return both the blocks and pagination info
        return {
            "blocks": blocks,
            "has_more": has_more,
            "next_height": blocks[-1]["height"] if blocks else None
        }
    except Exception as e:
        logger.error("API call /blocks failed: %s", e)
        return {"error": str(e)}

# --- RPC Connection Pool ---
class RPCConnectionPool:
    def __init__(self, url, pool_size=4):
        self.url = url
        self.pool_size = pool_size
        self.connection_queue = Queue()
        self.lock = Lock()
        self.last_recreation_time = 0
        self.recreation_cooldown = 5  # seconds
        self._initialize_pool()
    
    def _initialize_pool(self):
        """Initialize the connection pool with fresh connections"""
        with self.lock:
            # Clear existing queue
            while not self.connection_queue.empty():
                try:
                    self.connection_queue.get_nowait()
                except Empty:
                    break
            
            # Create new connections
            for _ in range(self.pool_size):
                try:
                    conn = AuthServiceProxy(self.url)
                    # Test the connection with a simple call
                    conn.getblockcount()
                    self.connection_queue.put(conn)
                except Exception as e:
                    logger.error(f"Failed to create RPC connection: {e}")
            
            if self.connection_queue.empty():
                logger.error("Failed to create any RPC connections")
    
    def recreate_pool(self):
        """Recreate the entire connection pool"""
        current_time = time.time()
        
        # Check if we're in cooldown period
        if current_time - self.last_recreation_time < self.recreation_cooldown:
            logger.warning("RPC pool recreation in cooldown period, skipping recreation")
            return False
        
        with self.lock:
            logger.warning("Recreating entire RPC connection pool")
            
            # Close existing connections
            while not self.connection_queue.empty():
                try:
                    conn = self.connection_queue.get_nowait()
                    # No explicit close method for AuthServiceProxy, but we can 
                    # remove references to allow garbage collection
                    del conn
                except Empty:
                    break
            
            # Create new connections
            success = False
            for _ in range(self.pool_size):
                try:
                    conn = AuthServiceProxy(self.url)
                    # Test the connection with a simple call
                    conn.getblockcount()
                    self.connection_queue.put(conn)
                    success = True
                except Exception as e:
                    logger.error(f"Failed to create RPC connection during recreation: {e}")
            
            self.last_recreation_time = current_time
            
            if success:
                logger.info("Successfully recreated RPC connection pool")
                return True
            else:
                logger.error("Failed to recreate any RPC connections")
                return False
    
    @contextmanager
    def get_connection(self):
        """Get a connection from the pool"""
        conn = None
        try:
            # Try to get a connection with timeout
            try:
                conn = self.connection_queue.get(timeout=2)
            except Empty:
                # If queue is empty, try to recreate the pool
                logger.warning("RPC connection queue is empty, attempting to recreate")
                self.recreate_pool()
                try:
                    conn = self.connection_queue.get(timeout=2)
                except Empty:
                    logger.error("Failed to get RPC connection after recreation")
                    raise Exception("Error getting RPC connection")
            
            # Test connection before returning it
            try:
                # Simple ping test
                conn.getblockcount()
                yield conn
            except Exception as e:
                logger.error(f"RPC connection test failed: {e}")
                # Don't return this connection to the pool
                self.recreate_pool()
                raise
        except Exception as e:
            logger.error(f"Error getting RPC connection: {e}")
            raise
        else:
            # Return connection to the pool if it's still valid
            if conn:
                self.connection_queue.put(conn)

# Create the connection pool
rpc_pool = RPCConnectionPool(RPC_URL)

# --- RPC Helper Functions ---
def get_block(conn, block_hash, verbosity=2):
    """Get a block with the specified verbosity level"""
    return conn.getblock(block_hash, verbosity)

def get_best_block_hash(conn):
    """Get the hash of the best (tip) block in the most-work fully-validated chain"""
    return conn.getbestblockhash()

def get_block_hash(conn, height):
    """Get the hash of the block at the specified height"""
    return conn.getblockhash(height)

# --- Retry helper ---
def retry_rpc(func, description, *args, attempts=5, initial_delay=2, **kwargs):
    """
    Retry an RPC call with exponential backoff
    
    Args:
        func: The function to call with the connection as first argument
        description: A description of the call for logging
        *args: Additional positional arguments to pass to the function
        attempts: Maximum number of attempts
        initial_delay: Initial delay between attempts
        **kwargs: Additional keyword arguments to pass to the function
    """
    delay = initial_delay
    last_exception = None
    
    for attempt in range(1, attempts + 1):
        try:
            with rpc_pool.get_connection() as conn:
                result = func(conn, *args, **kwargs)
                logger.info(f"RPC call {description} succeeded on attempt {attempt}")
                return result
        except Exception as e:
            last_exception = e
            error_message = str(e)
            logger.error(f"RPC error during {description} (attempt {attempt}): {error_message}")
            
            # Check for specific error conditions that require special handling
            if "generator didn't yield" in error_message:
                logger.warning("Detected RPC connection issue, attempting to recreate connection pool")
                # Force recreation of the connection pool
                rpc_pool.recreate_pool()
                # Add a longer delay to allow connections to stabilize
                time.sleep(delay * 2)
            elif any(conn_err in error_message.lower() for conn_err in 
                    ["connection", "timeout", "refused", "reset", "broken pipe", "eof"]):
                logger.warning("Detected RPC connection issue, attempting to recreate connection pool")
                # Force recreation of the connection pool
                rpc_pool.recreate_pool()
                # Add a delay to allow connections to stabilize
                time.sleep(delay)
            
            # Add jitter to avoid thundering herd
            jitter = random.uniform(0.8, 1.2)
            adjusted_delay = delay * jitter
            
            if attempt < attempts:
                logger.info(f"Retrying in {adjusted_delay:.2f} seconds...")
                time.sleep(adjusted_delay)
                # Exponential backoff
                delay *= 2
            else:
                logger.error(f"Failed to execute RPC call {description} after {attempts} attempts")
                raise last_exception
    
    # This should never be reached, but just in case
    raise last_exception if last_exception else Exception(f"Failed to execute RPC call {description}")

# --- Mining Pool Identification System ---
class PoolsManager:
    def __init__(self, db, pool_json_url):
        self.db = db
        self.pool_json_url = pool_json_url
        self.pools = {}  # Cache of loaded pools
        self.pool_definitions_hash = None  # Track when definitions change
        self.reindexing = False  # Flag to prevent multiple reindexing operations
        
    def load_pools(self) -> dict:
        """Load pool definitions from GitHub or local cache"""
        max_retries = 3
        retry_delay = 5
        
        for attempt in range(1, max_retries + 1):
            try:
                logger.info(f"Fetching pool definitions from {self.pool_json_url} (attempt {attempt}/{max_retries})")
                
                # Add a longer timeout and custom headers to mimic a browser
                headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept': 'application/json'
                }
                response = requests.get(self.pool_json_url, headers=headers, timeout=30)
                response.raise_for_status()
                pool_data = response.json()
                
                # Calculate hash of the pool definitions to detect changes
                new_hash = hash(json.dumps(pool_data, sort_keys=True))
                definitions_changed = (self.pool_definitions_hash is not None and 
                                      self.pool_definitions_hash != new_hash)
                self.pool_definitions_hash = new_hash
                
                # Convert to dictionary keyed by uniqueId
                pools = {pool.get('id'): pool for pool in pool_data}
                self.pools = pools
                
                # Store in database
                self.db.pools.delete_many({})  # Clear existing
                self.db.pools.insert_many(pool_data)
                
                logger.info(f"Successfully loaded {len(pools)} mining pool definitions from GitHub")
                
                # If definitions changed, trigger reindexing
                if definitions_changed and self.db.blocks.count_documents({}) > 0:
                    logger.info("Pool definitions changed, scheduling reindexing of blocks")
                    threading.Thread(target=self.reindex_blocks, daemon=True).start()
                    
                return pools
                
            except requests.exceptions.SSLError as ssl_err:
                logger.error(f"SSL error fetching pool definitions (attempt {attempt}/{max_retries}): {ssl_err}")
                if attempt < max_retries:
                    logger.info(f"Retrying in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    logger.warning("Max retries exceeded for SSL error, falling back to local file or database")
            except requests.exceptions.RequestException as req_err:
                logger.error(f"Request error fetching pool definitions (attempt {attempt}/{max_retries}): {req_err}")
                if attempt < max_retries:
                    logger.info(f"Retrying in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    logger.warning("Max retries exceeded for request error, falling back to local file or database")
            except Exception as e:
                logger.error(f"Unexpected error loading mining pool list (attempt {attempt}/{max_retries}): {e}")
                if attempt < max_retries:
                    logger.info(f"Retrying in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    logger.warning("Max retries exceeded for unexpected error, falling back to local file or database")
        
        # Try to load from local file first
        try:
            if os.path.exists(LOCAL_POOL_FILE):
                logger.info(f"Attempting to load pool definitions from local file: {LOCAL_POOL_FILE}")
                with open(LOCAL_POOL_FILE, 'r') as f:
                    pool_data = json.load(f)
                    
                # Store in database to ensure consistency
                self.db.pools.delete_many({})
                self.db.pools.insert_many(pool_data)
                
                pools = {pool.get('id'): pool for pool in pool_data}
                self.pools = pools
                
                logger.info(f"Successfully loaded {len(pools)} mining pool definitions from local file")
                return pools
            else:
                logger.warning(f"Local pool file {LOCAL_POOL_FILE} not found, falling back to database")
        except Exception as file_err:
            logger.error(f"Error loading pool definitions from local file: {file_err}")
        
        # Fall back to database if available
        try:
            pool_data = list(self.db.pools.find({}, {"_id": 0}))
            if pool_data:
                logger.info(f"Loaded {len(pool_data)} mining pool definitions from database")
                return {pool.get('id'): pool for pool in pool_data}
            else:
                logger.warning("No pool definitions found in database")
                return {}
        except Exception as db_err:
            logger.error(f"Error loading pool definitions from database: {db_err}")
            return {}
    
    def identify_pool(self, coinbase_script_hex: str, coinbase_addresses: list) -> dict:
        """
        Identify pool using both coinbase addresses and coinbase tags.
        
        This follows the approach from the bitcoin-pool-identification Rust library:
        1. First try to identify by address (more reliable)
        2. Then try to identify by coinbase tag
        
        Returns a dictionary with pool information or an empty dictionary if no match is found.
        """
        if not self.pools:
            self.pools = self.load_pools()
            
        # First try to identify by address (more reliable)
        address_match = self._identify_by_address(coinbase_addresses)
        if address_match:
            return address_match
        
        # Then try to identify by coinbase tag
        tag_match = self._identify_by_tag(coinbase_script_hex)
        if tag_match:
            return tag_match
        
        # No match found
        return {}
    
    def _identify_by_address(self, coinbase_addresses: list) -> dict:
        """Identify pool by coinbase output addresses"""
        if not coinbase_addresses:
            return {}
            
        for pool_id, pool in self.pools.items():
            pool_addresses = pool.get('addresses', [])
            for addr in coinbase_addresses:
                if addr in pool_addresses:
                    return {
                        'id': pool_id,
                        'name': pool.get('name'),
                        'slug': pool.get('slug', pool.get('name', '').lower().replace(' ', '-')),
                        'link': pool.get('link'),
                        'match_type': 'address',
                        'identification_method': 'address'
                    }
        return {}
    
    def _identify_by_tag(self, coinbase_script_hex: str) -> dict:
        """Identify pool by coinbase tag in script_sig"""
        if not coinbase_script_hex:
            return {}
            
        try:
            # Decode coinbase script as UTF-8 (with replacement for invalid chars)
            # This matches the Rust implementation's coinbase_script_as_utf8 method
            coinbase_text = bytes.fromhex(coinbase_script_hex).decode('utf-8', errors='replace').replace('\n', '')
            
            for pool_id, pool in self.pools.items():
                # Check against tags
                for tag in pool.get('tags', []):
                    if tag in coinbase_text:
                        return {
                            'id': pool_id,
                            'name': pool.get('name'),
                            'slug': pool.get('slug', pool.get('name', '').lower().replace(' ', '-')),
                            'link': pool.get('link'),
                            'match_type': 'tag',
                            'identification_method': 'tag'
                        }
                
                # Check against regexes (additional feature not in the Rust code)
                for pattern in pool.get('regexes', []):
                    if re.search(pattern, coinbase_text, re.IGNORECASE):
                        return {
                            'id': pool_id,
                            'name': pool.get('name'),
                            'slug': pool.get('slug', pool.get('name', '').lower().replace(' ', '-')),
                            'link': pool.get('link'),
                            'match_type': 'tag',
                            'identification_method': 'tag'
                        }
        except Exception as e:
            logger.error(f"Error decoding coinbase script: {e}")
            
        return {}
    
    def reindex_blocks(self):
        """Reindex all blocks with updated pool information"""
        if self.reindexing:
            logger.info("Reindexing already in progress, skipping")
            return
            
        self.reindexing = True
        try:
            # Get a unique list of heights that need reindexing
            blocks_to_reindex = self.db.blocks.find({})
            
            logger.info(f"Starting to reindex pool information for blocks")
            
            count = 0
            for block in blocks_to_reindex:
                # Reprocess the block with updated pool definitions
                block_hash = block.get('block_hash')
                self.reprocess_block_pool_info(block_hash)
                count += 1
                
                if count % 100 == 0:
                    logger.info(f"Reindexed pool info for {count} blocks")
            
            logger.info(f"Completed reindexing pool information for {count} blocks")
        except Exception as e:
            logger.error(f"Error during block reindexing: {e}")
        finally:
            self.reindexing = False
    
    def reprocess_block_pool_info(self, block_hash: str):
        """Reprocess the pool information for a specific block"""
        try:
            # Get the block from the database
            block = self.db.blocks.find_one({"block_hash": block_hash})
            if not block:
                logger.warning(f"Block {block_hash} not found in database")
                return
            
            # Extract the coinbase script and addresses
            coinbase_script_hex = block.get("coinbase_script_sig", "")
            coinbase_addresses = block.get("coinbase_addresses", [])
            height = block.get("height")
            
            # Get the current pool identification
            current_pool = block.get("mining_pool", {})
            old_pool_name = current_pool.get("name", "Unknown")
            
            # Identify the pool
            mining_pool = self.identify_pool(coinbase_script_hex, coinbase_addresses)
            
            # If mining_pool is an empty dict, set default values
            if not mining_pool:
                mining_pool = {"name": "Unknown", "id": "unknown"}
                
            new_pool_name = mining_pool.get("name", "Unknown")
            
            # Update the block in the database if the pool identification changed
            if old_pool_name != new_pool_name:
                logger.info(f"Updating pool for block {block_hash} from '{old_pool_name}' to '{new_pool_name}'")
                
                # Update the block in the database
                self.db.blocks.update_one(
                    {"block_hash": block_hash}, 
                    {"$set": {"mining_pool": mining_pool}}
                )
                
                # Get the updated block and publish a full block update
                updated_block = self.db.blocks.find_one({"block_hash": block_hash})
                if updated_block:
                    # Convert ObjectId to string for JSON serialization
                    if "_id" in updated_block:
                        updated_block["_id"] = str(updated_block["_id"])
                    
                    # Publish a full block update to RabbitMQ
                    rabbitmq_doc = {
                        "type": "block",
                        "id": str(uuid.uuid4()),
                        "timestamp": datetime.utcnow().isoformat(),
                        "data": updated_block
                    }
                    publish_to_rabbitmq(rabbitmq_doc)
                    logger.info(f"Published block update for block {block_hash} with new pool info")
            
        except Exception as e:
            logger.error(f"Error reprocessing pool info for block {block_hash}: {e}")

# Create the pools manager
pools_manager = PoolsManager(db, POOL_LIST_URL)

# --- Block processing ---
def process_block(block_hash: str, is_new_block: bool = False):
    try:
        # Use a shorter timeout for new blocks to ensure responsiveness
        timeout = 30 if is_new_block else 120
        
        block = retry_rpc(
            get_block, 
            f"getblock({block_hash})",
            block_hash
        )
        height = block["height"]
        coinbase_tx = block["tx"][0]
        vin0 = coinbase_tx["vin"][0]
        if "scriptSig" in vin0 and "hex" in vin0["scriptSig"]:
            coinbase_script_sig = vin0["scriptSig"]["hex"]
        elif "coinbase" in vin0:
            coinbase_script_sig = vin0["coinbase"]
        else:
            raise KeyError("No coinbase script found")
            
        # Extract coinbase addresses - improved to match the Rust implementation
        coinbase_addresses = []
        for out in coinbase_tx["vout"]:
            script_pub_key = out.get("scriptPubKey", {})
            
            # First check for addresses array
            if "addresses" in script_pub_key:
                coinbase_addresses.extend(script_pub_key["addresses"])
            # Then check for single address
            elif "address" in script_pub_key:
                coinbase_addresses.append(script_pub_key["address"])
            # For newer Bitcoin Core versions that use 'address' field with descriptor
            elif "desc" in script_pub_key and "address" in script_pub_key:
                coinbase_addresses.append(script_pub_key["address"])
        
        # Sort addresses by value (descending) to match Rust implementation
        # This requires getting the values from the vout
        address_values = {}
        for out in coinbase_tx["vout"]:
            script_pub_key = out.get("scriptPubKey", {})
            value = out.get("value", 0)
            
            addresses = []
            if "addresses" in script_pub_key:
                addresses = script_pub_key["addresses"]
            elif "address" in script_pub_key:
                addresses = [script_pub_key["address"]]
            
            for addr in addresses:
                if addr in address_values:
                    address_values[addr] += value
                else:
                    address_values[addr] = value
        
        # Sort addresses by value (descending)
        coinbase_addresses = sorted(
            coinbase_addresses,
            key=lambda addr: address_values.get(addr, 0),
            reverse=True
        )
        
        # Identify mining pool using pools manager
        mining_pool = pools_manager.identify_pool(coinbase_script_sig, coinbase_addresses)
        
        doc = {
            "height": height,
            "coinbase_script_sig": coinbase_script_sig,
            "block_hash": block_hash,
            "timestamp": block["time"],
            "mining_pool": mining_pool
        }
        
        # For new blocks, use update_one with upsert to avoid duplicates
        # For old blocks during sync, use insert_one since we already checked for existence
        if is_new_block:
            blocks_coll.update_one({"block_hash": block_hash}, {"$set": doc}, upsert=True)
        else:
            blocks_coll.insert_one(doc)
            
        logger.info("%s block %d (%s) mined by %s", 
                   "Processed new" if is_new_block else "Synced old", 
                   height, block_hash, 
                   mining_pool.get('name') if mining_pool else 'Unknown')

        # Publish block update to RabbitMQ with type information
        rabbitmq_doc = {
            "type": "block",
            "id": str(uuid.uuid4()),
            "timestamp": datetime.utcnow().isoformat(),
            "data": {
                "hash": block_hash,
                "height": height,
                "timestamp": datetime.utcfromtimestamp(block["time"]).isoformat(),
                "mining_pool": mining_pool
            }
        }
        publish_to_rabbitmq(rabbitmq_doc)
    except Exception as e:
        logger.error("Error processing block %s: %s", block_hash, e)

def sync_blocks():
    """
    Sync blocks from the Bitcoin node
    """
    try:
        # Get the current best block
        best_block_hash = retry_rpc(
            get_best_block_hash, 
            "getbestblockhash"
        )
        best_block = retry_rpc(
            get_block, 
            f"getblock({best_block_hash})",
            best_block_hash
        )
        best_height = best_block["height"]
        
        # Get the highest block we've already processed
        highest_processed = db.blocks.find_one(sort=[("height", -1)])
        highest_processed_height = highest_processed["height"] if highest_processed else None
        
        # Get the lowest block we've already processed
        lowest_processed = db.blocks.find_one(sort=[("height", 1)])
        lowest_processed_height = lowest_processed["height"] if lowest_processed else None
        
        # Check if we need to sync from the tip down to the highest processed block
        if highest_processed_height is not None and highest_processed_height < best_height:
            logger.info(f"Syncing from tip ({best_height}) down to highest processed block ({highest_processed_height + 1})")
            sync_range(best_height, highest_processed_height + 1)
        elif highest_processed_height is None:
            logger.info(f"No blocks processed yet. Syncing from tip ({best_height}) down to MIN_BLOCK_HEIGHT ({MIN_BLOCK_HEIGHT})")
            sync_range(best_height, MIN_BLOCK_HEIGHT)
        else:
            logger.info(f"Already synced to tip at height {best_height}")
        
        # Check if we need to sync any missing blocks between MIN_BLOCK_HEIGHT and the lowest processed block
        if lowest_processed_height is not None and lowest_processed_height > MIN_BLOCK_HEIGHT:
            logger.info(f"Checking for missing blocks between MIN_BLOCK_HEIGHT ({MIN_BLOCK_HEIGHT}) and lowest processed block ({lowest_processed_height})")
            
            # Find missing blocks in the range using MongoDB's aggregation
            missing_blocks = []
            
            # First, get all heights in the range that are already processed
            processed_heights_in_range = set(
                doc["height"] for doc in db.blocks.find(
                    {"height": {"$gte": MIN_BLOCK_HEIGHT, "$lt": lowest_processed_height}},
                    {"height": 1, "_id": 0}
                )
            )
            
            # Then find the missing heights
            expected_heights = set(range(MIN_BLOCK_HEIGHT, lowest_processed_height))
            missing_blocks = sorted(list(expected_heights - processed_heights_in_range))
            
            logger.info(f"Expected {len(expected_heights)} blocks in range, found {len(processed_heights_in_range)} processed blocks")
            
            if missing_blocks:
                logger.info(f"Found {len(missing_blocks)} missing blocks between MIN_BLOCK_HEIGHT and lowest processed block")
                if len(missing_blocks) < 20:  # Only log all missing blocks if there aren't too many
                    logger.info(f"Missing blocks: {missing_blocks}")
                else:
                    logger.info(f"First 10 missing blocks: {missing_blocks[:10]}")
                    logger.info(f"Last 10 missing blocks: {missing_blocks[-10:]}")
                
                # If there are a large number of missing blocks, use a more efficient approach
                if len(missing_blocks) > 100:
                    logger.info(f"Large number of missing blocks detected ({len(missing_blocks)}). Using range-based processing.")
                    
                    # Find consecutive ranges of missing blocks
                    ranges = []
                    range_start = missing_blocks[0]
                    prev_height = missing_blocks[0]
                    
                    for height in missing_blocks[1:]:
                        if height != prev_height + 1:
                            # End of a consecutive range
                            ranges.append((prev_height, range_start))  # Note: reversed for sync_range (high to low)
                            range_start = height
                        prev_height = height
                    
                    # Add the last range
                    ranges.append((prev_height, range_start))  # Note: reversed for sync_range (high to low)
                    
                    logger.info(f"Identified {len(ranges)} consecutive ranges of missing blocks")
                    
                    # Process each range using sync_range
                    for range_end, range_start in ranges:  # Reversed order for sync_range
                        logger.info(f"Processing range from height {range_end} down to {range_start}")
                        sync_range(range_end, range_start)
                else:
                    # Process individual missing blocks in batches
                    batch_size = 5
                    for i in range(0, len(missing_blocks), batch_size):
                        batch = missing_blocks[i:i+batch_size]
                        logger.info(f"Processing batch of {len(batch)} missing blocks: {batch}")
                        
                        for height in batch:
                            try:
                                # Get the block hash for this height
                                block_hash = retry_rpc(
                                    get_block_hash, 
                                    f"getblockhash({height})",
                                    height
                                )
                                
                                logger.info(f"Syncing missing block at height {height} (hash: {block_hash})")
                                
                                # Process the block
                                process_block(block_hash, is_new_block=False)
                                
                                # Add a small delay between blocks
                                time.sleep(0.5)
                                
                            except Exception as e:
                                logger.error(f"Error processing missing block at height {height}: {e}")
                                continue
                        
                        # Add a delay between batches
                        logger.info(f"Completed batch of missing blocks, sleeping before next batch")
                        time.sleep(5)
                        
                        # Recreate the connection pool between batches
                        rpc_pool.recreate_pool()
            else:
                logger.info(f"No missing blocks found between MIN_BLOCK_HEIGHT and lowest processed block")
        
        logger.info("Block sync completed successfully")
        
    except Exception as e:
        logger.error(f"Error during block sync: {e}")

def sync_range(start_height, end_height):
    """
    Sync blocks in the specified range (from start_height down to end_height)
    """
    # Process blocks in small batches to avoid overwhelming the node
    batch_size = 5  # Reduced batch size for better stability
    
    for batch_start in range(start_height, end_height - 1, -batch_size):
        batch_end = max(batch_start - batch_size + 1, end_height)
        logger.info(f"Processing batch of blocks from {batch_start} to {batch_end}")
        
        # Process each block in the batch
        for height in range(batch_start, batch_end - 1, -1):
            try:
                # Get the block hash for this height
                block_hash = retry_rpc(
                    get_block_hash, 
                    f"getblockhash({height})",
                    height
                )
                
                # Check if we already have this block
                existing_block = db.blocks.find_one({"height": height})
                if existing_block:
                    logger.info(f"Block at height {height} already processed, skipping")
                    continue
                
                logger.info(f"Syncing missing block at height {height} (hash: {block_hash})")
                
                # Process the block
                process_block(block_hash, is_new_block=False)
                
                # Add a small delay between blocks to avoid overwhelming the node
                time.sleep(0.5)  # Increased delay between blocks
                
            except Exception as e:
                logger.error(f"Error processing block at height {height}: {e}")
                # Continue with the next block instead of failing the entire sync
                continue
        
        # Add a delay between batches to let the node breathe
        logger.info(f"Completed batch from {batch_start} to {batch_end}, sleeping before next batch")
        time.sleep(5)  # Increased delay between batches
        
        # Recreate the connection pool between batches to ensure fresh connections
        rpc_pool.recreate_pool()

def zmq_listener():
    context = zmq.Context()
    while True:
        try:
            socket = context.socket(zmq.SUB)
            # Use recv_multipart for a more robust read
            socket.setsockopt(zmq.SUBSCRIBE, b"rawblock")
            socket.connect(ZMQ_BLOCK)
            logger.info("ZMQ listener connected to %s", ZMQ_BLOCK)
            from bitcoin.core import CBlock
            while True:
                try:
                    parts = socket.recv_multipart()
                    if len(parts) < 2:
                        continue
                    topic, msg = parts[0], parts[1]
                    stream = BytesIO(msg)
                    block = CBlock.stream_deserialize(stream)
                    # Get block hash in correct little-endian format
                    bhash = block.GetHash()[::-1].hex()
                    logger.info("ZMQ received new block: %s", bhash)
                    # Submit new block to the dedicated new block processor
                    new_block_processor.submit(process_block, bhash, True)
                except Exception as inner_e:
                    logger.error("Error processing ZMQ message: %s", inner_e)
                    time.sleep(1)
        except Exception as outer_e:
            logger.error("ZMQ connection error: %s", outer_e)
            time.sleep(5)

def pool_updater_task():
    """Background task to periodically check for pool definition updates"""
    while True:
        try:
            logger.info("Checking for updates to mining pool definitions")
            pools_manager.load_pools()
            
            # Sleep for configured interval
            time.sleep(POOL_UPDATE_INTERVAL)
        except Exception as e:
            logger.error(f"Error in pool updater task: {e}")
            time.sleep(3600)  # Retry after an hour

# --- RabbitMQ Heartbeat Task ---
def rabbitmq_heartbeat_task():
    """
    Periodically check and maintain the RabbitMQ connection
    """
    HEARTBEAT_INTERVAL = 15  # seconds
    
    logger.info("Starting RabbitMQ heartbeat task")
    
    while True:
        try:
            # Check if connection is active and process any pending events
            if rabbitmq_manager.connection and not rabbitmq_manager.connection.is_closed:
                try:
                    # Process any pending events to keep the connection alive
                    rabbitmq_manager.connection.process_data_events(time_limit=0)
                    logger.debug("RabbitMQ heartbeat check successful")
                except Exception as e:
                    logger.warning(f"RabbitMQ heartbeat check failed: {e}")
                    # Force reconnection
                    rabbitmq_manager.connect()
            else:
                # Connection is closed or doesn't exist, try to reconnect
                logger.warning("RabbitMQ connection is closed during heartbeat check, reconnecting")
                rabbitmq_manager.connect()
                
        except Exception as e:
            logger.error(f"Error in RabbitMQ heartbeat task: {e}")
            
        time.sleep(HEARTBEAT_INTERVAL)

@app.on_event("startup")
def startup_event():
    """Initialize background tasks on startup"""
    logger.info("Starting up Bitcoin Mining Pool Identification Service")
    
    # Load pool definitions
    pools_manager.load_pools()
    
    # Start background threads
    sync_thread = threading.Thread(target=sync_blocks, daemon=True)
    sync_thread.start()
    
    zmq_thread = threading.Thread(target=zmq_listener, daemon=True)
    zmq_thread.start()
    
    pool_updater_thread = threading.Thread(target=pool_updater_task, daemon=True)
    pool_updater_thread.start()
    
    # Start RabbitMQ heartbeat thread
    rabbitmq_heartbeat_thread = threading.Thread(target=rabbitmq_heartbeat_task, daemon=True)
    rabbitmq_heartbeat_thread.start()
    
    # Note: We've removed the automatic reindexing that was here
    # If you need to reindex blocks, use the --reindex-blocks command line argument
    
    logger.info("Application startup complete")

@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Application shutdown: cleaning up resources")
    
    # Close RabbitMQ connection
    try:
        if rabbitmq_manager.connection and not rabbitmq_manager.connection.is_closed:
            logger.info("Closing RabbitMQ connection")
            rabbitmq_manager.connection.close()
    except Exception as e:
        logger.error(f"Error closing RabbitMQ connection: {e}")
    
    old_block_processor.shutdown(wait=True)
    new_block_processor.shutdown(wait=True)
    logger.info("Thread pools shut down")

if __name__ == "__main__":
    import argparse
    import uvicorn.config
    
    parser = argparse.ArgumentParser(description='Block indexer service')
    parser.add_argument('--update-pools', action='store_true', 
                        help='Update pool definitions and reindex blocks')
    parser.add_argument('--reindex-blocks', action='store_true',
                        help='Force reindexing of all blocks')
    args = parser.parse_args()
    
    # Handle command-line options
    if args.update_pools:
        logger.info("Manual update of pool definitions requested via command line")
        pools_manager.load_pools()
        
    if args.reindex_blocks:
        logger.info("Manual reindexing of blocks requested via command line")
        pools_manager.reindex_blocks()
    
    # Get port from environment variable
    port = int(os.getenv("PORT", "8001"))
    host = "0.0.0.0"  # Explicitly bind to all interfaces
    logger.info(f"Starting FastAPI server on {host}:{port}")
    config = uvicorn.config.Config(app, host=host, port=port, loop="asyncio")
    server = uvicorn.Server(config)
    server.run() 