import os, time, threading, logging
from fastapi import FastAPI
from bitcoinrpc.authproxy import AuthServiceProxy, JSONRPCException
from pymongo import MongoClient
from pydantic import BaseModel
import uvicorn
from io import BytesIO
import zmq

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
            time.sleep(2 ** attempt)
    raise Exception("Failed to connect to bitcoin RPC after multiple attempts")

bitcoin_rpc = create_rpc_connection()

try:
    mongo_client = MongoClient(MONGO_URL, username=MONGO_USER, password=MONGO_PASSWORD)
    db = mongo_client[MONGO_DB]
    blocks_coll = db.blocks
    logger.info("Connected to MongoDB at %s", MONGO_URL)
except Exception as e:
    logger.error("Error connecting to MongoDB: %s", e)
    raise

# --- FastAPI app and models ---
app = FastAPI()
class BlockModel(BaseModel):
    height: int
    coinbase_script_sig: str
    block_hash: str
    timestamp: int

# Event to signal that block sync is complete.
sync_complete_event = threading.Event()

@app.get("/blocks")
def get_blocks(n: int = 20):
    sync_complete_event.wait()
    try:
        blocks = list(blocks_coll.find({}, {"_id": 0}).sort("height", -1).limit(n))
        logger.info("API call /blocks succeeded: %d blocks returned", len(blocks))
        return blocks
    except Exception as e:
        logger.error("API call /blocks failed: %s", e)
        return {"error": str(e)}

# --- Retry helper ---
def retry_rpc(func, description, attempts=5, initial_delay=2):
    global bitcoin_rpc
    delay = initial_delay
    for i in range(1, attempts + 1):
        try:
            result = func()
            logger.info("RPC call %s succeeded on attempt %d", description, i)
            return result
        except Exception as e:
            logger.error("RPC error during %s (attempt %d): %s", description, i, e)
            # Reinitialize connection (do not log credentials)
            try:
                bitcoin_rpc = create_rpc_connection()
                logger.info("Reinitialized bitcoin RPC connection on attempt %d", i)
            except Exception as reinit_err:
                logger.error("Failed to reinitialize RPC connection on attempt %d: %s", i, reinit_err)
            if i < attempts:
                time.sleep(delay)
                delay *= 2
            else:
                raise e

# --- Block processing ---
def process_block(block_hash: str):
    try:
        block = retry_rpc(lambda: bitcoin_rpc.getblock(block_hash, 2), f"getblock({block_hash})")
        height = block["height"]
        coinbase_tx = block["tx"][0]
        vin0 = coinbase_tx["vin"][0]
        if "scriptSig" in vin0 and "hex" in vin0["scriptSig"]:
            coinbase_script_sig = vin0["scriptSig"]["hex"]
        elif "coinbase" in vin0:
            coinbase_script_sig = vin0["coinbase"]
        else:
            raise KeyError("No coinbase script found")
        doc = {
            "height": height,
            "coinbase_script_sig": coinbase_script_sig,
            "block_hash": block_hash,
            "timestamp": block["time"]
        }
        blocks_coll.update_one({"block_hash": block_hash}, {"$set": doc}, upsert=True)
        logger.info("Processed block %d (%s)", height, block_hash)
    except Exception as e:
        logger.error("Error processing block %s: %s", block_hash, e)

def sync_blocks():
    try:
        best_block_hash = retry_rpc(lambda: bitcoin_rpc.getbestblockhash(), "getbestblockhash")
        best_block = retry_rpc(lambda: bitcoin_rpc.getblock(best_block_hash), f"getblock({best_block_hash})")
        tip = best_block["height"]
        logger.info("Starting initial block sync: tip=%d, MIN_BLOCK_HEIGHT=%d", tip, MIN_BLOCK_HEIGHT)
        for h in range(tip, MIN_BLOCK_HEIGHT - 1, -1):
            bhash = retry_rpc(lambda: bitcoin_rpc.getblockhash(h), f"getblockhash({h})")
            if not blocks_coll.find_one({"block_hash": bhash}):
                logger.info("Syncing missing block at height %d (hash: %s)", h, bhash)
                process_block(bhash)
            else:
                logger.info("Block at height %d (hash: %s) already synced; skipping", h, bhash)
        logger.info("Initial block sync complete.")
        sync_complete_event.set()
    except Exception as e:
        logger.error("Error during block sync: %s", e)

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
                    bhash = format(int.from_bytes(block.GetHash(), byteorder='big'), '064x')
                    logger.info("ZMQ received new block: %s", bhash)
                    process_block(bhash)
                except Exception as inner_e:
                    logger.error("Error processing ZMQ message: %s", inner_e)
                    time.sleep(1)
        except Exception as outer_e:
            logger.error("ZMQ connection error: %s", outer_e)
            time.sleep(5)

@app.on_event("startup")
def startup_event():
    logger.info("Application startup: launching background threads for block sync and ZMQ listener")
    threading.Thread(target=sync_blocks, daemon=True).start()
    threading.Thread(target=zmq_listener, daemon=True).start()
    logger.info("Background threads started")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8001)