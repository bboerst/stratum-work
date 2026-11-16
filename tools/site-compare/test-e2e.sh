#!/usr/bin/env bash
# End-to-end test of site-compare: unit tests, then two synthetic fake sites (tests/fakesite.py, the public API
# shapes) served inside a throwaway container, compared through HTTP by the CLI. Needs Docker; touches nothing else.
#
#   tools/site-compare/test-e2e.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
REPO=$PWD
PY_IMAGE=python:3.12-slim
PY=sc-e2e-py-$$
ok=0; bad=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; ok=$((ok+1)); else echo "  FAIL  $1"; bad=$((bad+1)); fi; }
cleanup() { docker rm -fv "$PY" >/dev/null 2>&1; }
trap cleanup EXIT

docker run -d --name "$PY" -v "$REPO:/repo:ro" -w /repo/tools/site-compare \
  -e PYTHONDONTWRITEBYTECODE=1 "$PY_IMAGE" sleep infinity >/dev/null
py() { docker exec "$PY" "$@"; }
sc() { docker exec "$PY" python -m site_compare --a http://127.0.0.1:18081 --b http://127.0.0.1:18082 --gap-s 25 \
  --rate 5 --burst 5 --cache /tmp/cache --quiet "$@"; }

echo "== unit tests"
py pip install -q --root-user-action=ignore --disable-pip-version-check -r requirements-dev.txt
check "pytest"                                  'py python -m pytest -q -p no:cacheprovider tests'
echo "== fake sites"
docker exec -d "$PY" python tests/fakesite.py serve --port-a 18081 --port-b 18082
for i in $(seq 30); do py python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:18082/api/pools')" \
  >/dev/null 2>&1 && break; sleep 0.5; done
echo "== compare"
check "runs"                                    'sc --out /tmp/r.md --json /tmp/r.json'
py python tests/fakesite.py check /tmp/r.json; [ $? = 0 ] && ok=$((ok+1)) || bad=$((bad+1))
check "markdown has the summary table"          'py grep -q "^| Templates | A 91, B 81, matched 50" /tmp/r.md'
check "markdown has the per-pool table"         'py grep -q "^| pool-one | 5/5 | 31/30 | 29 | extra_copy 1, near_miss:ntime 1 | near_miss:ntime 1 | 15.0 |" /tmp/r.md'
check "markdown lists the block differences"    'py grep -q "^- \*\*1004\*\* fields differ (analysis)" /tmp/r.md'
check "rerun is served from the cache"          'sc --json /tmp/r2.json >/dev/null && py python -c "import json,sys; r=json.load(open(\"/tmp/r2.json\"))[\"meta\"][\"requests\"]; sys.exit(not (r[\"cache_hits\"] >= 20 and r[\"network_requests\"] < 15))"'
check "same result from the cache"              'py python -c "import json,sys; a,b=(json.load(open(p)) for p in (\"/tmp/r.json\",\"/tmp/r2.json\")); sys.exit(a[\"templates\"]!=b[\"templates\"] or a[\"blocks\"]!=b[\"blocks\"])"'
check "--max-requests stops with status 3"      'sc --cache /tmp/cache2 --max-requests 5 --json /tmp/r3.json; test $? = 3'
check "an unreachable site fails cleanly"       'docker exec "$PY" python -m site_compare --a http://127.0.0.1:1 --b http://127.0.0.1:18082 --retries 1 --quiet; test $? = 4'

echo "== $ok passed, $bad failed"
[ "$bad" = 0 ]
