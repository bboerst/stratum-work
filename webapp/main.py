from flask import Flask, render_template, send_file, request, jsonify
from datetime import datetime
from pymongo import MongoClient
from flask_socketio import SocketIO
from flask_cors import CORS
from bson import json_util, Decimal128
import json
import logging
import signal
import sys
import os

# MongoDB connection with authentication and connection pooling
mongodb_username = os.environ.get('MONGODB_USERNAME')
mongodb_password = os.environ.get('MONGODB_PASSWORD')
mongodb_hosts = os.environ.get('MONGODB_HOSTS')

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": ["http://127.0.0.1:8000", "https://poolwork.live"]}})
socketio = SocketIO(app, cors_allowed_origins=["http://127.0.0.1:8000", "https://poolwork.live"])

# MongoDB connection with authentication and connection pooling
client = MongoClient(f"mongodb://{mongodb_username}:{mongodb_password}@{mongodb_hosts}", maxPoolSize=50)
db = client["stratum-logger"]
collection = db["mining_notify"]

# Create indexes on frequently queried fields
collection.create_index("timestamp")
collection.create_index("pool_name")

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class CustomJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, datetime):
            return obj.isoformat()
        elif isinstance(obj, Decimal128):
            return str(obj)
        return super(CustomJSONEncoder, self).default(obj)

app.json_encoder = CustomJSONEncoder

def get_mining_data():
    try:
        # Execute the MongoDB query
        results = list(collection.aggregate([
            {
                "$sort": {"timestamp": -1}
            },
            {
                "$group": {
                    "_id": "$pool_name",
                    "timestamp": {"$first": "$timestamp"},
                    "prev_hash": {"$first": "$prev_hash"},
                    "coinbase1": {"$first": "$coinbase1"},
                    "coinbase2": {"$first": "$coinbase2"},
                    "version": {"$first": "$version"},
                    "nbits": {"$first": "$nbits"},
                    "ntime": {"$first": "$ntime"},
                    "clean_jobs": {"$first": "$clean_jobs"},
                    "merkle_branches": {"$first": "$merkle_branches"},
                    "height": {"$first": "$height"}
                }
            },
            {
                "$project": {
                    "_id": 0,
                    "pool_name": "$_id",
                    "timestamp": 1,
                    "prev_hash": 1,
                    "coinbase1": 1,
                    "coinbase2": 1,
                    "version": 1,
                    "nbits": 1,
                    "ntime": 1,
                    "clean_jobs": 1,
                    "merkle_branch_0": {"$arrayElemAt": ["$merkle_branches", 0]},
                    "merkle_branch_1": {"$arrayElemAt": ["$merkle_branches", 1]},
                    "merkle_branch_2": {"$arrayElemAt": ["$merkle_branches", 2]},
                    "merkle_branch_3": {"$arrayElemAt": ["$merkle_branches", 3]},
                    "merkle_branch_4": {"$arrayElemAt": ["$merkle_branches", 4]},
                    "merkle_branch_5": {"$arrayElemAt": ["$merkle_branches", 5]},
                    "merkle_branch_6": {"$arrayElemAt": ["$merkle_branches", 6]},
                    "merkle_branch_7": {"$arrayElemAt": ["$merkle_branches", 7]},
                    "merkle_branch_8": {"$arrayElemAt": ["$merkle_branches", 8]},
                    "merkle_branch_9": {"$arrayElemAt": ["$merkle_branches", 9]},
                    "merkle_branch_10": {"$arrayElemAt": ["$merkle_branches", 10]},
                    "merkle_branch_11": {"$arrayElemAt": ["$merkle_branches", 11]},
                    "extranonce1": 1,
                    "extranonce2_length": 1,
                    "height": 1
                }
            }
        ]))
        # Convert timestamps to local browser time
        for item in results:
            item['timestamp'] = item['timestamp'] - datetime.timedelta(minutes=datetime.now().utcoffset().total_seconds() / 60)

        return app.response_class(
            response=json.dumps(results, cls=CustomJSONEncoder),
            status=200,
            mimetype='application/json'
        )
    except Exception as e:
        logger.exception("Error occurred while fetching data by timestamp range")
        return jsonify([])

def stream_mining_data():
    with collection.watch() as stream:
        for change in stream:
            if change['operationType'] == 'insert':
                document = change['fullDocument']
                socketio.emit('mining_data', json.loads(json_util.dumps(document)))

@app.route('/')
def index():
    results = get_mining_data()
    return render_template("index.html", results=results)

@app.route('/data')
def get_data_by_block_height():
    block_height = request.args.get('block_height', type=int)

    if block_height is None:
        return jsonify([])

    try:
        results = list(collection.aggregate([
            {
                "$match": {
                    "height": block_height
                }
            },
            {
                "$sort": {"timestamp": 1}
            },
            {
                "$project": {
                    "_id": 0,
                    "pool_name": 1,
                    "timestamp": 1,
                    "prev_hash": 1,
                    "coinbase1": 1,
                    "coinbase2": 1,
                    "version": 1,
                    "nbits": 1,
                    "ntime": 1,
                    "clean_jobs": 1,
                    "merkle_branches": 1,
                    "extranonce1": 1,
                    "extranonce2_length": 1,
                    "height": 1
                }
            }
        ]))
        if not results:
            return jsonify([])
        
        logger.info(f"Found {len(results)} records for block height {block_height}")

        return app.response_class(
            response=json.dumps(results, cls=CustomJSONEncoder),
            status=200,
            mimetype='application/json'
        )
    except Exception as e:
        logger.exception("Error occurred while fetching data by block height")
        return jsonify([])
        
@app.route('/static/bitcoinjs-lib.js')
def serve_js():
    return send_file('static/bitcoinjs-lib.js', mimetype='application/javascript')

@socketio.on('connect')
def handle_connect():
    logger.info('Client connected')

@socketio.on('disconnect')
def handle_disconnect():
    logger.info('Client disconnected')

def emit_data():
    results = get_mining_data()
    socketio.emit('mining_data', results)

def handle_sigterm(*args):
    logger.info("Received SIGTERM signal. Shutting down gracefully.")
    socketio.stop()
    sys.exit(0)

if __name__ == "__main__":
    # Register the SIGTERM signal handler for graceful shutdown
    signal.signal(signal.SIGTERM, handle_sigterm)

    socketio.start_background_task(stream_mining_data)
    socketio.run(app, port=8000, debug=True)