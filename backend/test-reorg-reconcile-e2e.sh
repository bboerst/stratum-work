#!/usr/bin/env bash
# Best-chain reconciliation end to end (#212): two regtest bitcoind nodes, the backend following node1, reorgs made by
# letting node2 mine a longer branch while the nodes are disconnected. Needs Docker; everything runs in throwaway
# containers on a private network.
#
#   backend/test-reorg-reconcile-e2e.sh
#
# Each reorg is "loser first": node1 mines the loser(s) (the backend stores them as the tip), node2 mines a longer
# branch, the nodes reconnect and node1 reorgs. ZMQ only announces the new tip; the reconciler has to replace the rest.
# A. Postgres, STALE_BLOCKS_ENABLED=false: blocks_best converges to node1's chain anyway; the loser gets a
#    stale_blocks row (was_active) and a chain_reorgs row; the winner has a seen_at.
# B. Postgres, backend stopped across the reorg (docker stop, reorg, docker start): converges after the restart.
# C. Postgres, a 2-deep reorg, with the stale-block tracker on too: converges, one chain_reorgs row of depth 2.
# D. Postgres, the full-history best-chain check: BLOCK_GAP_WINDOW=2, tracker off, history check off, backend stopped
#    across a reorg whose loser ends up 6 blocks below the tip: the loser stays best. Restarted with the history check
#    on, blocks_best converges, the loser gets a stale_blocks row and the winner is stored as synced (seen_at and
#    seen_via NULL).
set -uo pipefail
cd "$(dirname "$0")/.."
IMAGE_PG=timescale/timescaledb:2.30.2-pg18
IMAGE_BTC=bitcoin/bitcoin:32.1
IMAGE_PY=python:3.13-slim
DBMATE=ghcr.io/amacneil/dbmate:2.37.0
NET=reorg-e2e-$$; PG=reorg-pg-$$; B1=reorg-btc1-$$; B2=reorg-btc2-$$; BE=reorg-backend-$$
ok=0; bad=0
# check DESCRIPTION COMMAND [ARGS...]: no eval, so SQL needs only one level of quoting
check() { local d=$1; shift; if "$@" >/dev/null 2>&1; then echo "  PASS  $d"; ok=$((ok+1)); else echo "  FAIL  $d"; bad=$((bad+1)); fi; }
retry() { local n=$1; shift; for _ in $(seq "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
cleanup() { docker rm -fv "$BE" "$B1" "$B2" "$PG" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT

cli() { local n=$1; shift; docker exec "$n" bitcoin-cli -regtest -rpcuser=test -rpcpassword=test "$@"; }
sql() { docker exec "$PG" psql -h localhost -U postgres -v ON_ERROR_STOP=1 -At -c "$1"; }
sql_is() { [ "$(sql "$1")" = "$2" ]; }
node2_at() { [ "$(cli "$B2" getblockcount)" = "$1" ]; }
logs_have() { [[ "$(docker logs "$1" 2>&1)" == *"$2"* ]]; }   # not grep -q: with pipefail, SIGPIPE fails it
mine() { cli "$1" generatetodescriptor "$2" "raw($3)" | tr -d '[]" \n' | tr ',' ' '; }

# node1's active chain from $1 to its tip, "height:hash" per line
node_chain() { local tip; tip=$(cli "$B1" getblockcount); for h in $(seq "$1" "$tip"); do echo "$h:$(cli "$B1" getblockhash "$h")"; done; }
pg_chain() { sql "SELECT height || ':' || encode(block_hash, 'hex') FROM blocks_best WHERE height >= $1 ORDER BY height, block_hash"; }
pg_converged() { [ "$(pg_chain "$1")" = "$(node_chain "$1")" ]; }
disconnect() { for n in "$B1" "$B2"; do cli "$n" setnetworkactive false >/dev/null; done; }
reconnect() {   # and wait until node1 has node2's tip
  local tip; tip=$(cli "$B2" getbestblockhash)
  for n in "$B1" "$B2"; do cli "$n" setnetworkactive true >/dev/null; done
  cli "$B1" addnode "$B2:18444" onetry >/dev/null
  for _ in $(seq 60); do [ "$(cli "$B1" getbestblockhash)" = "$tip" ] && return 0; sleep 1; done; return 1
}

BE_ENV=(-e BITCOIN_RPC_HOST="$B1" -e BITCOIN_RPC_PORT=18443 -e BITCOIN_RPC_USER=test -e BITCOIN_RPC_PASSWORD=test
  -e BITCOIN_ZMQ_BLOCK="tcp://$B1:28332" -e STALE_POLL_INTERVAL_S=2
  -e RABBITMQ_HOST=127.0.0.1 -e RABBITMQ_MAX_RETRIES=1 -e RABBITMQ_RETRY_DELAY=0
  -e POOL_LIST_URL=http://127.0.0.1:9/pools.json -e LOCAL_POOL_FILE=/nonexistent.json)
PG_ENV=(-e PG_HOST="$PG" -e PG_DATABASE=postgres -e PG_USER=backend -e PG_PASSWORD=backend -e PG_SSLMODE=disable)
# rm -rf first: a `docker start` reruns this command in the same container
BE_CMD='rm -rf /app && cp -r /src /app && cd /app && pip install -q --root-user-action=ignore -r requirements.txt 2>/dev/null && exec python -u main.py'
start_pg_backend() {   # $1 = STALE_BLOCKS_ENABLED, then more docker run options (-e ...)
  docker rm -fv "$BE" >/dev/null 2>&1
  docker run -d --name "$BE" --network "$NET" -v "$PWD/backend:/src:ro" "${PG_ENV[@]}" "${BE_ENV[@]}" \
    -e MIN_BLOCK_HEIGHT=99 -e STALE_BLOCKS_ENABLED="$1" "${@:2}" "$IMAGE_PY" sh -c "$BE_CMD" >/dev/null
}

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

echo "== common chain"
cli "$B1" addnode "$B2:18444" onetry >/dev/null
cli "$B1" generatetodescriptor 101 "raw(51)" >/dev/null
check "node2 synced to 101" retry 30 node2_at 101

echo "== A. Postgres, stale-block tracker off: loser-first reorg of depth 1"
start_pg_backend false
check "backend stores the chain" retry 180 pg_converged 99
check "tracker is off" logs_have "$BE" "Stale block tracking off"
disconnect
Y=$(mine "$B1" 1 51)
check "backend stores node1's tip Y (the loser)" retry 90 sql_is "SELECT count(*) FROM blocks_best WHERE block_hash = '\\x$Y'" 1
read -r W1 W2 <<<"$(mine "$B2" 2 53)"
check "node1 reorged to node2's branch" reconnect
check "blocks_best converges to node1's chain" retry 90 pg_converged 99
check "Y kept in blocks, hidden from blocks_best" sql_is "SELECT (SELECT count(*) FROM blocks WHERE block_hash = '\\x$Y') || '|' || (SELECT count(*) FROM blocks_best WHERE block_hash = '\\x$Y')" '1|0'
check "Y: stale_blocks row, was_active, valid-fork, full block, linked to a reorg" \
  sql_is "SELECT was_active, chaintip_status, full_block, reorg_id IS NOT NULL, height FROM stale_blocks WHERE block_hash = '\\x$Y'" 't|valid-fork|t|t|102'
check "chain_reorgs: depth 1 at fork 101, Y -> node1's tip" \
  sql_is "SELECT depth, fork_height, encode(old_tip_hash, 'hex'), encode(new_tip_hash, 'hex'), new_tip_height FROM chain_reorgs" "1|101|$Y|$W2|103"
check "the winner at 102 has a seen_at (detection time, not NULL)" sql_is "SELECT seen_at IS NOT NULL FROM blocks WHERE block_hash = '\\x$W1'" t

echo "== B. Postgres, backend stopped across the reorg"
disconnect
YB=$(mine "$B1" 1 51)
check "backend stores the loser at 104" retry 90 sql_is "SELECT count(*) FROM blocks_best WHERE block_hash = '\\x$YB'" 1
docker stop "$BE" >/dev/null
read -r WB1 WB2 <<<"$(mine "$B2" 2 53)"
check "node1 reorged while the backend was down" reconnect
check "nothing changed while it was down" sql_is "SELECT count(*) FROM blocks_best WHERE block_hash = '\\x$YB'" 1
docker start "$BE" >/dev/null
check "after the restart blocks_best converges" retry 180 pg_converged 99
check "the loser has a stale_blocks row (was_active)" sql_is "SELECT was_active FROM stale_blocks WHERE block_hash = '\\x$YB'" t
check "the winner at 104 has a seen_at" sql_is "SELECT seen_at IS NOT NULL FROM blocks WHERE block_hash = '\\x$WB1'" t

echo "== C. Postgres, 2-deep reorg, stale-block tracker on as well"
start_pg_backend true
check "backend up, tracker on" retry 180 logs_have "$BE" "Stale block tracking started"
check "backend caught up" retry 120 pg_converged 99
disconnect
read -r Y1 Y2 <<<"$(mine "$B1" 2 51)"
check "backend stores both losers" retry 90 sql_is "SELECT count(*) FROM blocks_best WHERE block_hash IN ('\\x$Y1', '\\x$Y2')" 2
FORK=$(( $(cli "$B1" getblockcount) - 2 ))
mine "$B2" 3 53 >/dev/null
check "node1 reorged (depth 2)" reconnect
check "blocks_best converges" retry 90 pg_converged 99
check "both losers currently stale, was_active, valid-fork" \
  sql_is "SELECT string_agg(was_active::text || ':' || chaintip_status, ',') FROM stale_blocks WHERE block_hash IN ('\\x$Y1', '\\x$Y2') AND reorged_in_at IS NULL" 'true:valid-fork,true:valid-fork'
sleep 6   # a few tracker polls after the reconciler
check "exactly one chain_reorgs row for it, depth 2" sql_is "SELECT count(*) || '|' || max(depth) FROM chain_reorgs WHERE fork_height = $FORK" '1|2'

echo "== D. Postgres, full-history best-chain check: a replaced block deeper than BLOCK_GAP_WINDOW"
SMALL=(-e BLOCK_GAP_WINDOW=2 -e BLOCK_GAP_FILL_INTERVAL_S=3)
start_pg_backend false "${SMALL[@]}" -e BEST_CHAIN_HISTORY_INTERVAL_S=0
check "backend up, history check off" retry 180 logs_have "$BE" "Best-chain history check off"
check "backend caught up" retry 180 pg_converged 99
disconnect
YE=$(mine "$B1" 1 51)
EH=$(cli "$B1" getblockcount)
check "backend stores the loser at $EH" retry 90 sql_is "SELECT count(*) FROM blocks_best WHERE block_hash = '\\x$YE'" 1
# Stopped across the reorg: running, it would see node1 switch as soon as node2's second block arrived (the window
# would then fix the loser). Restarted, the sync stores the heights above the stored tip and the window only reaches
# the top two.
docker stop "$BE" >/dev/null
mine "$B2" 7 53 >/dev/null
WE=$(cli "$B2" getblockhash "$EH")
check "node1 reorged (the loser 6 below the new tip)" reconnect
docker start "$BE" >/dev/null
check "the sync and the window bring every other height in line" retry 180 pg_converged $((EH + 1))
sleep 8   # a few gap-fill runs
check "the loser is still best below the window (the bug)" sql_is "SELECT encode(block_hash, 'hex') FROM blocks_best WHERE height = $EH" "$YE"
check "the node's block at $EH isn't stored" sql_is "SELECT count(*) FROM blocks WHERE block_hash = '\\x$WE'" 0
start_pg_backend false "${SMALL[@]}" -e BEST_CHAIN_HISTORY_INTERVAL_S=86400
check "after a restart with the history check on, blocks_best converges" retry 180 pg_converged 99
check "the history check logged its summary" retry 30 logs_have "$BE" "Best-chain history check 99.."
check "the loser kept in blocks, stale_blocks row (was_active)" \
  sql_is "SELECT (SELECT count(*) FROM blocks WHERE block_hash = '\\x$YE') || '|' || was_active || '|' || height FROM stale_blocks WHERE block_hash = '\\x$YE'" "1|true|$EH"
check "the winner stored as synced (seen_at and seen_via NULL)" \
  sql_is "SELECT (seen_at IS NULL AND seen_via IS NULL)::text FROM blocks WHERE block_hash = '\\x$WE'" true
check "one best block per height" sql_is "SELECT count(*) FROM (SELECT height FROM blocks_best GROUP BY height HAVING count(*) > 1) d" 0

echo "== backend logs (best chain / stale)"
docker logs "$BE" 2>&1 | grep -iE "best chain|best-chain|stale block|reorg" | tail -20
echo "RESULT: $ok passed, $bad failed"
[ "$bad" = 0 ]
