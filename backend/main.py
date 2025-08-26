import os, time, threading, logging
from bitcoinrpc.authproxy import AuthServiceProxy
from io import BytesIO
import zmq
import uuid
from datetime import datetime
import concurrent.futures
from queue import Queue, Empty
from contextlib import contextmanager
from threading import Lock
import random
from distutils.util import strtobool
from typing import List, Dict, Any
from bitcoin_utils import extract_coinbase_data
from integrations import db, blocks_coll, pools_coll, mongodb_enabled, publish_to_rabbitmq, rabbitmq_manager
from integrations.rabbitmq import start_heartbeat_thread

# Global mining pool definitions cache
pools_cache: Dict[str, Dict[str, Any]] = {}
pools_hash: int | None = None

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
# Timeout in seconds for individual RPC HTTP operations
RPC_TIMEOUT = float(os.getenv("BITCOIN_RPC_TIMEOUT", "10"))
logger.info("Connecting to bitcoin RPC at %s:%s", RPC_HOST, RPC_PORT)

ZMQ_BLOCK = os.getenv("BITCOIN_ZMQ_BLOCK", "tcp://bitcoin-node:28332")
MIN_BLOCK_HEIGHT = int(os.getenv("MIN_BLOCK_HEIGHT", "882000"))

# MongoDB configuration is managed inside integrations.mongodb

POOL_LIST_URL = os.getenv("POOL_LIST_URL", "https://raw.githubusercontent.com/mempool/mining-pools/refs/heads/master/pools-v2.json")
POOL_UPDATE_INTERVAL = int(os.getenv("POOL_UPDATE_INTERVAL", "86400"))  # Default: once per day
LOCAL_POOL_FILE = os.getenv("LOCAL_POOL_FILE", "pool_definitions.json")  # Local fallback file

# Controls whether to start a full background reindex on startup
START_FULL_REINDEX_ON_BOOT = False

# --- Connections ---
def create_rpc_connection():
    for attempt in range(1, 6):
        try:
            conn = AuthServiceProxy(RPC_URL, timeout=RPC_TIMEOUT)
            conn.getblockcount()
            logger.info("Successfully connected to bitcoin RPC (attempt %d)", attempt)
            return conn
        except Exception as e:
            logger.error("RPC connection attempt %d failed: %s", attempt, e)
            # Reinitialize connection (do not log credentials)
            try:
                conn = AuthServiceProxy(RPC_URL, timeout=RPC_TIMEOUT)
                logger.info("Reinitialized bitcoin RPC connection on attempt %d", attempt)
                return conn
            except Exception as reinit_err:
                logger.error("Failed to reinitialize RPC connection on attempt %d: %s", attempt, reinit_err)
            time.sleep(2 ** attempt)
    raise Exception("Failed to connect to bitcoin RPC after multiple attempts")

bitcoin_rpc = create_rpc_connection()

# Create thread pool for block processing (ZMQ real-time handling)
block_processor = concurrent.futures.ThreadPoolExecutor(max_workers=2, thread_name_prefix="block_processor")

# --- RPC Connection Pool ---
class RPCConnectionPool:
    def __init__(self, url, pool_size=4, rpc_timeout: float = RPC_TIMEOUT):
        self.url = url
        self.pool_size = pool_size
        self.rpc_timeout = rpc_timeout
        self.connection_queue = Queue()
        self.lock = Lock()
        self.last_recreation_time = 0
        self.recreation_cooldown = 5  # seconds
        self._initialize_pool()
    
    def _initialize_pool(self):
        """Initialize the pool; connections are created per RPC call."""
        with self.lock:
            while not self.connection_queue.empty():
                try:
                    self.connection_queue.get_nowait()
                except Empty:
                    break
            logger.info("RPC pool initialized; connections are created per RPC call")
    
    def recreate_pool(self, force: bool = False):
        """Recreate the entire connection pool"""
        current_time = time.time()
        
        # Check if we're in cooldown period
        if not force and (current_time - self.last_recreation_time < self.recreation_cooldown):
            logger.warning("RPC pool recreation in cooldown period, skipping recreation")
            return False
        
        with self.lock:
            logger.warning("Recreating RPC connection pool")
            self.last_recreation_time = current_time
            logger.info("RPC pool recreation complete")
            return True
    
    @contextmanager
    def get_connection(self):
        """Get a connection from the pool"""
        conn = None
        try:
            # Create a fresh connection per use to avoid stale keep-alive sockets
            conn = AuthServiceProxy(self.url, timeout=self.rpc_timeout)
            yield conn
        finally:
            # No persistent connection to return; allow garbage collection
            conn = None

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
                rpc_pool.recreate_pool(force=True)
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


# --- Block processing ---
def build_block_doc(block_hash: str) -> Dict[str, Any]:
    block = retry_rpc(
        get_block,
        f"getblock({block_hash})",
        block_hash
    )
    height = block["height"]
    coinbase_script_sig, coinbase_addresses = extract_coinbase_data(block)

    analysis = {}
    try:
        if mongodb_enabled and db is not None:
            analysis = run_block_analyses(height, coinbase_script_sig, coinbase_addresses)
    except Exception as analysis_err:
        logger.error(f"Error running analyses for height {height}: {analysis_err}")
        analysis = {}

    mining_pool = {}
    try:
        if isinstance(analysis, dict) and analysis.get("pool_identification"):
            pool_info = analysis.get("pool_identification", {})
            mining_pool = pool_info.get("mining_pool", {}) or {}
            logger.info(
                "Pool identification via analysis: name=%s id=%s method=%s",
                mining_pool.get('name', 'Unknown'),
                mining_pool.get('id', 'unknown'),
                pool_info.get('method', 'unknown')
            )
        else:
            mining_pool = identify_pool_from_data(pools_cache, coinbase_script_sig, coinbase_addresses)
            logger.info(
                "Pool identification via fallback: name=%s id=%s",
                mining_pool.get('name', 'Unknown'),
                mining_pool.get('id', 'unknown')
            )
    except Exception as pool_err:
        logger.error(f"Error identifying mining pool at height {height}: {pool_err}")
        mining_pool = {"name": "Unknown", "id": "unknown"}

    doc = {
        "height": height,
        "coinbase_script_sig": coinbase_script_sig,
        "block_hash": block_hash,
        "timestamp": block["time"],
        "mining_pool": mining_pool,
        "analysis": analysis
    }
    return doc

def process_block(block_hash: str, is_new_block: bool = False):
    try:
        doc = build_block_doc(block_hash)
        height = doc["height"]
        # For new blocks, use update_one with upsert to avoid duplicates
        # For old blocks during sync, use insert_one since we already checked for existence
        if is_new_block:
            blocks_coll.update_one({"block_hash": block_hash}, {"$set": doc}, upsert=True)
        else:
            blocks_coll.insert_one(doc)

        logger.info("%s block %d (%s) mined by %s",
                   "Processed new" if is_new_block else "Synced old",
                   height, block_hash,
                   (doc.get("mining_pool") or {}).get('name') if doc.get("mining_pool") else 'Unknown')

        rabbitmq_doc = {
            "type": "block",
            "id": str(uuid.uuid4()),
            "timestamp": datetime.utcnow().isoformat(),
            "data": {
                "hash": block_hash,
                "height": height,
                "timestamp": datetime.utcfromtimestamp(doc["timestamp"]).isoformat(),
                "mining_pool": doc.get("mining_pool"),
                "analysis": doc.get("analysis")
            }
        }
        publish_to_rabbitmq(rabbitmq_doc)
    except Exception as e:
        logger.error("Error processing block %s: %s", block_hash, e)

def reprocess_block_full(block_hash: str, publish_update: bool = False):
    try:
        doc = build_block_doc(block_hash)
        height = doc["height"]
        blocks_coll.replace_one({"block_hash": block_hash}, doc, upsert=True)
        logger.info("Reindexed block %d (%s) with full overwrite", height, block_hash)
        if publish_update:
            rabbitmq_doc = {
                "type": "block",
                "id": str(uuid.uuid4()),
                "timestamp": datetime.utcnow().isoformat(),
                "data": {
                    "hash": block_hash,
                    "height": height,
                    "timestamp": datetime.utcfromtimestamp(doc["timestamp"]).isoformat(),
                    "mining_pool": doc.get("mining_pool"),
                    "analysis": doc.get("analysis")
                }
            }
            publish_to_rabbitmq(rabbitmq_doc)
    except Exception as e:
        logger.error("Error fully reprocessing block %s: %s", block_hash, e)

def start_full_reindex_background():
    try:
        if not mongodb_enabled or db is None:
            logger.warning("Historical data disabled or DB unavailable; skipping full reindex")
            return
        logger.info("Starting full background reindex of all blocks in descending height order")
        count = 0
        cursor = db.blocks.find({}, {"block_hash": 1, "height": 1, "_id": 0}).sort("height", -1)
        for doc in cursor:
            bhash = doc.get("block_hash")
            if not bhash:
                continue
            reprocess_block_full(bhash)
            count += 1
            if count % 100 == 0:
                logger.info(f"Reindexed {count} blocks so far (descending order)")
        logger.info(f"Completed full background reindex of {count} blocks")
    except Exception as e:
        logger.error(f"Error starting full background reindex: {e}")

from analytics.prev_hash_divergence import analyze_prev_hash_divergence
from analytics.invalid_coinbase_no_merkle import analyze_invalid_coinbase_without_merkle
from analytics.pool_identification import analyze_pool_identification, identify_pool_from_data, load_pools

def run_block_analyses(height: int, coinbase_script_hex: str | None = None, coinbase_addresses: List[str] | None = None) -> Dict[str, Any]:
    flags: List[Dict[str, Any]] = []
    analysis: Dict[str, Any] = {}
    logger.info("Running analyses for height %d", height)
    try:
        templates = list(db.mining_notify.find({"height": height})) if db is not None else []
    except Exception as e:
        logger.error(f"Error fetching mining.notify templates for height {height}: {e}")
        templates = []

    logger.info("Analysis: fetched %d templates for height %d", len(templates), height)
    if templates:
        prev_flag = analyze_prev_hash_divergence(templates, logger)
        if prev_flag:
            flags.append(prev_flag)
        invalid_flag = analyze_invalid_coinbase_without_merkle(templates, height, logger)
        if invalid_flag:
            flags.append(invalid_flag)
    else:
        logger.info("Analysis: no templates available for height %d", height)

    # Pool identification analysis if inputs provided
    if coinbase_script_hex is not None and coinbase_addresses is not None:
        try:
            analysis["pool_identification"] = analyze_pool_identification(
                coinbase_script_hex, coinbase_addresses, pools_cache, logger
            )
        except Exception as e:
            logger.error(f"Error during pool identification analysis for height {height}: {e}")

    if flags:
        analysis["flags"] = flags
    return analysis


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
                if len(missing_blocks) < 20:
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
                            ranges.append((prev_height, range_start))  # reversed for sync_range (high to low)
                            range_start = height
                        prev_height = height
                    
                    # Add the last range
                    ranges.append((prev_height, range_start))  # reversed for sync_range (high to low)
                    
                    logger.info(f"Identified {len(ranges)} consecutive ranges of missing blocks")
                    
                    # Process each range using sync_range
                    for range_end, range_start in ranges:  # reversed order for sync_range
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
    batch_size = 5
    
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
                time.sleep(0.5)
                
            except Exception as e:
                logger.error(f"Error processing block at height {height}: {e}")
                # Continue with the next block instead of failing the entire sync
                continue
        
        # Add a delay between batches to let the node breathe
        logger.info(f"Completed batch from {batch_start} to {batch_end}, sleeping before next batch")
        time.sleep(5)
        
        # Recreate the connection pool between batches to ensure fresh connections
        rpc_pool.recreate_pool()

def load_pools_once():
    global pools_cache, pools_hash
    try:
        pools, new_hash, _ = load_pools(db, POOL_LIST_URL, LOCAL_POOL_FILE, pools_hash)
        pools_cache = pools or {}
        pools_hash = new_hash
        logger.info(f"Initialized pools cache with {len(pools_cache)} entries")
    except Exception as e:
        logger.error(f"Failed to initialize pools cache: {e}")


def pool_updater_task():
    """Background task to periodically check for pool definition updates"""
    while True:
        try:
            logger.info("Checking for updates to mining pool definitions")
            global pools_cache, pools_hash
            pools, new_hash, changed = load_pools(db, POOL_LIST_URL, LOCAL_POOL_FILE, pools_hash)
            if pools:
                pools_cache = pools
                if new_hash is not None and new_hash != pools_hash:
                    pools_hash = new_hash
                    logger.info("Pool definitions changed; triggering background full reindex")
                    threading.Thread(target=start_full_reindex_background, daemon=True).start()
            time.sleep(POOL_UPDATE_INTERVAL)
        except Exception as e:
            logger.error(f"Error in pool updater task: {e}")
            time.sleep(3600)  # Retry after an hour

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
                    # Submit new block to the block processor
                    block_processor.submit(process_block, bhash, True)
                except Exception as inner_e:
                    logger.error("Error processing ZMQ message: %s", inner_e)
                    time.sleep(1)
        except Exception as outer_e:
            logger.error("ZMQ connection error: %s", outer_e)
            time.sleep(5)

# --- RabbitMQ Heartbeat Task ---
def rabbitmq_heartbeat_task():
    # Backward compatibility shim; delegate to integration module
    from integrations.rabbitmq import heartbeat_task
    return heartbeat_task()

def start_background_workers():
    """Initialize background tasks when running as a worker-only service."""
    logger.info("Starting background workers for Bitcoin Mining Pool Identification Service")
    load_pools_once()
    threading.Thread(target=sync_blocks, daemon=True).start()
    threading.Thread(target=zmq_listener, daemon=True).start()
    threading.Thread(target=pool_updater_task, daemon=True).start()
    start_heartbeat_thread()
    if START_FULL_REINDEX_ON_BOOT:
        logger.info("Starting full background reindex as requested by CLI flag")
        threading.Thread(target=start_full_reindex_background, daemon=True).start()
    logger.info("Background workers started")

def shutdown_cleanup():
    logger.info("Shutdown: cleaning up resources")
    try:
        if rabbitmq_manager.connection and not rabbitmq_manager.connection.is_closed:
            logger.info("Closing RabbitMQ connection")
            rabbitmq_manager.connection.close()
    except Exception as e:
        logger.error(f"Error closing RabbitMQ connection: {e}")
    block_processor.shutdown(wait=True)
    logger.info("Thread pools shut down")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description='Block indexer worker service')
    parser.add_argument('--reindex-blocks', action='store_true',
                        help='Force reindexing of all blocks')
    args = parser.parse_args()
    
    # Handle command-line options
    if args.reindex_blocks:
        logger.info("Manual full reindex requested; will run in background after startup")
        # Set flag to trigger background full reindex on app startup
        START_FULL_REINDEX_ON_BOOT = True
    
    # Start background workers instead of HTTP server
    start_background_workers()
    try:
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        shutdown_cleanup()