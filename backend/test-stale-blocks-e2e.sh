#!/usr/bin/env bash
# Stale blocks end to end (#180): two regtest bitcoind nodes, the backend in Postgres mode against a throwaway
# TimescaleDB with all migrations. Needs Docker. Everything runs in throwaway containers on a private network.
#
#   backend/test-stale-blocks-e2e.sh
#
# 1. node1 mines 101 blocks; node2 syncs; the nodes are disconnected.
# 2. node1 mines Y at 102 (its tip, which the backend stores). node2 mines X at 102, invalidates it and mines X'.
#    X is handed to node1 in full (submitblock): a stale block with full data. Its tip status is 'valid-headers'
#    (data stored, never connected, so not fully validated), not 'valid-fork'. X' only as a header (submitheader):
#    a headers-only stale block.
# 3. node2 mines two more blocks on X' and the nodes reconnect: node1 reorgs to X' (depth 1). Y becomes stale with
#    was_active and a chain_reorgs row, X' is marked as on the active chain again, X stays stale, and the backend
#    stores the newly active blocks.
# 4. Templates built on Y (a stale tip) are reported by stale_tip_templates(), ones on X' (best) are not.
set -uo pipefail
cd "$(dirname "$0")/.."
IMAGE_PG=timescale/timescaledb:2.30.2-pg18
IMAGE_BTC=bitcoin/bitcoin:32.1
DBMATE=ghcr.io/amacneil/dbmate:2.37.0
NET=stale-e2e-$$; PG=stale-pg-$$; B1=stale-btc1-$$; B2=stale-btc2-$$; BE=stale-backend-$$
ok=0; bad=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; ok=$((ok+1)); else echo "  FAIL  $1"; bad=$((bad+1)); fi; }
cleanup() { docker rm -fv "$BE" "$B1" "$B2" "$PG" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT

cli() { local n=$1; shift; docker exec "$n" bitcoin-cli -regtest -rpcuser=test -rpcpassword=test "$@"; }
sql() { docker exec "$PG" psql -h localhost -U postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
wait_for() { for _ in $(seq "${3:-90}"); do [ "$(sql "$1" 2>/dev/null)" = "$2" ] && return 0; sleep 1; done; return 1; }

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=test "$IMAGE_PG" -c timescaledb.enable_chunk_skipping=on >/dev/null
for n in "$B1" "$B2"; do
  docker run -d --name "$n" --network "$NET" "$IMAGE_BTC" bitcoind -regtest -server -listen -rpcbind=0.0.0.0 \
    -rpcallowip=0.0.0.0/0 -rpcuser=test -rpcpassword=test -zmqpubhashblock=tcp://0.0.0.0:28332 -printtoconsole=0 >/dev/null
done
for i in $(seq 60); do docker exec "$PG" pg_isready -h localhost -U postgres >/dev/null 2>&1 && break; sleep 1; done; sleep 2
docker run --rm --network "$NET" -v "$PWD/db:/db" -e DBMATE_NO_DUMP_SCHEMA=true \
  -e DATABASE_URL="postgres://postgres:test@$PG:5432/postgres?sslmode=disable" "$DBMATE" --wait up >/dev/null
docker exec -i "$PG" psql -h localhost -U postgres -q < db/dev-users.sql
for n in "$B1" "$B2"; do for i in $(seq 30); do cli "$n" getblockcount >/dev/null 2>&1 && break; sleep 1; done; done

echo "== 1. common chain"
cli "$B1" addnode "$B2:18444" onetry >/dev/null
cli "$B1" generatetodescriptor 101 "raw(51)" >/dev/null
for i in $(seq 30); do [ "$(cli "$B2" getblockcount)" = 101 ] && break; sleep 1; done
check "node2 synced to 101" '[ "$(cli "$B2" getblockcount)" = 101 ]'
for n in "$B1" "$B2"; do cli "$n" setnetworkactive false >/dev/null; done

echo "== backend (Postgres mode)"
docker run -d --name "$BE" --network "$NET" -v "$PWD/backend:/src:ro" \
  -e DB_BACKEND=postgres -e PG_HOST="$PG" -e PG_DATABASE=postgres -e PG_USER=backend -e PG_PASSWORD=backend -e PG_SSLMODE=disable \
  -e BITCOIN_RPC_HOST="$B1" -e BITCOIN_RPC_PORT=18443 -e BITCOIN_RPC_USER=test -e BITCOIN_RPC_PASSWORD=test \
  -e BITCOIN_ZMQ_BLOCK="tcp://$B1:28332" -e MIN_BLOCK_HEIGHT=99 -e STALE_POLL_INTERVAL_S=2 \
  -e RABBITMQ_HOST=127.0.0.1 -e RABBITMQ_MAX_RETRIES=1 -e RABBITMQ_RETRY_DELAY=0 \
  -e POOL_LIST_URL=http://127.0.0.1:9/pools.json -e LOCAL_POOL_FILE=/nonexistent.json \
  python:3.13-slim sh -c 'cp -r /src /app && cd /app && pip install -q --root-user-action=ignore -r requirements.txt 2>/dev/null && exec python -u main.py' >/dev/null
check "backend stores the tip" 'wait_for "SELECT count(*) FROM blocks WHERE height = 101" 1 180'

echo "== 2. competing blocks at 102"
Y=$(cli "$B1" generatetodescriptor 1 "raw(51)" | tr -d '[]" \n')
X=$(cli "$B2" generatetodescriptor 1 "raw(52)" | tr -d '[]" \n')
cli "$B2" invalidateblock "$X"
XP=$(cli "$B2" generatetodescriptor 1 "raw(53)" | tr -d '[]" \n')
check "backend stores node1's tip Y" "wait_for \"SELECT count(*) FROM blocks WHERE block_hash = '\\\\x$Y'\" 1"
cli "$B1" submitblock "$(cli "$B2" getblock "$X" 0)" >/dev/null
cli "$B1" submitheader "$(cli "$B2" getblockheader "$XP" false)" >/dev/null
cli "$B1" getchaintips | tr -d ' \n'; echo
check "X recorded: full block (valid-headers), not previously active" \
  "wait_for \"SELECT full_block, chaintip_status, was_active, tx_count, coinbase_script_sig IS NOT NULL FROM stale_blocks WHERE block_hash = '\\\\x$X'\" 't|valid-headers|f|1|t'"
check "X': header only" \
  "wait_for \"SELECT full_block, chaintip_status, coinbase_script_sig IS NULL, height FROM stale_blocks WHERE block_hash = '\\\\x$XP'\" 'f|headers-only|t|102'"
HDR=$(cli "$B1" getblockheader "$X" | tr -d ' \n')
EXP=$(echo "$HDR" | sed -E 's/.*"previousblockhash":"([0-9a-f]+)".*/\1/')$(echo "$HDR" | sed -E 's/.*"merkleroot":"([0-9a-f]+)".*/\1/')$(echo "$HDR" | sed -E 's/.*"nonce":([0-9]+).*/\1/')
check "X's header fields match the node" "[ \"\$(sql \"SELECT encode(prev_hash, 'hex') || encode(merkle_root, 'hex') || nonce FROM stale_blocks WHERE block_hash = '\\\\x$X'\")\" = \"$EXP\" ]"
check "no reorg yet" '[ "$(sql "SELECT count(*) FROM chain_reorgs")" = 0 ]'
n_before=$(sql "SELECT count(*) FROM stale_blocks"); sleep 6
check "idempotent: re-polls add nothing" '[ "$(sql "SELECT count(*) FROM stale_blocks")" = "$n_before" ]'

echo "== 3. reorg: node2's longer chain wins"
cli "$B2" generatetodescriptor 2 "raw(53)" >/dev/null
TIP=$(cli "$B2" getbestblockhash)
for n in "$B1" "$B2"; do cli "$n" setnetworkactive true >/dev/null; done
cli "$B1" addnode "$B2:18444" onetry >/dev/null
for i in $(seq 60); do [ "$(cli "$B1" getbestblockhash)" = "$TIP" ] && break; sleep 1; done
check "node1 reorged to node2's tip" '[ "$(cli "$B1" getbestblockhash)" = "$TIP" ]'
check "Y recorded as stale (valid-fork), previously active, with full data" \
  "wait_for \"SELECT chaintip_status, was_active, full_block, reorg_id IS NOT NULL FROM stale_blocks WHERE block_hash = '\\\\x$Y'\" 'valid-fork|t|t|t'"
check "chain_reorgs: depth 1 at fork 101, Y -> new tip" \
  "wait_for \"SELECT depth, fork_height, encode(old_tip_hash, 'hex'), encode(new_tip_hash, 'hex'), new_tip_height FROM chain_reorgs\" '1|101|$Y|$TIP|104'"
check "X' is on the active chain again" \
  "wait_for \"SELECT reorged_in_at IS NOT NULL, last_status FROM stale_blocks WHERE block_hash = '\\\\x$XP'\" 't|active'"
check "X stays stale" "[ \"\$(sql \"SELECT reorged_in_at IS NULL FROM stale_blocks WHERE block_hash = '\\\\x$X'\")\" = t ]"
check "backend stored the newly active blocks 102..104" \
  "wait_for \"SELECT count(*) FROM blocks WHERE height BETWEEN 102 AND 104 AND block_hash <> '\\\\x$Y'\" 3"

echo "== 4. templates on the stale tip"
sql "INSERT INTO sources (name, site) VALUES ('e2e-p1', 'e2e'), ('e2e-p2', 'e2e')" >/dev/null
for p in "e2e-p1 $Y" "e2e-p2 $XP"; do set -- $p
  sql "INSERT INTO templates (received_at, source_id, height, job_id, prev_hash, coinbase1, coinbase2, merkle_branches, version, nbits, ntime, clean_jobs, extranonce1, extranonce2_length)
       SELECT now(), id, 103, 'j', stratum_prev_hash_to_block_hash('\\x$2'), '\\x01', '\\x02', '', 536870912, 545259519, 1, true, '\\x03', 8 FROM sources WHERE name = '$1'" >/dev/null
done
check "only the template on Y is reported, linked to Y" \
  "[ \"\$(sql \"SELECT string_agg(pool || ':' || tip || ':' || encode(stale_block_hash, 'hex') || ':' || stale_was_active, ',') FROM stale_tip_templates(103, 103)\")\" = 'e2e-p1:stale:$Y:true' ]"

echo "== backend log (stale-block lines)"
docker logs "$BE" 2>&1 | grep -iE "stale|reorg" | head -20
echo "RESULT: $ok passed, $bad failed"
[ "$bad" = 0 ]
