#!/usr/bin/env bash
# Historical gap fill end to end (gap_fill.py): the backend follows a PRUNED regtest node (B) that is connected to a
# full node (A). Interior gaps are made by deleting rows from `blocks` (Postgres mode), some of them at heights B has
# pruned. The backend fills the unpruned ones from B directly and the pruned ones by having B download them from A
# (getblockfrompeer). Needs Docker; everything runs in throwaway containers on a private network.
#
#   backend/test-block-gap-fill-e2e.sh
#
# Regtest pruning: -prune=550 -fastprune (64 KiB block files), then `pruneblockchain`. Two limits decide what can
# go: a block file is deleted only when every block in it is below the prune height, and the last 288 blocks are
# always kept. Regtest blocks with only a coinbase are ~240 bytes, so the first file holds ~270 blocks and the chain
# has to be ~700 long before that file can be pruned.
set -uo pipefail
cd "$(dirname "$0")/.."
IMAGE_PG=timescale/timescaledb:2.30.2-pg18
IMAGE_BTC=bitcoin/bitcoin:32.1
IMAGE_PY=python:3.13-slim
IMAGE_MQ=rabbitmq:3.13.7-alpine
DBMATE=ghcr.io/amacneil/dbmate:2.37.0
NET=gapfill-e2e-$$; PG=gapfill-pg-$$; BA=gapfill-btca-$$; BB=gapfill-btcb-$$; BE=gapfill-backend-$$; MQ=gapfill-mq-$$
MIN=255
ok=0; bad=0
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then echo "  PASS  $d"; ok=$((ok+1)); else echo "  FAIL  $d"; bad=$((bad+1)); fi; }
retry() { local n=$1; shift; for _ in $(seq "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
cleanup() { docker rm -fv "$BE" "$BA" "$BB" "$PG" "$MQ" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT

cli() { local n=$1; shift; docker exec "$n" bitcoin-cli -regtest -rpcuser=test -rpcpassword=test "$@"; }
sql() { docker exec "$PG" psql -h localhost -U postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
sql_is() { [ "$(sql "$1")" = "$2" ]; }
at() { [ "$(cli "$1" getblockcount)" = "$2" ]; }
logs_have() { [[ "$(docker logs "$1" 2>&1)" == *"$2"* ]]; }
pruned_on_b() { [[ "$(cli "$BB" getblock "$(cli "$BB" getblockhash "$1")" 1 2>&1)" == *"pruned data"* ]]; }
has_data_on_b() { cli "$BB" getblock "$(cli "$BB" getblockhash "$1")" 1 >/dev/null; }
# node A's chain from $MIN to its tip vs the backend's blocks_best, "height:hash" per line
node_chain() {   # one docker exec: a few hundred heights
  docker exec "$BA" sh -c 'c() { bitcoin-cli -regtest -rpcuser=test -rpcpassword=test "$@"; }
    for h in $(seq "$1" "$(c getblockcount)"); do echo "$h:$(c getblockhash "$h")"; done' _ "$MIN"
}
pg_chain() { sql "SELECT height || ':' || encode(block_hash, 'hex') FROM blocks_best WHERE height >= $MIN ORDER BY height, block_hash"; }
converged() { [ "$(pg_chain)" = "$(node_chain)" ]; }
stored() { sql_is "SELECT count(*) FROM blocks_best WHERE height = $1" 1; }
all_stored() { for h in "$@"; do stored "$h" || return 1; done; }
none_stored() { for h in "$@"; do stored "$h" && return 1; done; return 0; }

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=test "$IMAGE_PG" -c timescaledb.enable_chunk_skipping=on >/dev/null
# RabbitMQ only so block publishing doesn't spend seconds per block on reconnect attempts
docker run -d --name "$MQ" --network "$NET" -e RABBITMQ_DEFAULT_USER=mquser -e RABBITMQ_DEFAULT_PASS=mqpassword "$IMAGE_MQ" >/dev/null 2>&1
docker run -d --name "$BA" --network "$NET" "$IMAGE_BTC" bitcoind -regtest -server -listen -rpcbind=0.0.0.0 \
  -rpcallowip=0.0.0.0/0 -rpcuser=test -rpcpassword=test -printtoconsole=0 >/dev/null
docker run -d --name "$BB" --network "$NET" "$IMAGE_BTC" bitcoind -regtest -server -listen -rpcbind=0.0.0.0 \
  -rpcallowip=0.0.0.0/0 -rpcuser=test -rpcpassword=test -zmqpubhashblock=tcp://0.0.0.0:28332 -printtoconsole=0 \
  -prune=550 -fastprune >/dev/null
for i in $(seq 60); do docker exec "$PG" pg_isready -h localhost -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
docker run --rm --network "$NET" -v "$PWD/db:/db" -e DBMATE_NO_DUMP_SCHEMA=true \
  -e DATABASE_URL="postgres://postgres:test@$PG:5432/postgres?sslmode=disable" "$DBMATE" --wait up >/dev/null
docker exec -i "$PG" psql -h localhost -U postgres -q < db/dev-users.sql
for i in $(seq 90); do docker exec "$MQ" rabbitmq-diagnostics -q ping >/dev/null 2>&1 && break; sleep 1; done
for n in "$BA" "$BB"; do for i in $(seq 30); do cli "$n" getblockcount >/dev/null 2>&1 && break; sleep 1; done; done

echo "== chain: A mines, pruned B follows; the backend follows B"
cli "$BB" addnode "$BA:18444" onetry >/dev/null
cli "$BA" generatetodescriptor 280 "raw(51)" >/dev/null
check "B synced to 280" retry 60 at "$BB" 280
# Started while the chain is short, so the backfill (MIN..tip, paced) is quick; the rest arrives over ZMQ.
docker run -d --name "$BE" --network "$NET" -v "$PWD/backend:/src:ro" \
  -e DB_BACKEND=postgres -e PG_HOST="$PG" -e PG_DATABASE=postgres -e PG_USER=backend -e PG_PASSWORD=backend -e PG_SSLMODE=disable \
  -e BITCOIN_RPC_HOST="$BB" -e BITCOIN_RPC_PORT=18443 -e BITCOIN_RPC_USER=test -e BITCOIN_RPC_PASSWORD=test \
  -e BITCOIN_ZMQ_BLOCK="tcp://$BB:28332" -e STALE_BLOCKS_ENABLED=false -e BLOCK_GAP_WINDOW=10 \
  -e MIN_BLOCK_HEIGHT=$MIN -e BLOCK_GAP_FILL_INTERVAL_S=5 -e BLOCK_GAP_FILL_PEER_TIMEOUT_S=10 \
  -e RABBITMQ_HOST="$MQ" \
  -e POOL_LIST_URL=http://127.0.0.1:9/pools.json -e LOCAL_POOL_FILE=/nonexistent.json \
  "$IMAGE_PY" sh -c 'cp -r /src /app && cd /app && pip install -q --root-user-action=ignore -r requirements.txt 2>/dev/null && exec python -u main.py' >/dev/null
check "backend stored $MIN..280" retry 240 converged
for _ in $(seq 6); do cli "$BA" generatetodescriptor 70 "raw(51)" >/dev/null; sleep 2; done
check "B synced to 700" retry 60 at "$BB" 700
check "backend stored $MIN..700" retry 300 converged
check "the gap fill found nothing to do so far (it logs only when something is missing)" bash -c "! docker logs $BE 2>&1 | grep -q 'Gap fill'"

echo "== prune B, cut it off from A, make gaps"
PRUNEHEIGHT=$(cli "$BB" pruneblockchain 412)
echo "  B pruned up to height $PRUNEHEIGHT"
check "B pruned the first block file (prune height >= 270)" test "$PRUNEHEIGHT" -ge 270
PRUNED_GAPS=(258 259 260 261 262 270)
GAPS_SQL=$(IFS=,; echo "${PRUNED_GAPS[*]}")
all_pruned_on_b() { for h in "$@"; do pruned_on_b "$h" || return 1; done; }
check "B has no data for the pruned gap heights" all_pruned_on_b "${PRUNED_GAPS[@]}"
cli "$BB" setnetworkactive false >/dev/null
no_peers() { [ "$(cli "$BB" getconnectioncount)" = 0 ]; }
check "B disconnected" retry 20 no_peers
sql "DELETE FROM blocks WHERE height IN ($GAPS_SQL, 500)" >/dev/null
check "gaps made at the 6 pruned heights (500 may be refilled already)" sql_is "SELECT count(*) FROM blocks_best WHERE height IN ($GAPS_SQL)" 0
check "500 not pruned on B (filled without a peer)" has_data_on_b 500

echo "== no peer: the unpruned gap is filled, the pruned ones wait"
check "500 filled straight from B" retry 60 stored 500
check "pruned gaps logged as no suitable peer" retry 30 logs_have "$BE" "no connected peer serves old blocks"
check "pruned gaps still missing" none_stored "${PRUNED_GAPS[@]}"

echo "== reconnect: pruned gaps are fetched from A"
cli "$BB" setnetworkactive true >/dev/null
cli "$BB" addnode "$BA:18444" onetry >/dev/null
check "all gaps filled" retry 90 all_stored "${PRUNED_GAPS[@]}"
check "blocks_best equals A's chain $MIN..700" converged
check "logged as fetched from a peer" logs_have "$BE" "fetched from peer"
check "filled blocks stored as synced (seen_at NULL), like the backfill" \
  sql_is "SELECT count(*) FROM blocks WHERE height IN ($GAPS_SQL) AND seen_at IS NULL" 6
check "B has block 260's data again (getblockfrompeer)" has_data_on_b 260
runs_logged() { docker logs "$BE" 2>&1 | grep -c "Gap fill:.*missing"; }
sleep 6; RUNS=$(runs_logged); sleep 12   # two more runs (BLOCK_GAP_FILL_INTERVAL_S=5)
check "later runs find no gaps (no new 'missing' log)" test "$(runs_logged)" = "$RUNS"

echo "== header columns (header_fill.py)"
check "every stored block has its header columns (from getblock)" \
  sql_is "SELECT count(*) FROM blocks WHERE tx_count IS NULL OR merkle_root IS NULL OR bits IS NULL OR nonce IS NULL OR size IS NULL" 0
# Blocks stored before the columns existed: clear them at a height B has pruned (263) and one it hasn't (600).
sql "UPDATE blocks SET tx_count = NULL, size = NULL, weight = NULL, version = NULL, merkle_root = NULL, bits = NULL, nonce = NULL, difficulty = NULL WHERE height IN (263, 600)" >/dev/null
check "263 is still pruned on B" pruned_on_b 263
headers_back() { sql_is "SELECT count(*) FROM blocks WHERE height IN (263, 600) AND tx_count IS NOT NULL AND merkle_root IS NOT NULL AND bits IS NOT NULL" 2; }
check "the header fill restores them (getblockheader, also for the pruned block)" retry 30 headers_back
hdr() { cli "$BB" getblockheader "$(cli "$BB" getblockhash "$1")"; }
H263=$(hdr 263)
check "263's values are the node's (nTx, merkle root, bits, nonce)" sql_is \
  "SELECT tx_count || ' ' || encode(merkle_root, 'hex') || ' ' || lpad(to_hex(bits), 8, '0') || ' ' || nonce FROM blocks WHERE height = 263" \
  "$(echo "$H263" | python3 -c 'import json,sys; h=json.load(sys.stdin); print(h["nTx"], h["merkleroot"], h["bits"], h["nonce"])')"
check "size and weight stay NULL (a header has none)" \
  sql_is "SELECT count(*) FROM blocks WHERE height IN (263, 600) AND size IS NULL AND weight IS NULL" 2

echo "== coinbase facts and merkle branches (coinbase.py, coinbase_fill.py, #235)"
cbtxid_of() { cli "$BB" getblock "$(cli "$BB" getblockhash "$1")" 1 | python3 -c 'import json,sys; print(bytes.fromhex(json.load(sys.stdin)["tx"][0])[::-1].hex())'; }
check "every block stored from the node has its branches and coinbase txid" \
  sql_is "SELECT count(*) FROM blocks WHERE merkle_branches IS NULL OR coinbase_txid IS NULL" 0
check "700: coinbase txid as the node has it (internal byte order)" \
  sql_is "SELECT encode(coinbase_txid, 'hex') FROM blocks WHERE height = 700" "$(cbtxid_of 700)"
check "700: the stored coinbase hashes to its txid" \
  sql_is "SELECT sha256(sha256(coinbase_tx)) = coinbase_txid FROM blocks WHERE height = 700" t
# A block with transactions: spend four mature OP_TRUE coinbase outputs (regtest accepts non-standard spends) and mine
# them with A's generateblock, so the branches come from a real 5-transaction tree (odd count: duplicated nodes).
DESC=$(cli "$BA" getdescriptorinfo "wpkh(0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798)" | python3 -c 'import json,sys; print(json.load(sys.stdin)["descriptor"])')
ADDR=$(cli "$BA" deriveaddresses "$DESC" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0])')
TXS=()
for h in 1 2 3 4; do
  prev=$(cli "$BA" getblock "$(cli "$BA" getblockhash "$h")" 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["tx"][0])')
  raw=$(cli "$BA" createrawtransaction "[{\"txid\":\"$prev\",\"vout\":0}]" "[{\"$ADDR\":49.9}]")
  TXS+=("\"$raw\"")
done
TXLIST=$(IFS=,; echo "[${TXS[*]}]")
MINED=$(cli "$BA" generateblock "raw(51)" "$TXLIST" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hash"])')
check "B synced to 701" retry 60 at "$BB" 701
check "701 stored" retry 60 stored 701
check "701: 5 transactions, 3 branches stored" sql_is "SELECT length(merkle_branches) / 32 FROM blocks WHERE height = 701" 3
TX1=$(cli "$BB" getblock "$MINED" 1 | python3 -c 'import json,sys; print(bytes.fromhex(json.load(sys.stdin)["tx"][1])[::-1].hex())')
check "701: branch 0 is the node's first transaction after the coinbase" bash -c "[ -n '$TX1' ] && [ \"\$(docker exec $PG psql -h localhost -U postgres -At -c \"SELECT encode(substring(merkle_branches FROM 1 FOR 32), 'hex') FROM blocks WHERE height = 701\")\" = '$TX1' ]"
# The fill: clear 600 (B has its data) and 263 (pruned on B). Newest first: 600 is filled, then it stops at 263.
sql "UPDATE blocks SET merkle_branches = NULL, coinbase_txid = NULL, coinbase_tx = NULL WHERE height IN (263, 600)" >/dev/null
check "the coinbase fill restores 600's branches and txid (getblock verbosity 1, no coinbase bytes)" retry 30 \
  sql_is "SELECT merkle_branches IS NOT NULL AND encode(coinbase_txid, 'hex') = '$(cbtxid_of 600)' AND coinbase_tx IS NULL FROM blocks WHERE height = 600" t
check "263 (pruned on B) stays unknown, and the fill logged where it stopped" \
  bash -c "[ \"\$(docker exec $PG psql -h localhost -U postgres -At -c 'SELECT merkle_branches IS NULL FROM blocks WHERE height = 263')\" = t ] && docker logs $BE 2>&1 | grep -q 'stopped at a pruned block'"

echo "== backend logs (gap fill)"
docker logs "$BE" 2>&1 | grep -E "Gap fill" | head -30
echo "RESULT: $ok passed, $bad failed"
[ "$bad" = 0 ]
