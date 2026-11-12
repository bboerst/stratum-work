"""
Integration modules for external systems used by the backend service.
"""

import logging

logger = logging.getLogger("backend.integrations")

# Storage for blocks, pools and the templates analytics read: MongoDB (default) or Postgres, chosen by DB_BACKEND
# (#112). With DB_BACKEND=postgres, the MongoDB module is never imported (it connects at import time).
try:
    from .store import MongoStore, make_store
    store = make_store()
except Exception:
    logger.exception("Storage backend failed to initialize; historical data disabled")
    from .store import MongoStore
    store = MongoStore(None)  # disabled

try:
    from .rabbitmq import rabbitmq_manager, publish_to_rabbitmq  # noqa: F401
except Exception:
    logger.exception("RabbitMQ integration failed to import; publishing disabled")
    rabbitmq_manager = None  # type: ignore
    def publish_to_rabbitmq(doc):  # type: ignore
        return False


