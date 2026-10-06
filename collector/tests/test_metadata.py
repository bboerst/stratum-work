import os, sys, unittest, unittest.mock
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import main  # noqa: E402

NOTIFY = {"params": ["job1", "00" * 32, "01000000", "ffffffff", [], "20000000", "1703a4b2", "66f00000", True]}

class MetadataTest(unittest.TestCase):
    def test_observe_defaults(self):
        args = main.build_parser().parse_args(["-u", "stratum+tcp://pool.example:3333", "-up", "u:p", "-p", "Example"])
        meta = main.connection_meta_from_args(args)
        self.assertEqual(meta.site, "us-ash-legacy")
        self.assertEqual(meta.connection_id, "us-ash-legacy/Example/observe")
        self.assertEqual(meta.mode, "observe")
        self.assertIsNone(meta.account)

    def test_fields_added_to_document(self):
        meta = main.ConnectionMeta(site="us-ash-1", connection_id="us-ash-1/Example/work", mode="work", account="acct.worker", endpoint_ip="203.0.113.5")
        doc = main.create_notification_document(NOTIFY, "Example", "aabbccdd", 8, "18f0000000000000", meta=meta)
        self.assertEqual(doc["site"], "us-ash-1")
        self.assertEqual(doc["connection_id"], "us-ash-1/Example/work")
        self.assertEqual(doc["mode"], "work")
        self.assertEqual(doc["account"], "acct.worker")
        self.assertEqual(doc["endpoint_ip"], "203.0.113.5")
        for legacy in ("pool_name", "timestamp", "prev_hash", "height", "job_id", "coinbase1", "coinbase2", "merkle_branches", "version", "nbits", "ntime", "clean_jobs", "extranonce1", "extranonce2_length"):
            self.assertIn(legacy, doc)

    def test_account_omitted_in_observe_mode(self):
        meta = main.ConnectionMeta(site="s", connection_id="s/p/observe", mode="observe", account="x", endpoint_ip=None)
        doc = main.create_notification_document(NOTIFY, "p", "aa", 4, "1", meta=meta)
        self.assertNotIn("account", doc)
        self.assertNotIn("endpoint_ip", doc)

    def test_db_enabled_flag(self):
        base = ["-u", "stratum+tcp://h:1", "-up", "u:p"]
        self.assertFalse(main.db_enabled_from_args(main.build_parser().parse_args(base)))
        self.assertTrue(main.db_enabled_from_args(main.build_parser().parse_args(base + ["-du", "a", "-dp", "b"])))
        self.assertFalse(main.db_enabled_from_args(main.build_parser().parse_args(base + ["-du", "a", "-dp", "b", "--no-db-enabled"])))

    def test_userpass_from_env(self):
        os.environ["STRATUM_USERPASS"] = "a:b"
        try:
            args = main.build_parser().parse_args(["-u", "stratum+tcp://h:1"])
            self.assertEqual(args.userpass, "a:b")
        finally:
            del os.environ["STRATUM_USERPASS"]

    def test_secret_env_fallbacks_and_flag_precedence(self):
        env = {"STRATUM_USERPASS": "a:b", "RABBITMQ_PASSWORD": "mq", "BITCOIN_RPC_PASSWORD": "rpc"}
        os.environ.update(env)
        try:
            args = main.build_parser().parse_args(["-u", "stratum+tcp://h:1"])
            self.assertEqual((args.rabbitmq_password, args.bitcoin_rpc_password), ("mq", "rpc"))
            args = main.build_parser().parse_args(["-u", "stratum+tcp://h:1", "-up", "c:d", "-rp", "x", "--bitcoin-rpc-password", "y"])
            self.assertEqual((args.userpass, args.rabbitmq_password, args.bitcoin_rpc_password), ("c:d", "x", "y"))
        finally:
            for k in env:
                del os.environ[k]

    def test_missing_userpass_exits(self):
        os.environ.pop("STRATUM_USERPASS", None)
        with unittest.mock.patch.object(sys, "argv", ["main.py", "-u", "stratum+tcp://h:1"]), \
                unittest.mock.patch.object(sys, "stderr"), self.assertRaises(SystemExit):
            main.main()

if __name__ == "__main__":
    unittest.main()
