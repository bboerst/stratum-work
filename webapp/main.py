import eventlet
eventlet.monkey_patch()

import os, socket, json, logging, time, requests, string, sys, io
from flask import Flask, render_template, send_file, request
from flask_socketio import SocketIO
from flask_cors import CORS
from pycoin.symbols.btc import network as btc_network
import pika

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Flask and Socket.IO setup
CORS_ORIGINS = os.environ.get('CORS_ORIGINS', 'http://127.0.0.1:8000,http://localhost:8000').split(',')
app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": CORS_ORIGINS}})
socketio = SocketIO(app, cors_allowed_origins=CORS_ORIGINS)

# Track connected Socket.IO clients
connected_clients = set()

# Cache transaction fee lookups
transaction_cache = {}

# RabbitMQ details
rabbitmq_host = os.environ.get('RABBITMQ_HOST', 'rabbitmq')
rabbitmq_port = int(os.environ.get('RABBITMQ_PORT', 5672))
rabbitmq_username = os.environ.get('RABBITMQ_USERNAME', 'guest')
rabbitmq_password = os.environ.get('RABBITMQ_PASSWORD', 'guest')
rabbitmq_exchange = os.environ.get('RABBITMQ_EXCHANGE', 'mining_notify_exchange')

###############################################################################
# Helpers
###############################################################################

def get_prev_block_hash(prev_hash_hex):
    """Reverse-hex the previous block hash."""
    return bytes.fromhex(prev_hash_hex)[::-1].hex()

def extract_coinbase_script_ascii(coinbase_tx):
    """Extract ASCII from coinbase script, skipping block-height bytes."""
    script_sig_hex = coinbase_tx.txs_in[0].script.hex()
    # Remove first 8 hex characters = 4 bytes (block height, etc.)
    script_sig_hex = script_sig_hex[8:]
    ascii_script = bytes.fromhex(script_sig_hex).decode('ascii', 'replace')
    return ''.join(ch for ch in ascii_script if ch in string.printable)

def process_row_data(row):
    """Convert the raw row from RabbitMQ into a structure the front-end can use."""
    coinbase1 = row['coinbase1']
    coinbase2 = row['coinbase2']
    extranonce1 = row['extranonce1']
    extranonce2_length = row['extranonce2_length']
    prev_hash = row['prev_hash']
    version = row['version']
    merkle_branches = row['merkle_branches']

    coinbase_hex = coinbase1 + extranonce1 + '00' * extranonce2_length + coinbase2
    coinbase_tx = btc_network.Tx.from_hex(coinbase_hex)

    output_value = sum(tx_out.coin_value for tx_out in coinbase_tx.txs_out) / 1e8
    height = int.from_bytes(coinbase_tx.txs_in[0].script[1:4], byteorder='little')
    prev_block_hash = get_prev_block_hash(prev_hash)
    block_version = int(version, 16)

    if merkle_branches:
        first_transaction = bytes(reversed(bytes.fromhex(merkle_branches[0]))).hex()
    else:
        first_transaction = 'empty block'

    fee_rate = get_transaction_fee_rate(first_transaction)
    merkle_branch_colors = precompute_merkle_branch_colors(merkle_branches)
    script_sig_ascii = extract_coinbase_script_ascii(coinbase_tx)

    # Extract coinbase outputs
    coinbase_outputs = []
    for tx_out in coinbase_tx.txs_out:
        addr = btc_network.address.for_script(tx_out.script)
        val = tx_out.coin_value / 1e8
        coinbase_outputs.append({"address": addr, "value": val})

    return {
        'pool_name': row['pool_name'],
        'timestamp': row['timestamp'],
        'height': height,
        'prev_block_hash': prev_block_hash,
        'block_version': block_version,
        'coinbase_raw': coinbase_hex,
        'version': version,
        'nbits': row['nbits'],
        'ntime': row['ntime'],
        'coinbase_script_ascii': script_sig_ascii,
        'clean_jobs': row['clean_jobs'],
        'first_transaction': first_transaction,
        'fee_rate': fee_rate,
        'merkle_branches': merkle_branches,
        'merkle_branch_colors': merkle_branch_colors,
        'coinbase_output_value': output_value,
        'coinbase_outputs': coinbase_outputs
    }

def get_transaction_fee_rate(first_txid):
    """Look up transaction fee rate from mempool.space, caching results."""
    if first_txid == 'empty block':
        return ''

    # Check cache
    if first_txid in transaction_cache:
        cached_fee, cpfp_fee, expire_time = transaction_cache[first_txid]
        if time.time() < expire_time:
            return cpfp_fee if cpfp_fee is not None else cached_fee

    try:
        # Check CPFP
        cpfp_url = f'https://mempool.space/api/v1/cpfp/{first_txid}'
        cpfp_resp = requests.get(cpfp_url)
        logger.info(f"mempool.space CPFP response: {cpfp_resp.status_code} for {first_txid}")
        if cpfp_resp.status_code == 200:
            data = cpfp_resp.json()
            if 'effectiveFeePerVsize' in data:
                fee_val = round(data['effectiveFeePerVsize'])
                transaction_cache[first_txid] = (None, fee_val, time.time() + 300)
                return fee_val

        # Check normal tx
        tx_url = f'https://mempool.space/api/tx/{first_txid}'
        tx_resp = requests.get(tx_url)
        logger.info(f"mempool.space Reg tx response: {tx_resp.status_code} for {first_txid}")
        if tx_resp.status_code == 200:
            data = tx_resp.json()
            fee = data.get('fee')
            weight = data.get('weight')
            if fee is not None and weight is not None:
                normal_rate = round(fee / (weight / 4))
                transaction_cache[first_txid] = (normal_rate, None, time.time() + 300)
                return normal_rate

        return 'not found'
    except requests.exceptions.RequestException:
        logger.exception(f"Error fetching fee rate for {first_txid}")
        return 'Error'

def precompute_merkle_branch_colors(merkle_branches):
    colors = []
    for branch in merkle_branches:
        hue = abs(hash_code(branch) % 360)
        lightness = 60 + (hash_code(branch) % 25)
        color = f'hsl({hue}, 100%, {lightness}%)'
        colors.append(color)
    return colors

def hash_code(text):
    return sum(ord(c) for c in text)

###############################################################################
# RabbitMQ Consumer in a Background Task
###############################################################################

def consume_messages():
    """
    In a multi-replica deployment, each replica declares the same fanout exchange
    but a unique queue name, so each replica gets all messages. Then we broadcast
    them to our local connected Socket.IO clients.
    """
    logger.info("Global RabbitMQ consumer thread starting...")

    # Build connection
    creds = pika.PlainCredentials(rabbitmq_username, rabbitmq_password)
    params = pika.ConnectionParameters(host=rabbitmq_host, port=rabbitmq_port, credentials=creds)
    connection = pika.BlockingConnection(params)
    channel = connection.channel()

    # Declare fanout exchange
    channel.exchange_declare(exchange=rabbitmq_exchange, exchange_type='fanout', durable=True)

    # Use pod hostname (or something unique) for the queue name so each replica sees all messages
    queue_name = f"stratum_broadcast_{socket.gethostname()}"

    # Declare a non-durable, auto-delete queue
    # (If you prefer it to persist across restarts, set auto_delete=False or use a stable name.)
    channel.queue_declare(
        queue=queue_name,
        durable=False,
        exclusive=False,
        auto_delete=True
    )

    # Bind queue to fanout exchange so each replica gets a copy
    channel.queue_bind(exchange=rabbitmq_exchange, queue=queue_name)

    def on_message(ch, method, properties, body):
        try:
            message = json.loads(body)
            row_data = process_row_data(message)
            # Copy the set so we don't get "Set changed size during iteration"
            for sid in list(connected_clients):
                socketio.emit('mining_data', row_data, room=sid)
        except Exception as e:
            logger.exception(f"Error processing message: {e}")

    channel.basic_consume(
        queue=queue_name,
        on_message_callback=on_message,
        auto_ack=True
    )

    logger.info(f"Bound queue [{queue_name}] to exchange [{rabbitmq_exchange}]. Starting consume loop...")
    try:
        channel.start_consuming()  # Block forever
    except Exception:
        logger.exception("Error in consumer loop")
    finally:
        logger.info("Shutting down consumer.")
        try:
            channel.stop_consuming()
        except Exception:
            pass
        connection.close()

###############################################################################
# Flask/Socket.IO routes & events
###############################################################################

@app.after_request
def add_headers(response):
    origin = request.headers.get('Origin')
    if origin in CORS_ORIGINS:
        response.headers['Access-Control-Allow-Origin'] = origin
    return response

@socketio.on('connect')
def handle_connect():
    logger.info(f'Client connected: {request.sid}')
    connected_clients.add(request.sid)

@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f'Client disconnected: {request.sid}')
    connected_clients.discard(request.sid)

@app.route('/')
def index():
    socket_url = os.environ.get('SOCKET_URL', 'https://stratum.work')
    return render_template('index.html', SOCKET_URL=socket_url)

@app.route('/static/bitcoinjs-lib.js')
def serve_js():
    return send_file('static/bitcoinjs-lib.js', mimetype='application/javascript')

def handle_sigterm(*args):
    logger.info("Received SIGTERM signal. Shutting down gracefully...")
    socketio.stop()
    sys.exit(0)

###############################################################################
# Start the consumer in a background task at module import, so it also works
# under Gunicorn (which doesn't run __main__).
###############################################################################
logger.info("Importing module => launching RabbitMQ consumer in background...")
socketio.start_background_task(consume_messages)

if __name__ == "__main__":
    logger.info("Running via __main__: starting Socket.IO eventlet server.")
    socketio.run(app, host="0.0.0.0", port=8000)