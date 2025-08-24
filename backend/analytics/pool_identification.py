from typing import Any, Dict, List, Optional
import logging
import requests
import os
import json
import time
import threading
import re
from datetime import datetime
import uuid

logger = logging.getLogger("backend")


def analyze_pool_identification(
    coinbase_script_hex: str, coinbase_addresses: List[str], pools_manager, logger
) -> Dict[str, Any]:
    logger.info(
        "Analysis(pool_identification): starting with %d coinbase addresses",
        len(coinbase_addresses or []),
    )
    mining_pool = pools_manager.identify_pool(coinbase_script_hex, coinbase_addresses)
    method = mining_pool.get("identification_method", "unknown") if mining_pool else "none"
    name = mining_pool.get("name", "Unknown") if mining_pool else "Unknown"
    logger.info("Analysis(pool_identification): result name=%s method=%s", name, method)
    return {
        "mining_pool": mining_pool or {"name": "Unknown", "id": "unknown"},
        "method": method,
        "addresses_considered": coinbase_addresses,
    }


def identify_by_address(pools: Dict[str, Dict[str, Any]], coinbase_addresses: List[str]) -> Dict[str, Any]:
    if not coinbase_addresses:
        return {}
    for pool_id, pool in pools.items():
        pool_addresses = pool.get("addresses", [])
        for addr in coinbase_addresses:
            if addr in pool_addresses:
                return {
                    "id": pool_id,
                    "name": pool.get("name"),
                    "slug": pool.get("slug", pool.get("name", "").lower().replace(" ", "-")),
                    "link": pool.get("link"),
                    "match_type": "address",
                    "identification_method": "address",
                }
    return {}


def identify_by_tag(pools: Dict[str, Dict[str, Any]], coinbase_script_hex: str) -> Dict[str, Any]:
    if not coinbase_script_hex:
        return {}
    try:
        coinbase_text = (
            bytes.fromhex(coinbase_script_hex).decode("utf-8", errors="replace").replace("\n", "")
        )
        for pool_id, pool in pools.items():
            for tag in pool.get("tags", []):
                if tag in coinbase_text:
                    return {
                        "id": pool_id,
                        "name": pool.get("name"),
                        "slug": pool.get("slug", pool.get("name", "").lower().replace(" ", "-")),
                        "link": pool.get("link"),
                        "match_type": "tag",
                        "identification_method": "tag",
                    }
            for pattern in pool.get("regexes", []):
                if re.search(pattern, coinbase_text, re.IGNORECASE):
                    return {
                        "id": pool_id,
                        "name": pool.get("name"),
                        "slug": pool.get("slug", pool.get("name", "").lower().replace(" ", "-")),
                        "link": pool.get("link"),
                        "match_type": "tag",
                        "identification_method": "tag",
                    }
    except Exception:
        pass
    return {}


def identify_pool_from_data(
    pools: Dict[str, Dict[str, Any]], coinbase_script_hex: str, coinbase_addresses: List[str]
) -> Dict[str, Any]:
    # Prefer address match first
    addr = identify_by_address(pools, coinbase_addresses)
    if addr:
        return addr
    tag = identify_by_tag(pools, coinbase_script_hex)
    if tag:
        return tag
    return {}


class PoolsManager:
    def __init__(self, db, pool_json_url: str, local_pool_file: str, publisher: Optional[callable] = None):
        self.db = db
        self.pool_json_url = pool_json_url
        self.local_pool_file = local_pool_file
        self.pools: Dict[str, Dict[str, Any]] = {}
        self.pool_definitions_hash: Optional[int] = None
        self.reindexing = False
        self.publisher = publisher

    def load_pools(self) -> dict:
        max_retries = 3
        retry_delay = 5
        for attempt in range(1, max_retries + 1):
            try:
                logger.info(
                    f"Fetching pool definitions from {self.pool_json_url} (attempt {attempt}/{max_retries})"
                )
                headers = {
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "application/json",
                }
                response = requests.get(self.pool_json_url, headers=headers, timeout=30)
                response.raise_for_status()
                pool_data = response.json()
                new_hash = hash(json.dumps(pool_data, sort_keys=True))
                definitions_changed = self.pool_definitions_hash is not None and self.pool_definitions_hash != new_hash
                self.pool_definitions_hash = new_hash
                pools = {pool.get("id"): pool for pool in pool_data}
                self.pools = pools
                self.db.pools.delete_many({})
                self.db.pools.insert_many(pool_data)
                logger.info(f"Successfully loaded {len(pools)} mining pool definitions from GitHub")
                if definitions_changed and self.db.blocks.count_documents({}) > 0:
                    logger.info("Pool definitions changed, scheduling reindexing of blocks")
                    threading.Thread(target=self.reindex_blocks, daemon=True).start()
                return pools
            except requests.exceptions.SSLError as ssl_err:
                logger.error(
                    f"SSL error fetching pool definitions (attempt {attempt}/{max_retries}): {ssl_err}"
                )
                if attempt < max_retries:
                    logger.info(f"Retrying in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    logger.warning("Max retries exceeded for SSL error, falling back to local file or database")
            except requests.exceptions.RequestException as req_err:
                logger.error(
                    f"Request error fetching pool definitions (attempt {attempt}/{max_retries}): {req_err}"
                )
                if attempt < max_retries:
                    logger.info(f"Retrying in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    logger.warning(
                        "Max retries exceeded for request error, falling back to local file or database"
                    )
            except Exception as e:
                logger.error(
                    f"Unexpected error loading mining pool list (attempt {attempt}/{max_retries}): {e}"
                )
                if attempt < max_retries:
                    logger.info(f"Retrying in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                    retry_delay *= 2
                else:
                    logger.warning(
                        "Max retries exceeded for unexpected error, falling back to local file or database"
                    )

        try:
            if os.path.exists(self.local_pool_file):
                logger.info(
                    f"Attempting to load pool definitions from local file: {self.local_pool_file}"
                )
                with open(self.local_pool_file, "r") as f:
                    pool_data = json.load(f)
                self.db.pools.delete_many({})
                self.db.pools.insert_many(pool_data)
                pools = {pool.get("id"): pool for pool in pool_data}
                self.pools = pools
                logger.info(f"Successfully loaded {len(pools)} mining pool definitions from local file")
                return pools
            else:
                logger.warning(f"Local pool file {self.local_pool_file} not found, falling back to database")
        except Exception as file_err:
            logger.error(f"Error loading pool definitions from local file: {file_err}")

        try:
            pool_data = list(self.db.pools.find({}, {"_id": 0}))
            if pool_data:
                logger.info(f"Loaded {len(pool_data)} mining pool definitions from database")
                return {pool.get("id"): pool for pool in pool_data}
            else:
                logger.warning("No pool definitions found in database")
                return {}
        except Exception as db_err:
            logger.error(f"Error loading pool definitions from database: {db_err}")
            return {}

    def identify_pool(self, coinbase_script_hex: str, coinbase_addresses: List[str]) -> Dict[str, Any]:
        if not self.pools:
            self.pools = self.load_pools()
        return identify_pool_from_data(self.pools, coinbase_script_hex, coinbase_addresses)

    def reindex_blocks(self):
        if self.reindexing:
            logger.info("Reindexing already in progress, skipping")
            return
        self.reindexing = True
        try:
            blocks_to_reindex = self.db.blocks.find({})
            logger.info("Starting to reindex pool information for blocks")
            count = 0
            for block in blocks_to_reindex:
                block_hash = block.get("block_hash")
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
        try:
            block = self.db.blocks.find_one({"block_hash": block_hash})
            if not block:
                logger.warning(f"Block {block_hash} not found in database")
                return
            coinbase_script_hex = block.get("coinbase_script_sig", "")
            coinbase_addresses = block.get("coinbase_addresses", [])
            mining_pool = self.identify_pool(coinbase_script_hex, coinbase_addresses)
            if not mining_pool:
                mining_pool = {"name": "Unknown", "id": "unknown"}
            current_pool = block.get("mining_pool", {})
            old_pool_name = current_pool.get("name", "Unknown")
            new_pool_name = mining_pool.get("name", "Unknown")
            if old_pool_name != new_pool_name:
                logger.info(
                    f"Updating pool for block {block_hash} from '{old_pool_name}' to '{new_pool_name}'"
                )
                self.db.blocks.update_one({"block_hash": block_hash}, {"$set": {"mining_pool": mining_pool}})
                updated_block = self.db.blocks.find_one({"block_hash": block_hash})
                if updated_block and self.publisher:
                    if "_id" in updated_block:
                        updated_block["_id"] = str(updated_block["_id"])
                    rabbitmq_doc = {
                        "type": "block",
                        "id": str(uuid.uuid4()),
                        "timestamp": datetime.utcnow().isoformat(),
                        "data": updated_block,
                    }
                    self.publisher(rabbitmq_doc)
                    logger.info(
                        f"Published block update for block {block_hash} with new pool info"
                    )
        except Exception as e:
            logger.error(f"Error reprocessing pool info for block {block_hash}: {e}")


