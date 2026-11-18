import os, time, threading, logging, json
import http.client, ssl, urllib.parse
from bitcoinrpc.authproxy import AuthServiceProxy
import zmq
import uuid
from datetime import datetime, timezone
import concurrent.futures
from queue import Queue, Empty
from contextlib import contextmanager
from threading import Lock
import random
from typing import Any, Dict, List, Optional
from bitcoin_utils import extract_coinbase_data
from integrations import store, publish_to_rabbitmq, rabbitmq_manager   # store: MongoDB or Postgres (DB_BACKEND)
from integrations.rabbitmq import start_heartbeat_thread
from header_fill import block_header_fields   # new blocks and the header fill share one mapping

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
# "https" for nodes behind a TLS proxy (e.g. StartOS). BITCOIN_RPC_CA_FILE: PEM bundle to trust for that
# endpoint (e.g. the StartOS root CA); when unset, the system trust store is used.
RPC_SCHEME = os.getenv("BITCOIN_RPC_SCHEME", "http")
RPC_CA_FILE = os.getenv("BITCOIN_RPC_CA_FILE") or None
RPC_URL = f"{RPC_SCHEME}://{RPC_USER}:{RPC_PASSWORD}@{RPC_HOST}:{RPC_PORT}"
# Timeout in seconds for individual RPC HTTP operations
RPC_TIMEOUT = float(os.getenv("BITCOIN_RPC_TIMEOUT", "10"))
logger.info("Connecting to bitcoin RPC at %s://%s:%s", RPC_SCHEME, RPC_HOST, RPC_PORT)

ZMQ_BLOCK = os.getenv("BITCOIN_ZMQ_BLOCK", "tcp://bitcoin-node:28332")
MIN_BLOCK_HEIGHT = int(os.getenv("MIN_BLOCK_HEIGHT", "882000"))

# MongoDB configuration is managed inside integrations.mongodb

POOL_LIST_URL = os.getenv("POOL_LIST_URL", "https://raw.githubusercontent.com/mempool/mining-pools/refs/heads/master/pools-v2.json")
POOL_UPDATE_INTERVAL = int(os.getenv("POOL_UPDATE_INTERVAL", "86400"))  # Default: once per day
LOCAL_POOL_FILE = os.getenv("LOCAL_POOL_FILE", "pool_definitions.json")  # Local fallback file

# Controls whether to start a full background reindex on startup
START_FULL_REINDEX_ON_BOOT = False

# Best-chain reconciliation (#212, reconcile.py): after each sync, each new block and each reorg the stale-block
# tracker sees, the last BLOCK_GAP_WINDOW heights below the tip are compared with the node's active chain. A missing
# block (e.g. the database was unreachable when it arrived) is fetched; a stored block the node no longer has at that
# height (a reorg) is replaced by the node's and marked stale. The startup sync only fills below the lowest and above
# the highest stored block, and never replaces one. 0 turns the window off.
BLOCK_GAP_WINDOW = int(os.getenv("BLOCK_GAP_WINDOW", "144"))

# Historical gap fill (gap_fill.py): at startup (after the sync) and then every BLOCK_GAP_FILL_INTERVAL_S seconds,
# every height missing between MIN_BLOCK_HEIGHT and the stored tip is fetched; on a pruned node the node first
# downloads the block again from a peer (getblockfrompeer). At most BLOCK_GAP_FILL_MAX_BLOCKS blocks per run, up to
# BLOCK_GAP_FILL_PEERS peers per block, BLOCK_GAP_FILL_PEER_TIMEOUT_S seconds each. No gaps = two indexed reads, no
# RPC. 0 turns it off.
BLOCK_GAP_FILL_INTERVAL_S = float(os.getenv("BLOCK_GAP_FILL_INTERVAL_S", "3600"))
BLOCK_GAP_FILL_MAX_BLOCKS = int(os.getenv("BLOCK_GAP_FILL_MAX_BLOCKS", "50"))
BLOCK_GAP_FILL_PEERS = int(os.getenv("BLOCK_GAP_FILL_PEERS", "3"))
BLOCK_GAP_FILL_PEER_TIMEOUT_S = float(os.getenv("BLOCK_GAP_FILL_PEER_TIMEOUT_S", "30"))
# Header fill (header_fill.py): after each gap-fill run, up to HEADER_FILL_MAX_BLOCKS stored blocks without header
# columns (tx_count, version, merkle_root, bits, nonce, difficulty, size, weight) get them from getblockheader.
# 0 = off. Postgres only.
HEADER_FILL_MAX_BLOCKS = int(os.getenv("HEADER_FILL_MAX_BLOCKS", "20000"))
# Coinbase fill (coinbase_fill.py, #235): after each gap-fill run, up to COINBASE_FILL_MAX_BLOCKS stored blocks without
# merkle branches get them (and the coinbase txid) from getblock verbosity 1, newest first, until the first block
# the node has pruned. 0 = off. Postgres only.
COINBASE_FILL_MAX_BLOCKS = int(os.getenv("COINBASE_FILL_MAX_BLOCKS", "1000"))

# --- Connections ---
def new_rpc_proxy(url=None, timeout=None):
    """AuthServiceProxy that verifies https endpoints against RPC_CA_FILE when one is configured."""
    url = url or RPC_URL
    timeout = RPC_TIMEOUT if timeout is None else timeout
    if url.startswith("https://") and RPC_CA_FILE:
        parsed = urllib.parse.urlparse(url)
        context = ssl.create_default_context(cafile=RPC_CA_FILE)
        connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=timeout, context=context)
        return AuthServiceProxy(url, timeout=timeout, connection=connection)
    return AuthServiceProxy(url, timeout=timeout)

def create_rpc_connection():
    for attempt in range(1, 6):
        try:
            conn = new_rpc_proxy()
            conn.getblockcount()
            logger.info("Successfully connected to bitcoin RPC (attempt %d)", attempt)
            return conn
        except Exception as e:
            logger.error("RPC connection attempt %d failed: %s", attempt, e)
            # Reinitialize connection (do not log credentials)
            try:
                conn = new_rpc_proxy()
                logger.info("Reinitialized bitcoin RPC connection on attempt %d", attempt)
                return conn
            except Exception as reinit_err:
                logger.error("Failed to reinitialize RPC connection on attempt %d: %s", attempt, reinit_err)
            time.sleep(2 ** attempt)
    raise Exception("Failed to connect to bitcoin RPC after multiple attempts")

bitcoin_rpc = create_rpc_connection()

# Block processing (ZMQ real-time handling and best-chain reconciliation). One worker: every write of a block at a
# height goes through it in order, so a new tip and the reconciliation after it never race for the same height.
block_processor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="block_processor")

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
            conn = new_rpc_proxy(self.url, self.rpc_timeout)
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

class PrunedBlockError(Exception):
    """The node no longer has this block's data (pruned). Not retried."""


def is_pruned_error(exc: Exception) -> bool:
    return "pruned data" in str(exc).lower()


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
            if is_pruned_error(e):
                # Permanent: a pruned node will never serve this block, so retrying only wastes time (#135).
                raise PrunedBlockError(f"{description}: {e}") from e
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
        if store.enabled:
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
        "analysis": analysis,
    }
    doc.update(block_header_fields(block))
    doc.update(block_coinbase_fields(block, block_hash))
    return doc


def block_coinbase_fields(block: Dict[str, Any], block_hash: str) -> Dict[str, Any]:
    """The block's merkle branches, coinbase txid and coinbase (coinbase.py, #235), self-checked. If the node's data
    doesn't check out, none of them (logged): never unverified facts."""
    from coinbase import coinbase_facts
    try:
        return coinbase_facts(block) or {}
    except (ValueError, KeyError, IndexError) as e:
        logger.warning("block %s: coinbase/merkle facts not stored (self-check failed): %s", block_hash, e)
        return {}


def process_block(block_hash: str, is_new_block: bool = False, seen_at: Optional[datetime] = None,
                  seen_via: Optional[str] = None) -> bool:
    """Fetch, analyse, store and publish one block. is_new_block: seen live (MongoDB: upsert by hash; Postgres: sets
    blocks.seen_at to seen_at, or to now when none is given, and blocks.seen_via, both only the first time).
    Returns False when it failed (logged)."""
    return process_block_status(block_hash, is_new_block, seen_at, seen_via) == "ok"


def process_block_status(block_hash: str, is_new_block: bool = False, seen_at: Optional[datetime] = None,
                         seen_via: Optional[str] = None) -> str:
    """process_block, returning "ok", "pruned" (the node no longer has the block's data) or "error"."""
    try:
        doc = build_block_doc(block_hash)
        height = doc["height"]
        store.save_block(doc, is_new_block, seen_at=seen_at, seen_via=seen_via)

        logger.info("%s block %d (%s) mined by %s",
                   "Processed new" if is_new_block else "Synced old",
                   height, block_hash,
                   (doc.get("mining_pool") or {}).get('name') if doc.get("mining_pool") else 'Unknown')

        rabbitmq_doc = {
            "type": "block",
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": {
                "hash": block_hash,
                "height": height,
                "timestamp": datetime.fromtimestamp(doc["timestamp"], timezone.utc).isoformat(),
                "mining_pool": doc.get("mining_pool"),
                "analysis": doc.get("analysis")
            }
        }
        publish_to_rabbitmq(rabbitmq_doc)
        return "ok"
    except PrunedBlockError as e:
        logger.warning("Block %s not processed, the node has pruned it: %s", block_hash, e)
        return "pruned"
    except Exception as e:
        logger.error("Error processing block %s: %s", block_hash, e)
        return "error"

def reprocess_block_full(block_hash: str, publish_update: bool = False) -> str:
    """Rebuild one block from RPC. Returns "ok", "pruned" or "error"."""
    try:
        doc = build_block_doc(block_hash)
        height = doc["height"]
        store.replace_block(doc)
        logger.info("Reindexed block %d (%s) with full overwrite", height, block_hash)
        if publish_update:
            rabbitmq_doc = {
                "type": "block",
                "id": str(uuid.uuid4()),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "data": {
                    "hash": block_hash,
                    "height": height,
                    "timestamp": datetime.fromtimestamp(doc["timestamp"], timezone.utc).isoformat(),
                    "mining_pool": doc.get("mining_pool"),
                    "analysis": doc.get("analysis")
                }
            }
            publish_to_rabbitmq(rabbitmq_doc)
        return "ok"
    except PrunedBlockError:
        return "pruned"
    except Exception as e:
        logger.error("Error fully reprocessing block %s: %s", block_hash, e)
        return "error"

# --- Reindexing (#135) ---
# At most one reindex runs at a time. A pool-definition change only re-runs pool identification from the data already
# stored with each block (coinbase scriptSig + coinbase addresses): no RPC, so a pruned node doesn't matter. The full
# RPC rebuild (--reindex-blocks) is explicit and skips blocks the node no longer has.
_reindex_lock = threading.Lock()
_reidentify_requested = threading.Event()
UNKNOWN_POOL = {"name": "Unknown", "id": "unknown"}


def _spawn(target):
    threading.Thread(target=target, daemon=True).start()


def start_full_reindex_background():
    if not _reindex_lock.acquire(blocking=False):
        logger.warning("A reindex is already running; not starting a full reindex")
        return
    try:
        if not store.enabled:
            logger.warning("Historical data disabled or DB unavailable; skipping full reindex")
            return
        logger.info("Starting full background reindex of all blocks in descending height order")
        counts = {"ok": 0, "pruned": 0, "error": 0}
        for doc in store.block_hashes_by_height_desc():
            bhash = doc.get("block_hash")
            if not bhash:
                continue
            counts[reprocess_block_full(bhash)] += 1
            done = sum(counts.values())
            if done % 1000 == 0:
                logger.info("Full reindex: %d blocks so far (%s)", done, counts)
        logger.info("Completed full reindex: %s (pruned = no longer on the node, left unchanged)", counts)
    except Exception as e:
        logger.error(f"Error during full background reindex: {e}")
    finally:
        _reindex_lock.release()


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


def reidentify_pools() -> Dict[str, int]:
    """Re-run pool identification for every stored block with the current definitions; write only what changed."""
    stats = {"checked": 0, "changed": 0, "skipped_no_addresses": 0, "errors": 0}
    if not store.enabled:
        logger.warning("Historical data disabled or DB unavailable; skipping pool re-identification")
        return stats
    pools = pools_cache
    if not pools:
        logger.warning("No pool definitions loaded; skipping pool re-identification")
        return stats
    logger.info("Re-identifying pools for stored blocks with %d pool definitions", len(pools))
    for block in store.blocks_for_reidentify():
        stats["checked"] += 1
        try:
            previous = block.get("pool_identification")
            addresses = previous.get("addresses_considered") if isinstance(previous, dict) else None
            if not isinstance(addresses, list):
                # No stored coinbase addresses (block indexed before the analysis existed): re-identifying from the
                # tag alone could downgrade a correct address match, so leave the block as it is.
                stats["skipped_no_addresses"] += 1
                continue
            found = identify_pool_from_data(pools, block.get("coinbase_script_sig") or "", addresses)
            mining_pool = found or dict(UNKNOWN_POOL)
            pool_identification = {"mining_pool": mining_pool,
                                   "method": found.get("identification_method", "unknown") if found else "none",
                                   "addresses_considered": addresses}
            if _same(mining_pool, block.get("mining_pool")) and _same(pool_identification, previous):
                continue
            store.update_block_pool(block["block_hash"], mining_pool, pool_identification,
                                    analysis_is_object=block.get("analysis_is_object", True))
            stats["changed"] += 1
            logger.info("Pool re-identified at height %s: %s -> %s", block.get("height"),
                        (block.get("mining_pool") or {}).get("name"), mining_pool.get("name"))
        except Exception as e:
            stats["errors"] += 1
            logger.error("Error re-identifying pool for block %s: %s", block.get("block_hash"), e)
        if stats["checked"] % 10000 == 0:
            logger.info("Pool re-identification: %s", stats)
    logger.info("Completed pool re-identification: %s", stats)
    return stats


def _reidentify_worker():
    try:
        while _reidentify_requested.is_set():
            _reidentify_requested.clear()
            reidentify_pools()
    except Exception as e:
        logger.error(f"Error during pool re-identification: {e}")
    finally:
        _reindex_lock.release()
    if _reidentify_requested.is_set():   # requested between the last check and the release
        request_pool_reidentify()


def request_pool_reidentify():
    """Ask for a re-identification pass. Never stacks: a request during a pass makes it run once more afterwards."""
    _reidentify_requested.set()
    if _reindex_lock.acquire(blocking=False):
        _spawn(_reidentify_worker)
    else:
        logger.info("A reindex is already running; pool re-identification will run (again) when it finishes")

from analytics.prev_hash_divergence import analyze_prev_hash_divergence
from analytics.invalid_coinbase_no_merkle import analyze_invalid_coinbase_without_merkle
from analytics.pool_identification import analyze_pool_identification, identify_pool_from_data, load_pools

def run_block_analyses(height: int, coinbase_script_hex: str | None = None, coinbase_addresses: List[str] | None = None) -> Dict[str, Any]:
    flags: List[Dict[str, Any]] = []
    analysis: Dict[str, Any] = {}
    logger.info("Running analyses for height %d", height)
    try:
        templates = store.templates_at_height(height) if store.enabled else []
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
        highest_processed_height = store.highest_block_height()
        
        # Get the lowest block we've already processed
        lowest_processed_height = store.lowest_block_height()
        
        # Check if we need to sync from the tip down to the highest processed block
        if highest_processed_height is not None and highest_processed_height < best_height:
            logger.info(f"Syncing from tip ({best_height}) down to highest processed block ({highest_processed_height + 1})")
            sync_range(best_height, highest_processed_height + 1)
        elif highest_processed_height is None:
            logger.info(f"No blocks processed yet. Syncing from tip ({best_height}) down to MIN_BLOCK_HEIGHT ({MIN_BLOCK_HEIGHT})")
            sync_range(best_height, MIN_BLOCK_HEIGHT)
        else:
            logger.info(f"Already synced to tip at height {best_height}")

        # Interior gaps and replaced blocks in the recent window (the checks above only extend the stored range at
        # both ends). On the block processor, so it never races a new block's processing.
        block_processor.submit(reconcile_recent_window)
        
        # Check if we need to sync any missing blocks between MIN_BLOCK_HEIGHT and the lowest processed block
        if lowest_processed_height is not None and lowest_processed_height > MIN_BLOCK_HEIGHT:
            logger.info(f"Checking for missing blocks between MIN_BLOCK_HEIGHT ({MIN_BLOCK_HEIGHT}) and lowest processed block ({lowest_processed_height})")
            
            # First, get all heights in the range that are already processed
            processed_heights_in_range = store.block_heights_between(MIN_BLOCK_HEIGHT, lowest_processed_height)
            
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


def node_block_hashes(heights) -> Dict[int, str]:
    """The node's active-chain hash at each height, on one RPC connection. A height that fails is left out (the
    reconciler retries it next time)."""
    out: Dict[int, str] = {}
    with rpc_pool.get_connection() as conn:
        for height in heights:
            try:
                out[height] = conn.getblockhash(height)
            except Exception as e:
                logger.error("getblockhash(%d) failed: %s", height, e)
    return out


def mark_replaced_blocks(hashes) -> None:
    """Mark stored blocks the node's active chain no longer has as not best. Postgres: stale_blocks rows written by
    the stale-block tracker's code (blocks_best hides them; this runs even with STALE_BLOCKS_ENABLED=false). MongoDB:
    `stale: true` on the document."""
    if getattr(store, "supports_stale_blocks", False):
        stale_recorder().record_replaced(list(hashes))
    else:
        store.mark_blocks_stale(list(hashes))


_reconciler = None


def reconcile_recent_window(low_height=None) -> Dict[str, int]:
    """Make the stored best chain equal the node's active chain over the recent window (reconcile.py). Run it on the
    block processor. low_height: check from there instead (a reorg's fork point + 1). Never raises."""
    global _reconciler
    try:
        if _reconciler is None:
            from reconcile import BestChainReconciler
            _reconciler = BestChainReconciler(
                node_height=lambda: node_rpc("getblockcount"), node_hashes=node_block_hashes, store=store,
                # seen live, but found by the reconciliation, not announced: seen_at = detection time, marked as such
                store_block=lambda h: process_block(h, is_new_block=True, seen_via="reconcile"),
                mark_replaced=mark_replaced_blocks, window=BLOCK_GAP_WINDOW, min_height=MIN_BLOCK_HEIGHT)
        return _reconciler.reconcile(low_height)
    except Exception as e:
        logger.error("Best-chain reconciliation failed (retried on the next block): %s", e)
        return {}


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
                if store.has_block_at_height(height):
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
        pools, new_hash, _ = load_pools(store, POOL_LIST_URL, LOCAL_POOL_FILE, pools_hash)
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
            pools, new_hash, changed = load_pools(store, POOL_LIST_URL, LOCAL_POOL_FILE, pools_hash)
            if pools:
                pools_cache = pools
                if new_hash is not None and new_hash != pools_hash:
                    pools_hash = new_hash
                    logger.info("Pool definitions changed; re-identifying pools from stored block data")
                    request_pool_reidentify()
            time.sleep(POOL_UPDATE_INTERVAL)
        except Exception as e:
            logger.error(f"Error in pool updater task: {e}")
            time.sleep(3600)  # Retry after an hour

def zmq_listener():
    context = zmq.Context()
    while True:
        try:
            socket = context.socket(zmq.SUB)
            # Subscribe to hashblock instead of rawblock
            socket.setsockopt(zmq.SUBSCRIBE, b"hashblock")
            socket.connect(ZMQ_BLOCK)
            logger.info("ZMQ listener connected to %s (topic: hashblock)", ZMQ_BLOCK)
            while True:
                try:
                    parts = socket.recv_multipart()
                    # The block's arrival time, taken before anything else: blocks.seen_at used to be the time of the DB
                    # save, after getblock, the analyses and the queue (median 0.84 s, max 40 s later than this).
                    received_at = datetime.now(timezone.utc)
                    if len(parts) < 2:
                        continue
                    topic, msg = parts[0], parts[1]
                    
                    if topic == b"hashblock":
                        # msg is already in RPC/display byte order (reversed by Bitcoin Core before sending)
                        bhash = msg.hex()
                        logger.info("ZMQ received new block hash: %s", bhash)
                        # Submit new block to the block processor
                        block_processor.submit(process_block, bhash, True, received_at, "zmq")
                        # Then the recent window against the node's chain: blocks a reorg replaced (ZMQ announces only
                        # the new tip) and blocks that failed earlier (e.g. the DB was down when they came)
                        block_processor.submit(reconcile_recent_window)
                        if stale_tracker is not None:
                            stale_tracker.request_poll()   # a new tip may have made another branch stale
                        
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

# --- Stale blocks (#180) ---
# Postgres mode only (stale_blocks table); STALE_BLOCKS_ENABLED=false turns it off. See stale_blocks.py.
STALE_BLOCKS_ENABLED = os.getenv("STALE_BLOCKS_ENABLED", "true").strip().lower() not in ("n", "no", "f", "false", "off", "0")
STALE_POLL_INTERVAL_S = float(os.getenv("STALE_POLL_INTERVAL_S", "60"))   # timer between polls (new blocks poll at once)
stale_tracker = None


def node_rpc(method, *args):
    """One RPC call, no retries (the stale-block poll runs again on the next block or timer tick)."""
    with rpc_pool.get_connection() as conn:
        return getattr(conn, method)(*args)


_stale_recorder = None


def stale_recorder():
    """The StaleBlockTracker (Postgres mode). Also built when its poll loop is off: the reconciler records the blocks
    it replaces through it."""
    global _stale_recorder
    if _stale_recorder is None:
        from stale_blocks import StaleBlockTracker
        _stale_recorder = StaleBlockTracker(
            node_rpc, store, identify_pool=lambda script, addresses: identify_pool_from_data(pools_cache, script, addresses),
            # a reorg the poll saw: reconcile from its fork point (may be deeper than the window, and runs with
            # BLOCK_GAP_WINDOW=0 too); this stores the newly active blocks ZMQ didn't announce
            on_reorg=lambda fork_height, tip_height, tip_hash: block_processor.submit(reconcile_recent_window, fork_height + 1))
    return _stale_recorder


def _after_stale_poll(stats) -> None:
    if stats.get("reactivated"):   # a recorded stale block is active again: our best chain may have to follow
        block_processor.submit(reconcile_recent_window)


def start_stale_block_tracker():
    global stale_tracker
    if not (STALE_BLOCKS_ENABLED and store.enabled and getattr(store, "supports_stale_blocks", False)):
        logger.info("Stale block tracking off (needs DB_BACKEND=postgres; STALE_BLOCKS_ENABLED=%s)", STALE_BLOCKS_ENABLED)
        return
    stale_tracker = stale_recorder()
    threading.Thread(target=stale_tracker.run_forever, args=(STALE_POLL_INTERVAL_S, _after_stale_poll), daemon=True,
                     name="stale_blocks").start()
    logger.info("Stale block tracking started")


# --- Historical gap fill (gap_fill.py) ---
def gap_filler():
    from gap_fill import HistoricalGapFiller
    return HistoricalGapFiller(
        rpc=node_rpc, store=store,
        store_block=lambda h: process_block_status(h, is_new_block=False),   # synced, not seen live
        # serialised with new blocks; only the store step runs there, never the wait for a peer
        on_block_processor=lambda fn: block_processor.submit(fn).result(),
        min_height=MIN_BLOCK_HEIGHT, max_blocks=BLOCK_GAP_FILL_MAX_BLOCKS, max_peers=BLOCK_GAP_FILL_PEERS,
        peer_timeout=BLOCK_GAP_FILL_PEER_TIMEOUT_S)


def sync_then_fill_gaps():
    """The startup sync, then the historical gap fill now and every BLOCK_GAP_FILL_INTERVAL_S seconds."""
    sync_blocks()
    if BLOCK_GAP_FILL_INTERVAL_S <= 0 or not store.enabled:
        logger.info("Historical gap fill off (BLOCK_GAP_FILL_INTERVAL_S=%s)", BLOCK_GAP_FILL_INTERVAL_S)
        return
    filler = gap_filler()
    headers = None
    if HEADER_FILL_MAX_BLOCKS > 0:
        from header_fill import BlockHeaderFiller
        headers = BlockHeaderFiller(rpc=node_rpc, store=store, header_fields=block_header_fields,
                                    max_blocks=HEADER_FILL_MAX_BLOCKS)
    coinbases = None
    if COINBASE_FILL_MAX_BLOCKS > 0:
        from coinbase_fill import BlockCoinbaseFiller
        coinbases = BlockCoinbaseFiller(rpc=node_rpc, store=store, max_blocks=COINBASE_FILL_MAX_BLOCKS)
    while True:
        try:
            filler.run()
        except Exception as e:
            logger.error("Historical gap fill failed (retried next run): %s", e)
        if coinbases is not None:
            try:
                coinbases.run()
            except Exception as e:
                logger.error("Coinbase fill failed (retried next run): %s", e)
        if headers is not None:
            try:
                headers.run()
            except Exception as e:
                logger.error("Header fill failed (retried next run): %s", e)
        time.sleep(BLOCK_GAP_FILL_INTERVAL_S)


def start_background_workers():
    """Initialize background tasks when running as a worker-only service."""
    logger.info("Starting background workers for Bitcoin Mining Pool Identification Service")
    load_pools_once()
    start_stale_block_tracker()
    threading.Thread(target=sync_then_fill_gaps, daemon=True, name="sync_gap_fill").start()
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
