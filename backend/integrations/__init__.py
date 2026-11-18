"""
Integration modules for external systems used by the backend service.
"""

import logging

logger = logging.getLogger("backend.integrations")

# Storage for blocks, pools and the templates analytics read: Postgres (#112).
from .store import PostgresStore, make_store
try:
    store = make_store()
except Exception:
    logger.exception("Storage failed to initialize; historical data disabled")
    store = PostgresStore({}, enabled=False)

try:
    from .rabbitmq import rabbitmq_manager, publish_to_rabbitmq  # noqa: F401
except Exception:
    logger.exception("RabbitMQ integration failed to import; publishing disabled")
    rabbitmq_manager = None  # type: ignore
    def publish_to_rabbitmq(doc):  # type: ignore
        return False


