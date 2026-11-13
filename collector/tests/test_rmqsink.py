"""RabbitMQ publisher (#141): submit() never blocks the Stratum read path; broker trouble is absorbed, not raised."""
import json
import threading
import time
import unittest

try:
    from collector.rmqsink import RabbitMQConfig, RabbitMQPublisher
except ImportError:  # pragma: no cover - when run from inside collector/
    from rmqsink import RabbitMQConfig, RabbitMQPublisher  # type: ignore

CONFIG = RabbitMQConfig(host="rabbitmq", port=5672, username="u", password="p", exchange="mining_notify_exchange")


class FakeChannel:
    def __init__(self, broker):
        self.broker = broker
        self.is_open = True

    def exchange_declare(self, **kwargs):
        self.broker.declared.append(kwargs)

    def basic_publish(self, exchange, routing_key, body):
        if self.broker.hang_s:
            time.sleep(self.broker.hang_s)
        if self.broker.fail_publishes > 0:
            self.broker.fail_publishes -= 1
            self.is_open = False
            raise ConnectionError("connection reset by peer")
        self.broker.published.append((exchange, json.loads(body)))


class FakeConnection:
    def __init__(self, broker):
        self.broker = broker
        self.is_open = True

    def channel(self):
        return FakeChannel(self.broker)

    def process_data_events(self, time_limit=0):
        self.broker.heartbeat_calls += 1

    def close(self):
        self.is_open = False


class FakeBroker:
    """Stands in for pika: counts connections, can fail connects/publishes or hang publishes."""

    def __init__(self, fail_connects=0, fail_publishes=0, hang_s=0.0):
        self.fail_connects = fail_connects
        self.fail_publishes = fail_publishes
        self.hang_s = hang_s
        self.connects = 0
        self.declared = []
        self.published = []
        self.heartbeat_calls = 0

    def connect(self, config):
        self.connects += 1
        if self.fail_connects > 0:
            self.fail_connects -= 1
            raise ConnectionError("connection refused")
        return FakeConnection(self)


def wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def make(broker, **kwargs):
    pub = RabbitMQPublisher(CONFIG, connect=broker.connect, max_backoff_s=0.05, **kwargs)
    pub._sleep = lambda s: time.sleep(min(s, 0.05))   # keep reconnect backoff short in tests
    return pub


class RabbitMQPublisherTests(unittest.TestCase):
    def test_publishes_in_order_to_the_fanout_exchange(self):
        broker = FakeBroker()
        pub = make(broker).start()
        for i in range(5):
            pub.submit({"job_id": f"j{i}"})
        self.assertTrue(wait_for(lambda: len(broker.published) == 5))
        pub.close()
        self.assertEqual([d["job_id"] for _, d in broker.published], ["j0", "j1", "j2", "j3", "j4"])
        self.assertEqual({e for e, _ in broker.published}, {"mining_notify_exchange"})
        self.assertEqual(broker.declared[0], {"exchange": "mining_notify_exchange", "exchange_type": "fanout",
                                              "durable": True})

    def test_submit_never_blocks_while_the_broker_hangs(self):
        broker = FakeBroker(hang_s=2.0)          # every publish takes 2 s (a stalled transatlantic link)
        pub = make(broker).start()
        start = time.monotonic()
        for i in range(200):
            pub.submit({"job_id": f"j{i}"})
        elapsed = time.monotonic() - start
        self.assertLess(elapsed, 0.2, "submit() must return immediately")
        pub._stop = True   # don't wait for 200 × 2 s of hanging publishes
        pub.close(timeout=0.1)

    def test_submit_never_raises_while_the_broker_is_down(self):
        broker = FakeBroker(fail_connects=10_000)
        pub = make(broker).start()
        for i in range(10):
            pub.submit({"job_id": f"j{i}"})   # must not raise
        self.assertTrue(wait_for(lambda: broker.connects >= 3))
        self.assertGreaterEqual(pub.stats["broker_errors"], 3)
        self.assertEqual(broker.published, [])
        pub.close(timeout=0.2)

    def test_reconnects_and_delivers_after_the_broker_returns(self):
        broker = FakeBroker(fail_connects=3, fail_publishes=1)
        pub = make(broker).start()
        for i in range(3):
            pub.submit({"job_id": f"j{i}"})
        self.assertTrue(wait_for(lambda: len(broker.published) == 3))
        pub.close()
        self.assertEqual([d["job_id"] for _, d in broker.published], ["j0", "j1", "j2"])  # the failed one requeued
        self.assertGreaterEqual(pub.stats["reconnects"], 4)

    def test_backoff_is_not_cut_short_by_new_submissions(self):
        broker = FakeBroker(fail_connects=10_000)
        pub = RabbitMQPublisher(CONFIG, connect=broker.connect, max_backoff_s=1.0).start()   # real _sleep
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:          # a template every 10 ms during the outage
            pub.submit({"job_id": "x"})
            time.sleep(0.01)
        # Backoff 1 s, then 1 s (capped): ~2-3 connect attempts in 1.5 s, not one per submission (~150).
        self.assertLessEqual(broker.connects, 4)
        pub.close(timeout=0.2)

    def test_queue_overflow_drops_the_oldest_and_counts_it(self):
        broker = FakeBroker(fail_connects=10_000)
        pub = make(broker, max_queue=10)        # not started: nothing drains the queue
        for i in range(25):
            pub.submit({"job_id": f"j{i}"})
        self.assertEqual(pub.queued(), 10)
        self.assertEqual(pub.stats["dropped_queue_full"], 15)
        self.assertEqual(pub._queue[0][1]["job_id"], "j15")   # the newest 10 are kept

    def test_stale_messages_are_dropped_not_published_late(self):
        now = [1000.0]
        broker = FakeBroker()
        pub = RabbitMQPublisher(CONFIG, connect=broker.connect, max_age_s=60.0, clock=lambda: now[0])
        pub.submit({"job_id": "old"})
        now[0] += 61.0                            # it waited out a broker outage
        pub.submit({"job_id": "fresh"})
        pub.start()
        self.assertTrue(wait_for(lambda: len(broker.published) == 1))
        pub.close()
        self.assertEqual(broker.published[0][1]["job_id"], "fresh")
        self.assertEqual(pub.stats["dropped_stale"], 1)

    def test_unserializable_documents_are_dropped_and_counted(self):
        broker = FakeBroker()
        pub = make(broker).start()
        pub.submit({"job_id": "bad", "x": object()})
        pub.submit({"job_id": "good"})
        self.assertTrue(wait_for(lambda: len(broker.published) == 1))
        pub.close()
        self.assertEqual(pub.stats["dropped_unserializable"], 1)

    def test_idle_publisher_services_heartbeats(self):
        broker = FakeBroker()
        pub = make(broker).start()
        self.assertTrue(wait_for(lambda: broker.heartbeat_calls >= 1, timeout=3.0))
        pub.close()

    def test_submit_is_thread_safe(self):
        broker = FakeBroker()
        pub = make(broker).start()
        threads = [threading.Thread(target=lambda t=t: [pub.submit({"job_id": f"{t}-{i}"}) for i in range(100)])
                   for t in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertTrue(wait_for(lambda: len(broker.published) == 400))
        pub.close()
        self.assertEqual(pub.stats["submitted"], 400)


if __name__ == "__main__":
    unittest.main()
