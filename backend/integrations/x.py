import os
import logging
import time
from threading import Lock
from typing import Any, Dict, List, Optional

logger = logging.getLogger("backend.x")

X_API_KEY = os.getenv("X_API_KEY", "")
X_API_KEY_SECRET = os.getenv("X_API_KEY_SECRET", "")
X_ACCESS_TOKEN = os.getenv("X_ACCESS_TOKEN", "")
X_ACCESS_TOKEN_SECRET = os.getenv("X_ACCESS_TOKEN_SECRET", "")

_client = None
_init_attempted = False
_init_lock = Lock()

POST_COOLDOWN_SECONDS = int(os.getenv("X_COOLDOWN_SECONDS", "300"))
_recent_posts: Dict[str, float] = {}
_cooldown_lock = Lock()


def _get_client():
    global _client, _init_attempted
    with _init_lock:
        if _init_attempted:
            return _client
        _init_attempted = True

        if not all([X_API_KEY, X_API_KEY_SECRET,
                    X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET]):
            logger.info("X credentials not configured; post integration disabled")
            return None

        try:
            import tweepy
            _client = tweepy.Client(
                consumer_key=X_API_KEY,
                consumer_secret=X_API_KEY_SECRET,
                access_token=X_ACCESS_TOKEN,
                access_token_secret=X_ACCESS_TOKEN_SECRET,
            )
            logger.info("X client initialized successfully")
        except Exception as e:
            logger.error("Failed to initialize X client: %s", e)
            _client = None

    return _client


def _is_on_cooldown(dedup_key: str) -> bool:
    now = time.time()
    with _cooldown_lock:
        last_sent = _recent_posts.get(dedup_key)
        if last_sent and (now - last_sent) < POST_COOLDOWN_SECONDS:
            return True
        _recent_posts[dedup_key] = now
        stale = [k for k, v in _recent_posts.items() if (now - v) > POST_COOLDOWN_SECONDS * 2]
        for k in stale:
            del _recent_posts[k]
    return False


def _send_post(text: str, dedup_key: str) -> bool:
    if _is_on_cooldown(dedup_key):
        logger.debug("Post suppressed (cooldown): %s", dedup_key)
        return False

    client = _get_client()
    if client is None:
        return False

    try:
        client.create_tweet(text=text)
        logger.info("Post sent: %s", text[:80])
        return True
    except Exception as e:
        logger.error("Failed to send post: %s", e)
        return False


def _format_prev_hash_fork(height: int, details: Dict[str, Any]) -> str:
    groups = details.get("groups", [])
    pool_summaries = []
    for g in groups:
        prev_hash = g.get("prev_hash", "?")[:8]
        pools = g.get("pools", [])
        pool_summaries.append(f"{prev_hash}...: {', '.join(pools)}")
    body = "\n\n".join(pool_summaries)
    return (
        f"Fork detected at block height {height}./n/n{body}"
    )


def _format_invalid_coinbase(height: int, details: Dict[str, Any]) -> str:
    offenders = details.get("offenders", [])
    names = [o.get("pool_name", "unknown") for o in offenders]
    return (
        f"Invalid coinbase detected at block height {height}./n/n"
        f"Pool(s) have coinbase outputs exceeding the block subsidy "
        f"with empty merkle branches: {', '.join(names)}"
    )


_FORMATTERS = {
    "prev_hash_fork": _format_prev_hash_fork,
    "invalid_coinbase_no_merkle": _format_invalid_coinbase,
}


def post_analysis_flags(height: int, flags: List[Dict[str, Any]]) -> None:
    """Send a single post to X combining all notable analysis flags for a given height."""
    if not X_POSTING_ENABLED:
        return

    sections = []
    keys = []
    for flag in flags:
        key = flag.get("key", "")
        formatter = _FORMATTERS.get(key)
        if formatter is None:
            continue
        sections.append(formatter(height, flag.get("details", {})))
        keys.append(key)

    if not sections:
        return

    url = f"https://stratum.work/height/{height}"
    text = "\n\n".join(sections) + f"{url}"
    dedup_key = f"{'+'.join(sorted(keys))}:{height}"
    _send_post(text, dedup_key)
