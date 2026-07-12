"""
Integration modules for external systems used by the backend service.
"""

from typing import Any, Dict, List

__all__ = [
    "db",
    "blocks_coll",
    "pools_coll",
    "mongodb_enabled",
    "rabbitmq_manager",
    "publish_to_rabbitmq",
    "post_analysis_flags",
]

db: Any = None
blocks_coll: Any = None
pools_coll: Any = None
mongodb_enabled: bool = False
rabbitmq_manager: Any = None


def publish_to_rabbitmq(doc: Dict[str, Any]) -> bool:
    return False


def post_analysis_flags(height: int, flags: List[Dict[str, Any]]) -> None:
    pass


try:
    from .mongodb import db, blocks_coll, pools_coll, is_enabled as mongodb_enabled
except Exception:
    pass

try:
    from .rabbitmq import rabbitmq_manager, publish_to_rabbitmq
except Exception:
    pass

try:
    from .x import post_analysis_flags
except Exception:
    pass
