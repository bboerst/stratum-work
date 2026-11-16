import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import new_vulns  # noqa: E402


def report(*vulns):
    return {"Results": [{"Target": "app", "Vulnerabilities": [
        {"VulnerabilityID": i, "PkgName": p, "InstalledVersion": "1", "FixedVersion": fx, "Status": st,
         "Severity": sev} for i, p, sev, fx, st in vulns]}]}


class Tests(unittest.TestCase):
    def test_only_findings_not_in_main_are_new(self):
        main = report(("CVE-1", "a", "CRITICAL", "2", "fixed"))
        pr = report(("CVE-1", "a", "CRITICAL", "2", "fixed"), ("CVE-2", "b", "HIGH", "2", "fixed"))
        new, total, fixed = new_vulns.compare(pr, main)
        self.assertEqual([f["id"] for f in new], ["CVE-2"])
        self.assertEqual((total, fixed), (2, 0))

    def test_unfixed_and_low_severity_ignored(self):
        pr = report(("CVE-1", "a", "CRITICAL", "", "affected"), ("CVE-2", "b", "MEDIUM", "2", "fixed"))
        self.assertEqual(new_vulns.compare(pr, report())[0], [])

    def test_no_main_means_everything_is_new(self):
        pr = report(("CVE-1", "a", "CRITICAL", "2", "fixed"))
        self.assertEqual(len(new_vulns.compare(pr, None)[0]), 1)

    def test_fixed_by_pr_counted(self):
        main = report(("CVE-1", "a", "CRITICAL", "2", "fixed"))
        self.assertEqual(new_vulns.compare(report(), main), ([], 0, 1))

    def test_exit_code(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p, m = os.path.join(d, "pr.json"), os.path.join(d, "main.json")
            json.dump(report(("CVE-1", "a", "HIGH", "2", "fixed")), open(p, "w"))
            json.dump(report(), open(m, "w"))
            self.assertEqual(new_vulns.main([p, m, "--component", "x", "--fail-on", "CRITICAL"]), 0)
            json.dump(report(("CVE-9", "z", "CRITICAL", "2", "fixed")), open(p, "w"))
            self.assertEqual(new_vulns.main([p, m, "--component", "x", "--fail-on", "CRITICAL"]), 1)


if __name__ == "__main__":
    unittest.main()
