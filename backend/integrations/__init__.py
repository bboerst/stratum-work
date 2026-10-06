"""
Integration modules for external systems used by the backend service.
"""

try:
    from .rabbitmq import rabbitmq_manager, publish_to_rabbitmq  # noqa: F401
except Exception:
    rabbitmq_manager = None  # type: ignore
    def publish_to_rabbitmq(doc):  # type: ignore
        return False

