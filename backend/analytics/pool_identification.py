from typing import Any, Dict, List, Optional, Tuple
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
    coinbase_script_hex: str, coinbase_addresses: List[str], pools: Dict[str, Dict[str, Any]], logger
) -> Dict[str, Any]:
    logger.info(
        "Analysis(pool_identification): starting with %d coinbase addresses",
        len(coinbase_addresses or []),
    )
    mining_pool = identify_pool_from_data(pools, coinbase_script_hex, coinbase_addresses)
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
    def _decode_coinbase_text(script_hex: str) -> str:
        try:
            return bytes.fromhex(script_hex).decode("utf-8", errors="replace").replace("\n", "")
        except Exception:
            return ""

    def _is_ocean_pool(pool: Dict[str, Any]) -> bool:
        name = (pool or {}).get("name", "") or ""
        slug = (pool or {}).get("slug", "") or ""
        pid = (pool or {}).get("id", "") or ""
        name_l = str(name).lower()
        slug_l = str(slug).lower()
        pid_l = str(pid).lower()
        return any(s in ("ocean",) for s in (name_l, slug_l, pid_l))

    def _parse_datum_template_creator_names(coinbase_hex: str) -> List[str]:
        try:
            if not coinbase_hex:
                return []
            # Convert hex string to byte values
            bytes_arr: List[int] = []
            for i in range(0, len(coinbase_hex), 2):
                chunk = coinbase_hex[i : i + 2]
                try:
                    bytes_arr.append(int(chunk, 16))
                except Exception:
                    # Stop parsing on invalid hex
                    break

            if not bytes_arr:
                return []

            # Skip block height (var-length encoded in first byte count)
            tag_length_byte_idx = 1 + bytes_arr[0]
            if tag_length_byte_idx >= len(bytes_arr):
                return []

            tags_length = bytes_arr[tag_length_byte_idx]
            # Handle OP_PUSHDATA1 (0x4c)
            if tags_length == 0x4C:
                tag_length_byte_idx += 1
                if tag_length_byte_idx >= len(bytes_arr):
                    return []
                tags_length = bytes_arr[tag_length_byte_idx]

            tag_start = tag_length_byte_idx + 1
            tag_end = tag_start + tags_length
            if tag_start >= len(bytes_arr) or tag_start < 0:
                return []
            tag_end = min(tag_end, len(bytes_arr))
            tags_bytes = bytes_arr[tag_start:tag_end]
            tag_string = ''.join(chr(b) for b in tags_bytes)
            tag_string = tag_string.replace('\x00', '')

            # Split on 0x0f and clean to [A-Za-z0-9 ] only
            names = [re.sub(r'[^a-zA-Z0-9 ]', '', part) for part in tag_string.split('\x0f')]
            # Trim and drop empties
            names = [n.strip() for n in names if n and n.strip()]
            return names
        except Exception:
            return []

    # Prefer address match first
    addr = identify_by_address(pools, coinbase_addresses)
    if addr:
        # If this is OCEAN, try to enrich with the DATUM template creator (using mempool logic)
        if _is_ocean_pool(addr):
            names = _parse_datum_template_creator_names(coinbase_script_hex)
            if names:
                # choose the last cleaned name that isn't an OCEAN/DATUM marker
                for candidate in reversed(names):
                    low = candidate.lower()
                    if low and ("ocean" not in low and "datum" not in low):
                        addr["datum_template_creator"] = candidate
                        break
        return addr
    tag = identify_by_tag(pools, coinbase_script_hex)
    if tag:
        # If this is OCEAN, try to enrich with the DATUM template creator (using mempool logic)
        if _is_ocean_pool(tag):
            names = _parse_datum_template_creator_names(coinbase_script_hex)
            if names:
                for candidate in reversed(names):
                    low = candidate.lower()
                    if low and ("ocean" not in low and "datum" not in low):
                        tag["datum_template_creator"] = candidate
                        break
        return tag
    return {}


def load_pools(db, pool_json_url: str, local_pool_file: str, previous_hash: Optional[int] = None) -> Tuple[Dict[str, Dict[str, Any]], Optional[int], bool]:
    max_retries = 3
    retry_delay = 5
    for attempt in range(1, max_retries + 1):
        try:
            logger.info(
                f"Fetching pool definitions from {pool_json_url} (attempt {attempt}/{max_retries})"
            )
            headers = {
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json",
            }
            response = requests.get(pool_json_url, headers=headers, timeout=30)
            response.raise_for_status()
            pool_data = response.json()
            new_hash = hash(json.dumps(pool_data, sort_keys=True))
            definitions_changed = previous_hash is not None and previous_hash != new_hash
            pools = {pool.get("id"): pool for pool in pool_data}
            try:
                db.pools.delete_many({})
                db.pools.insert_many(pool_data)
            except Exception as db_err:
                logger.warning(f"Could not update pools collection: {db_err}")
            logger.info(f"Successfully loaded {len(pools)} mining pool definitions from GitHub")
            return pools, new_hash, definitions_changed
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
        if os.path.exists(local_pool_file):
            logger.info(
                f"Attempting to load pool definitions from local file: {local_pool_file}"
            )
            with open(local_pool_file, "r") as f:
                pool_data = json.load(f)
            try:
                db.pools.delete_many({})
                db.pools.insert_many(pool_data)
            except Exception as db_err:
                logger.warning(f"Could not update pools collection from local file: {db_err}")
            pools = {pool.get("id"): pool for pool in pool_data}
            logger.info(f"Successfully loaded {len(pools)} mining pool definitions from local file")
            new_hash = hash(json.dumps(pool_data, sort_keys=True))
            definitions_changed = previous_hash is not None and previous_hash != new_hash
            return pools, new_hash, definitions_changed
        else:
            logger.warning(f"Local pool file {local_pool_file} not found, falling back to database")
    except Exception as file_err:
        logger.error(f"Error loading pool definitions from local file: {file_err}")

    try:
        pool_data = list(db.pools.find({}, {"_id": 0}))
        if pool_data:
            logger.info(f"Loaded {len(pool_data)} mining pool definitions from database")
            pools = {pool.get("id"): pool for pool in pool_data}
            new_hash = hash(json.dumps(pool_data, sort_keys=True))
            definitions_changed = previous_hash is not None and previous_hash != new_hash
            return pools, new_hash, definitions_changed
        else:
            logger.warning("No pool definitions found in database")
            return {}, previous_hash, False
    except Exception as db_err:
        logger.error(f"Error loading pool definitions from database: {db_err}")
        return {}, previous_hash, False


