import json
import logging
import os
import socket
import sys
import threading
import time
import unittest
import unittest.mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import main  # noqa: E402
import work_proxy  # noqa: E402

TOKEN = "internal-router-token-123"
POOL_USER = "acct.worker1"
POOL_PASS = "pool-secret-pass"
NOTIFY_PARAMS = ["job1", "00" * 32, "01000000", "ffffffff", [], "20000000", "1703a4b2", "66f00000", True]


def wait_for(predicate, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.01)
    raise AssertionError("condition not met in time")


class MemoryPublisher:
    def __init__(self):
        self.messages = []
        self.lock = threading.Lock()

    def publish(self, message):
        with self.lock:
            self.messages.append(json.loads(json.dumps(message)))

    def of(self, predicate):
        with self.lock:
            return [m for m in self.messages if predicate(m)]


class FakePool:
    """Minimal stratum pool: one connection at a time, records every request."""

    def __init__(self, en1s=("a1b2c3d4",), en2size=8, configure_ok=True, submit_error=None, submit_result=True):
        self.en1s = list(en1s)
        self.submit_result = submit_result
        self.en2size = en2size
        self.configure_ok = configure_ok
        self.submit_error = submit_error
        self.requests = []
        self.connections = 0
        self.conn = None
        self.lock = threading.Lock()
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(4)
        self.port = self.listener.getsockname()[1]
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while True:
            try:
                conn, _ = self.listener.accept()
            except OSError:
                return
            with self.lock:
                self.conn = conn
                en1 = self.en1s[min(self.connections, len(self.en1s) - 1)]
                self.connections += 1
            threading.Thread(target=self._serve, args=(conn, en1), daemon=True).start()

    def send(self, obj):
        with self.lock:
            conn = self.conn
        conn.sendall((json.dumps(obj) + "\n").encode())

    def _serve(self, conn, en1):
        reader = work_proxy._LineReader(conn)
        try:
            while True:
                msg = reader.next()
                with self.lock:
                    self.requests.append(msg)
                method, rid = msg.get("method"), msg.get("id")
                if method == "mining.configure":
                    if self.configure_ok:
                        reply = {"id": rid, "result": {"version-rolling": True, "version-rolling.mask": "1fffe000"}, "error": None}
                    else:
                        reply = {"id": rid, "result": None, "error": [20, "Method not found", None]}
                    self._write(conn, reply)
                elif method == "mining.subscribe":
                    self._write(conn, {"id": rid, "result": [[["mining.notify", "x"]], en1, self.en2size], "error": None})
                elif method == "mining.authorize":
                    self._write(conn, {"id": rid, "result": True, "error": None})
                    self._write(conn, {"id": None, "method": "mining.set_difficulty", "params": [65536]})
                    self._write(conn, {"id": None, "method": "mining.notify", "params": NOTIFY_PARAMS})
                elif method == "mining.submit":
                    if self.submit_error:
                        self._write(conn, {"id": rid, "result": None, "error": self.submit_error})
                    else:
                        self._write(conn, {"id": rid, "result": self.submit_result, "error": None})
        except (EOFError, OSError):
            pass

    @staticmethod
    def _write(conn, obj):
        conn.sendall((json.dumps(obj) + "\n").encode())

    def of(self, method):
        with self.lock:
            return [r for r in self.requests if r.get("method") == method]

    def drop_connection(self):
        with self.lock:
            conn = self.conn
        conn.shutdown(socket.SHUT_RDWR)
        conn.close()

    def close(self):
        self.listener.close()
        with self.lock:
            if self.conn is not None:
                try:
                    self.conn.close()
                except OSError:
                    pass


class FakeRouter:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.reader = work_proxy._LineReader(self.sock)
        self.next_id = 100

    def call(self, method, params, req_id=None):
        req_id = req_id if req_id is not None else self.next_id
        self.next_id += 1
        self.sock.sendall((json.dumps({"id": req_id, "method": method, "params": params}) + "\n").encode())
        return req_id

    def recv(self):
        return self.reader.next()

    def recv_response(self, req_id):
        notifications = []
        while True:
            msg = self.recv()
            if msg.get("id") == req_id and not msg.get("method"):
                return msg, notifications
            notifications.append(msg)

    def handshake(self, token=TOKEN):
        self.recv_response(self.call("mining.configure", work_proxy.CONFIGURE_PARAMS))
        sub, _ = self.recv_response(self.call("mining.subscribe", ["stratum-work-router/1"]))
        auth, _ = self.recv_response(self.call("mining.authorize", ["router", token]))
        return sub, auth

    def close(self):
        self.sock.close()


class WorkProxyTest(unittest.TestCase):
    def make_proxy(self, pool, **kwargs):
        publisher = MemoryPublisher()
        meta = main.ConnectionMeta(site="us-ash-1", connection_id="us-ash-1/fake/work", mode="work", account="acct.worker1")
        proxy = work_proxy.WorkProxy(
            f"stratum+tcp://127.0.0.1:{pool.port}", POOL_USER, POOL_PASS, TOKEN, publisher, meta, "FakePool",
            backoff_initial=0.05, backoff_max=0.2, **kwargs,
        )
        port = proxy.start(0, host="127.0.0.1")
        self.assertEqual(port, proxy.port)
        self.addCleanup(proxy.stop)
        self.addCleanup(pool.close)
        return proxy, publisher, port

    def router(self, port):
        r = FakeRouter(port)
        self.addCleanup(r.close)
        return r

    def test_full_flow_subscribe_authorize_submit(self):
        pool = FakePool()
        proxy, publisher, port = self.make_proxy(pool)
        router = self.router(port)

        cfg, _ = router.recv_response(router.call("mining.configure", work_proxy.CONFIGURE_PARAMS))
        self.assertEqual(cfg["result"], {"version-rolling": True, "version-rolling.mask": "1fffe000"})
        sub, _ = router.recv_response(router.call("mining.subscribe", ["stratum-work-router/1"]))
        self.assertEqual(sub["result"], [[["mining.notify", "w"], ["mining.set_difficulty", "w"]], "a1b2c3d4", 8])

        auth, _ = router.recv_response(router.call("mining.authorize", ["router", TOKEN]))
        self.assertIs(auth["result"], True)
        diff = router.recv()
        self.assertEqual((diff["method"], diff["params"]), ("mining.set_difficulty", [65536]))
        notify = router.recv()
        self.assertEqual((notify["method"], notify["params"]), ("mining.notify", NOTIFY_PARAMS))

        submit_id = router.call("mining.submit", ["router.miner1", "job1", "0000000000000001", "66f00000", "deadbeef", "00002000"], req_id=4242)
        resp, _ = router.recv_response(submit_id)
        self.assertEqual(resp, {"id": 4242, "result": True, "error": None})

        submits = pool.of("mining.submit")
        self.assertEqual(len(submits), 1)
        self.assertEqual(submits[0]["params"], [POOL_USER, "job1", "0000000000000001", "66f00000", "deadbeef", "00002000"])
        self.assertNotEqual(submits[0]["id"], 4242)

        self.assertEqual(pool.of("mining.authorize")[0]["params"], [POOL_USER, POOL_PASS])
        self.assertEqual(pool.of("mining.configure")[0]["params"], work_proxy.CONFIGURE_PARAMS)

        templates = wait_for(lambda: publisher.of(lambda m: "prev_hash" in m))
        self.assertEqual(len(templates), 1)
        self.assertEqual(templates[0]["mode"], "work")
        self.assertEqual(templates[0]["account"], "acct.worker1")
        self.assertEqual(templates[0]["extranonce1"], "a1b2c3d4")
        self.assertEqual(templates[0]["endpoint_ip"], "127.0.0.1")

        shares = wait_for(lambda: publisher.of(lambda m: m.get("type") == "share"))
        self.assertEqual(len(shares), 1)
        share = shares[0]
        self.assertTrue(share["accepted"])
        self.assertIsNone(share["reject_reason"])
        self.assertEqual(share["pool_name"], "FakePool")
        self.assertEqual(share["site"], "us-ash-1")
        self.assertEqual(share["connection_id"], "us-ash-1/fake/work")
        self.assertEqual(share["job_id"], "job1")
        self.assertEqual(share["mode"], "work")
        self.assertEqual(share["account"], "acct.worker1")
        self.assertIsNone(share["share_difficulty"])
        self.assertEqual(share["pool_difficulty"], 65536)
        self.assertIsInstance(share["response_ms"], float)
        int(share["timestamp"], 16)

    def test_wrong_token_is_rejected_and_closed(self):
        pool = FakePool()
        _, _, port = self.make_proxy(pool)
        router = self.router(port)
        _, auth = router.handshake(token="wrong-token")
        self.assertIs(auth["result"], False)
        with self.assertRaises(EOFError):
            router.recv()

    def test_unauthorized_submit_gets_error_24(self):
        pool = FakePool()
        _, _, port = self.make_proxy(pool)
        router = self.router(port)
        resp, _ = router.recv_response(router.call("mining.submit", ["x", "job1", "00", "66f00000", "00"]))
        self.assertEqual(resp["error"], [24, "Unauthorized worker", None])
        self.assertEqual(pool.of("mining.submit"), [])

    def test_rejected_share_is_relayed_and_published(self):
        pool = FakePool(submit_error=[23, "Low difficulty share", None])
        _, publisher, port = self.make_proxy(pool)
        router = self.router(port)
        router.handshake()
        resp, _ = router.recv_response(router.call("mining.submit", ["r", "job1", "0000000000000001", "66f00000", "00000000"], req_id="s-1"))
        self.assertEqual(resp, {"id": "s-1", "result": None, "error": [23, "Low difficulty share", None]})
        share = wait_for(lambda: publisher.of(lambda m: m.get("type") == "share"))[0]
        self.assertFalse(share["accepted"])
        self.assertEqual(share["reject_reason"], "Low difficulty share")

    def test_configure_rejected_upstream(self):
        pool = FakePool(configure_ok=False)
        _, _, port = self.make_proxy(pool)
        router = self.router(port)
        cfg, _ = router.recv_response(router.call("mining.configure", work_proxy.CONFIGURE_PARAMS))
        self.assertEqual(cfg["result"], {"version-rolling": False})

    def test_new_connection_replaces_old(self):
        pool = FakePool()
        _, _, port = self.make_proxy(pool)
        first = self.router(port)
        first.handshake()
        second = self.router(port)
        _, auth = second.handshake()
        self.assertIs(auth["result"], True)
        with self.assertRaises((EOFError, ConnectionResetError)):
            while True:
                first.recv()

    def test_upstream_reconnect_closes_router_which_resubscribes(self):
        pool = FakePool(en1s=("a1b2c3d4", "0badf00d"))
        _, _, port = self.make_proxy(pool)
        router = self.router(port)
        router.handshake()
        router.recv()  # set_difficulty
        router.recv()  # notify
        pool.drop_connection()
        with self.assertRaises((EOFError, ConnectionResetError)):
            while True:
                router.recv()
        wait_for(lambda: pool.connections == 2)
        again = self.router(port)
        sub, auth = again.handshake()
        self.assertEqual(sub["result"][1:], ["0badf00d", 8])
        self.assertIs(auth["result"], True)

    def test_upstream_drop_closes_router_and_rejects_while_down(self):
        pool = FakePool()
        proxy, _, port = self.make_proxy(pool, ready_timeout=0.2)
        router = self.router(port)
        router.handshake()
        router.recv()
        router.recv()
        pool.listener.close()  # refuse reconnects
        pool.drop_connection()
        with self.assertRaises((EOFError, ConnectionResetError)):
            while True:
                router.recv()
        self.assertFalse(proxy._ready.is_set())
        again = self.router(port)
        sub, _ = again.recv_response(again.call("mining.subscribe", []))
        self.assertEqual(sub["error"], [20, "Upstream unavailable", None])
        auth, _ = again.recv_response(again.call("mining.authorize", ["router", TOKEN]))
        self.assertIs(auth["result"], False)
        with self.assertRaises((EOFError, ConnectionResetError)):
            again.recv()

    def test_unauthenticated_connection_does_not_evict_router(self):
        pool = FakePool()
        _, _, port = self.make_proxy(pool)
        router = self.router(port)
        router.handshake()
        router.recv()
        router.recv()
        idle = self.router(port)  # e.g. a TCP probe that never speaks
        intruder = self.router(port)
        _, auth = intruder.handshake(token="wrong-token")
        self.assertIs(auth["result"], False)
        pool.send({"id": None, "method": "mining.notify", "params": ["job2"] + NOTIFY_PARAMS[1:]})
        notify = router.recv()
        self.assertEqual((notify["method"], notify["params"][0]), ("mining.notify", "job2"))
        resp, _ = router.recv_response(router.call("mining.submit", ["r", "job2", "00", "66f00000", "00"], req_id=9))
        self.assertIs(resp["result"], True)
        idle.close()

    def test_router_sends_happen_outside_proxy_lock(self):
        pool = FakePool()
        proxy, _, port = self.make_proxy(pool)
        held = []
        original = work_proxy._Session._write

        def checking_write(session, obj):
            got = []
            t = threading.Thread(target=lambda: got.append(proxy._lock.acquire(timeout=1.0)) or (got[0] and proxy._lock.release()))
            t.start()
            t.join()
            held.append(not got[0])
            return original(session, obj)

        with unittest.mock.patch.object(work_proxy._Session, "_write", checking_write):
            router = self.router(port)
            router.handshake()
            router.recv()
            router.recv()
            pool.send({"id": None, "method": "mining.set_difficulty", "params": [2048]})
            router.recv()
            router.recv_response(router.call("mining.submit", ["r", "job1", "00", "66f00000", "00"]))
        self.assertTrue(held)
        self.assertFalse(any(held), "a downstream write happened while _lock was held")

    def test_stuck_router_is_closed_after_send_timeout(self):
        pool = FakePool()
        proxy, _, port = self.make_proxy(pool, send_timeout=0.3, document_factory=lambda *a, **k: {})
        router = self.router(port)
        router.handshake()
        wait_for(lambda: proxy._session is not None)
        big = ["jobX", "00" * 32, "ab" * 15000] + NOTIFY_PARAMS[3:]
        for _ in range(400):  # router never reads: its receive buffer fills up
            try:
                pool.send({"id": None, "method": "mining.notify", "params": big})
            except OSError:
                break
            if proxy._session is None:
                break
        wait_for(lambda: proxy._session is None, timeout=10.0)

    def test_rejected_without_error_message_has_null_reason(self):
        pool = FakePool(submit_result=False)
        _, publisher, port = self.make_proxy(pool)
        router = self.router(port)
        router.handshake()
        router.recv_response(router.call("mining.submit", ["r", "job1", "00", "66f00000", "00"]))
        share = wait_for(lambda: publisher.of(lambda m: m.get("type") == "share"))[0]
        self.assertFalse(share["accepted"])
        self.assertIsNone(share["reject_reason"])

    def test_oversized_line_closes_router(self):
        pool = FakePool()
        _, _, port = self.make_proxy(pool)
        router = self.router(port)
        router.sock.sendall(b'{"id":1,"method":"mining.subscribe","params":["' + b"x" * (70 * 1024) + b'"]}\n')
        with self.assertRaises((EOFError, ConnectionResetError, BrokenPipeError)):
            while True:
                router.recv()

    def test_upstream_notifications_forwarded(self):
        pool = FakePool()
        _, _, port = self.make_proxy(pool)
        router = self.router(port)
        router.handshake()
        router.recv()
        router.recv()
        pool.send({"id": None, "method": "mining.set_version_mask", "params": ["1fff0000"]})
        pool.send({"id": None, "method": "mining.set_difficulty", "params": [1024]})
        self.assertEqual(router.recv()["params"], ["1fff0000"])
        self.assertEqual(router.recv()["params"], [1024])
        cfg, _ = router.recv_response(router.call("mining.configure", work_proxy.CONFIGURE_PARAMS))
        self.assertEqual(cfg["result"]["version-rolling.mask"], "1fff0000")

    def test_secrets_never_logged(self):
        pool = FakePool()
        with self.assertLogs(level=logging.DEBUG) as logs:
            _, _, port = self.make_proxy(pool)
            router = self.router(port)
            router.handshake(token="wrong")
            router2 = self.router(port)
            router2.handshake()
            router2.recv_response(router2.call("mining.submit", ["r", "job1", "00", "66f00000", "00"]))
        joined = "\n".join(logs.output)
        self.assertNotIn(TOKEN, joined)
        self.assertNotIn(POOL_PASS, joined)

    def test_token_compare_is_constant_time(self):
        with unittest.mock.patch.object(work_proxy.hmac, "compare_digest", wraps=work_proxy.hmac.compare_digest) as cmp:
            pool = FakePool()
            _, _, port = self.make_proxy(pool)
            self.router(port).handshake()
            self.assertTrue(cmp.called)


class WorkModeCliTest(unittest.TestCase):
    BASE = ["main.py", "-u", "stratum+tcp://127.0.0.1:1", "-up", f"{POOL_USER}:{POOL_PASS}", "--mode", "work"]

    def setUp(self):
        self.env = unittest.mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        os.environ.pop("WORK_TOKEN", None)
        self.addCleanup(self.env.stop)

    def test_work_mode_requires_token(self):
        with unittest.mock.patch.object(sys, "argv", self.BASE), \
                unittest.mock.patch.object(sys, "stderr"), self.assertRaises(SystemExit):
            main.main()

    def test_work_mode_dispatches_to_work_proxy(self):
        argv = self.BASE + ["--work-token", TOKEN, "--site", "us-ash-1"]
        with unittest.mock.patch.object(sys, "argv", argv), \
                unittest.mock.patch.object(main, "initialize_tip_state"), \
                unittest.mock.patch.object(main, "start_tip_listener"), \
                unittest.mock.patch.object(main.work_proxy, "run") as run:
            main.main()
        args, meta, factory = run.call_args.args
        self.assertEqual(args.work_token, TOKEN)
        self.assertEqual(args.account, POOL_USER)
        self.assertEqual(meta.mode, "work")
        self.assertEqual(meta.account, POOL_USER)
        self.assertEqual(meta.connection_id, "us-ash-1/127.0.0.1/work")
        self.assertIs(factory, main.create_notification_document)

    def test_work_token_from_env(self):
        os.environ["WORK_TOKEN"] = TOKEN
        args = main.build_parser().parse_args(self.BASE[1:])
        self.assertEqual(args.work_token, TOKEN)


if __name__ == "__main__":
    unittest.main()
