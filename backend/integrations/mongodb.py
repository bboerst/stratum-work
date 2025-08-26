import os
import logging
from distutils.util import strtobool
from typing import Any

from pymongo import MongoClient

logger = logging.getLogger("backend.mongodb")


ENABLE_HISTORICAL_DATA_STR = os.getenv('ENABLE_HISTORICAL_DATA', 'true')
try:
    ENABLE_HISTORICAL_DATA = bool(strtobool(ENABLE_HISTORICAL_DATA_STR))
except ValueError:
    logger.error(
        "Invalid value for ENABLE_HISTORICAL_DATA: %s. Defaulting to True.",
        ENABLE_HISTORICAL_DATA_STR,
    )
    ENABLE_HISTORICAL_DATA = True


MONGO_URL = os.getenv("MONGODB_URL", "mongodb://mongodb:27017")
MONGO_DB = os.getenv("MONGODB_DB", "stratum-logger")
MONGO_USER = os.getenv("MONGODB_USERNAME", "mongouser")
MONGO_PASSWORD = os.getenv("MONGODB_PASSWORD", "mongopassword")


mongo_client: MongoClient | None = None
db: Any | None = None
blocks_coll = None
pools_coll = None
is_enabled: bool = False


def connect() -> bool:
    global mongo_client, db, blocks_coll, pools_coll, is_enabled
    if not ENABLE_HISTORICAL_DATA:
        logger.info("Historical data disabled, skipping MongoDB connection.")
        is_enabled = False
        return False
    try:
        logger.info("Historical data enabled, attempting to connect to MongoDB...")
        mongo_client = MongoClient(MONGO_URL, username=MONGO_USER, password=MONGO_PASSWORD)
        mongo_client.admin.command('ping')
        db = mongo_client[MONGO_DB]
        blocks_coll = db.blocks
        pools_coll = db.pools
        logger.info("Successfully connected to MongoDB at %s", MONGO_URL)
        is_enabled = True
        return True
    except Exception as e:
        logger.error("Error connecting to MongoDB: %s. Historical data features will be disabled.", e)
        mongo_client = None
        db = None
        blocks_coll = None
        pools_coll = None
        is_enabled = False
        return False


# Establish connection at import time to preserve current behavior
connect()


