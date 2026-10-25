"""
Integration modules for external systems used by the backend service.
"""

import logging

logger = logging.getLogger("backend.integrations")

# Re-export convenient handles for current integrations to keep main concise
try:
    from .mongodb import db, blocks_coll, pools_coll, is_enabled as mongodb_enabled  # noqa: F401
except Exception:
    # If the MongoDB integration fails to import/connect, leave symbols undefined
    logger.exception("MongoDB integration failed to import; historical data disabled")
    db = None  # type: ignore
    blocks_coll = None  # type: ignore
    pools_coll = None  # type: ignore
    mongodb_enabled = False  # type: ignore

try:
    from .rabbitmq import rabbitmq_manager, publish_to_rabbitmq  # noqa: F401
except Exception:
    logger.exception("RabbitMQ integration failed to import; publishing disabled")
    rabbitmq_manager = None  # type: ignore
    def publish_to_rabbitmq(doc):  # type: ignore
        return False


