#!/usr/bin/env bash
# End-to-end test of the mempool recorder, in throwaway containers (needs Docker):
#   Bitcoin Core 32.1 on regtest (ZMQ sequence + rawtx, -maxmempool=5 so eviction can be forced, an RPC login limited
#   by -rpcwhitelist to exactly the methods the recorder uses), TimescaleDB with all migrations, and the recorder
#   image built from this directory, connected as a stratum_mempool login.
# Scenario: wallet + 101 blocks, ordinary sends, an RBF replacement, a block mining them, a block with a
# double-spend of a mempool tx (conflict) and a never-broadcast tx (off-mempool), size-limit eviction, a recorder
# restart with activity while it's down (resync), and a reorg (invalidateblock / reconsiderblock). Then the tables
# are checked against the node.
#
#   mempool-recorder/test-e2e.sh            # KEEP=1 leaves the containers running for inspection
set -uo pipefail
cd "$(dirname "$0")/.."
TS=timescale/timescaledb:2.30.2-pg18
DBMATE=ghcr.io/amacneil/dbmate:2.37.0
BTC=bitcoin/bitcoin:32.1
ID=$$; NET=mpr-net-$ID; PG=mpr-pg-$ID; NODE=mpr-node-$ID; REC=mpr-rec-$ID; IMG=mpr-e2e:$ID
TMP=$(mktemp -d)
ok=0; bad=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  PASS  $1"; ok=$((ok+1)); else echo "  FAIL  $1"; bad=$((bad+1)); fi; }
cleanup() {
  [ "${KEEP:-0}" = 1 ] && { echo "kept: $PG $NODE $REC (network $NET)"; return; }
  docker rm -fv "$REC" "$NODE" "$PG" >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1
  docker rmi "$IMG" >/dev/null 2>&1; rm -rf "$TMP"
}
trap cleanup EXIT

ADMIN_PW=admin-$ID; REC_PW=rec-$ID
SALT=$(openssl rand -hex 16)
HMAC=$(printf '%s' "$REC_PW" | openssl dgst -sha256 -mac HMAC -macopt "key:$SALT" | awk '{print $NF}')
WHITELIST=getrawmempool,getmempoolentry,getmempoolinfo,getrawtransaction,getblock,getblockheader,getblockhash,getblockcount

psql_() { docker exec "$PG" psql -U postgres -d stratum -v ON_ERROR_STOP=1 -At -c "$1"; }
cli() { docker exec "$NODE" bitcoin-cli -regtest -rpcuser=admin "-rpcpassword=$ADMIN_PW" "$@"; }
w() { cli -rpcwallet=w "$@"; }
# Arguments too long for a command line (big transactions) go through bitcoin-cli -stdin, one per line.
cli_stdin() { local m=$1; shift; printf '%s\n' "$@" | docker exec -i "$NODE" bitcoin-cli -regtest -rpcuser=admin "-rpcpassword=$ADMIN_PW" -rpcwallet=w -stdin "$m"; }
wait_for() { # wait_for <seconds> <condition>
  for _ in $(seq "$1"); do eval "$2" >/dev/null 2>&1 && return 0; sleep 1; done; return 1
}
metrics() { docker exec "$NODE" bash -c "exec 3<>/dev/tcp/$REC/8080 && printf 'GET /metrics HTTP/1.0\r\n\r\n' >&3 && cat <&3" 2>/dev/null; }
readyz() { docker exec "$NODE" bash -c "exec 3<>/dev/tcp/$REC/8080 && printf 'GET /readyz HTTP/1.0\r\n\r\n' >&3 && cat <&3" 2>/dev/null | head -1; }
# Every tx in the node's mempool has exactly one open row, and no other row is open.
consistent() {
  cli getrawmempool | tr -d ' ",[]' | grep . | sort > "$TMP/node"
  psql_ "SELECT hash_display(txid) FROM mempool_txs WHERE removed_at IS NULL ORDER BY 1" | sort > "$TMP/db"
  diff -q "$TMP/node" "$TMP/db"
}
settle() { sleep 3; wait_for 30 "[ \$(psql_ 'SELECT 1') = 1 ] && consistent"; }

echo "== setup"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=test -e POSTGRES_DB=stratum "$TS" -c timescaledb.enable_chunk_skipping=on >/dev/null
docker run -d --name "$NODE" --network "$NET" "$BTC" bitcoind -regtest -printtoconsole=0 -server -listen=0 \
  -fallbackfee=0.0002 -maxmempool=5 -rpcbind=0.0.0.0 -rpcallowip=0.0.0.0/0 -rpcuser=admin "-rpcpassword=$ADMIN_PW" \
  "-rpcauth=recorder:$SALT\$$HMAC" "-rpcwhitelist=recorder:$WHITELIST" -rpcwhitelistdefault=0 \
  -zmqpubsequence=tcp://0.0.0.0:28334 -zmqpubrawtx=tcp://0.0.0.0:28335 -zmqpubsequencehwm=10000 -zmqpubrawtxhwm=10000 >/dev/null
docker build -q -t "$IMG" mempool-recorder >/dev/null || { echo "image build failed"; exit 1; }
wait_for 60 'docker exec "$PG" pg_isready -U postgres -d stratum' || { echo "postgres did not start"; exit 1; }
sleep 2
docker run --rm --network "$NET" -v "$PWD/db:/db:ro" -e DATABASE_URL="postgres://postgres:test@$PG:5432/stratum?sslmode=disable" \
  -e DBMATE_NO_DUMP_SCHEMA=true "$DBMATE" --wait up >/dev/null || { echo "migrations failed"; exit 1; }
psql_ "CREATE USER t_mempool LOGIN PASSWORD 'rec-db-$ID' IN ROLE stratum_mempool" >/dev/null
wait_for 60 'cli getblockcount' || { echo "bitcoind did not start"; exit 1; }
cli createwallet w >/dev/null
ADDR=$(w getnewaddress)
cli generatetoaddress 101 "$ADDR" >/dev/null
# 120 spendable outputs for the eviction step (each big tx needs its own, unconfirmed chains are limited).
OUTS=$(for i in $(seq 120); do printf '"%s":0.3,' "$(w getnewaddress)"; done)
w sendmany "" "{${OUTS%,}}" >/dev/null
cli generatetoaddress 1 "$ADDR" >/dev/null

cat > "$TMP/env" <<EOF
BITCOIN_RPC_HOST=$NODE
BITCOIN_RPC_PORT=18443
BITCOIN_RPC_USER=recorder
BITCOIN_RPC_PASSWORD=$REC_PW
BITCOIN_ZMQ_SEQUENCE=tcp://$NODE:28334
BITCOIN_ZMQ_RAWTX=tcp://$NODE:28335
PG_HOST=$PG
PG_USER=t_mempool
PG_PASSWORD=rec-db-$ID
PG_SSLMODE=disable
MEMPOOL_HTTP_PORT=8080
MEMPOOL_RECONCILE_INTERVAL=5
MEMPOOL_STORE_RAW=true
EOF
start_rec() { docker run -d --name "$REC" --network "$NET" --env-file "$TMP/env" "$IMG" >/dev/null; }

# Already in the mempool before the recorder starts: recorded from the startup snapshot.
PRE=$(w sendtoaddress "$(w getnewaddress)" 0.1)
start_rec
check "recorder syncs at startup"         'wait_for 30 "docker logs $REC 2>&1 | grep -q \"mempool synced\""'
check "pre-existing tx from the snapshot"  'wait_for 10 "[ \"\$(psql_ \"SELECT first_seen_src FROM mempool_txs WHERE txid = hash_from_display('"'"'$PRE'"'"')\")\" = mempool ]"'

echo "== sends, RBF, mined"
S1=$(w sendtoaddress "$(w getnewaddress)" 0.2); S2=$(w sendtoaddress "$(w getnewaddress)" 0.3)
OLD=$(w -named sendtoaddress address="$(w getnewaddress)" amount=0.5 fee_rate=2)
sleep 1
NEW=$(w -named bumpfee "$OLD" | sed -n 's/.*"txid": "\(.*\)".*/\1/p')
check "bumpfee produced a replacement"     '[ -n "$NEW" ] && [ "$NEW" != "$OLD" ]'
settle
check "tables match the node's mempool"   'consistent'
q_old="SELECT removal || ':' || hash_display(replaced_by) FROM mempool_txs WHERE txid = hash_from_display('$OLD')"
check "RBF: replaced, replaced_by = the bump" '[ "$(psql_ "$q_old")" = "replaced:$NEW" ]'
check "zmq rows have fees, sizes, inputs"  '[ "$(psql_ "SELECT count(*) FROM mempool_txs WHERE txid = hash_from_display('"'"'$S1'"'"') AND fee > 0 AND vsize > 0 AND weight > 0 AND size > 0 AND octet_length(wtxid) = 32 AND octet_length(inputs) >= 36 AND first_seen_src = '"'"'zmq'"'"' AND ancestor_count >= 1")" = 1 ]'
check "fee matches getmempoolentry"        '[ "$(psql_ "SELECT fee FROM mempool_txs WHERE txid = hash_from_display('"'"'$S2'"'"')")" = "$(cli getmempoolentry "$S2" | sed -n "s/.*\"base\": \([0-9.]*\).*/\1/p" | awk "{printf \"%d\", \$1*1e8 + 0.5}")" ]'
check "raw tx stored (--store-raw)"        '[ "$(psql_ "SELECT encode(raw, '"'"'hex'"'"') FROM mempool_tx_raw WHERE txid = hash_from_display('"'"'$S1'"'"')")" = "$(cli getrawtransaction "$S1")" ]'
B1=$(cli generatetoaddress 1 "$ADDR" | tr -d ' "[]' | grep .)
settle
q_mined="SELECT count(*) FROM mempool_txs WHERE removal = 'mined' AND block_hash = hash_from_display('$B1') AND block_height = $(cli getblockcount) AND txid IN (hash_from_display('$S1'), hash_from_display('$S2'), hash_from_display('$NEW'), hash_from_display('$PRE'))"
check "mined: block hash and height"       '[ "$(psql_ "$q_mined")" = 4 ]'
check "block row: connect, from_mempool"   '[ "$(psql_ "SELECT from_mempool || '"'"'/'"'"' || off_mempool || '"'"'/'"'"' || off_mempool_checked FROM mempool_blocks WHERE block_hash = hash_from_display('"'"'$B1'"'"')")" = "4/0/true" ]'

echo "== conflict and off-mempool"
VICTIM=$(w sendtoaddress "$(w getnewaddress)" 0.25)
sleep 1
VIN=$(cli getrawtransaction "$VICTIM" 1 | tr -d '\n ' | sed -n 's/.*"vin":\[{"txid":"\([0-9a-f]*\)","vout":\([0-9]*\).*/\1 \2/p')
read -r VTX VOUT <<< "$VIN"
VAMT=$(w gettxout "$VTX" "$VOUT" false | tr -d '\n ' | sed -n 's/.*"value":\([0-9.]*\).*/\1/p')
dbl_amt=$(awk "BEGIN{printf \"%.8f\", $VAMT - 0.001}")
DRAW=$(w createrawtransaction "[{\"txid\":\"$VTX\",\"vout\":$VOUT}]" "[{\"$(w getnewaddress)\":$dbl_amt}]")
DHEX=$(w signrawtransactionwithwallet "$DRAW" | sed -n 's/.*"hex": "\(.*\)".*/\1/p')
DTXID=$(cli decoderawtransaction "$DHEX" | sed -n 's/.*"txid": "\(.*\)".*/\1/p' | head -1)
# A private tx: never broadcast, only in the block.
PU=$(w listunspent 1 | tr -d '\n ' | grep -o '"txid":"[0-9a-f]*","vout":[0-9]*' | grep -v "$VTX" | head -1)
PTX=$(sed 's/"txid":"\([0-9a-f]*\)","vout":\([0-9]*\)/\1/' <<< "$PU"); PVOUT=$(sed 's/.*"vout":\([0-9]*\)/\1/' <<< "$PU")
PAMT=$(w gettxout "$PTX" "$PVOUT" false | tr -d '\n ' | sed -n 's/.*"value":\([0-9.]*\).*/\1/p')
PRAW=$(w createrawtransaction "[{\"txid\":\"$PTX\",\"vout\":$PVOUT}]" "[{\"$(w getnewaddress)\":$(awk "BEGIN{printf \"%.8f\", $PAMT - 0.001}")}]")
PHEX=$(w signrawtransactionwithwallet "$PRAW" | sed -n 's/.*"hex": "\(.*\)".*/\1/p')
PTXID=$(cli decoderawtransaction "$PHEX" | sed -n 's/.*"txid": "\(.*\)".*/\1/p' | head -1)
B2=$(cli generateblock "$ADDR" "[\"$DHEX\",\"$PHEX\"]" | sed -n 's/.*"hash": "\(.*\)".*/\1/p')
settle
q_conf="SELECT removal || ':' || hash_display(replaced_by) || ':' || hash_display(block_hash) FROM mempool_txs WHERE txid = hash_from_display('$VICTIM')"
check "conflict: replaced_by = the block's double-spend" '[ "$(psql_ "$q_conf")" = "conflict:$DTXID:$B2" ]'
q_off="SELECT string_agg(hash_display(txid), ',' ORDER BY position) FROM mempool_offmempool WHERE block_hash = hash_from_display('$B2')"
check "off-mempool: double-spend and private tx" '[ "$(psql_ "$q_off")" = "$DTXID,$PTXID" ]'
check "block row counts them"              '[ "$(psql_ "SELECT off_mempool FROM mempool_blocks WHERE block_hash = hash_from_display('"'"'$B2'"'"')")" = 2 ]'

echo "== eviction (-maxmempool=5)"
DATA=$(head -c 80000 /dev/zero | od -An -tx1 -v | tr -d ' \n' | head -c 160000)
send_big() { # send_big <fee_rate>
  local u t v amt raw fhex hex
  u=$(w listunspent 1 9999999 '[]' true '{"minimumAmount":0.3,"maximumAmount":0.3}' | tr -d '\n ' | grep -o '"txid":"[0-9a-f]*","vout":[0-9]*' | head -1)

  t=$(sed 's/"txid":"\([0-9a-f]*\)","vout":\([0-9]*\)/\1/' <<< "$u"); v=$(sed 's/.*"vout":\([0-9]*\)/\1/' <<< "$u")
  raw=$(cli_stdin createrawtransaction "[{\"txid\":\"$t\",\"vout\":$v}]" "[{\"data\":\"$DATA\"}]")
  fhex=$(cli_stdin fundrawtransaction "$raw" "{\"fee_rate\":$1,\"add_inputs\":false,\"changePosition\":1}" | sed -n 's/.*"hex": "\(.*\)".*/\1/p')
  hex=$(cli_stdin signrawtransactionwithwallet "$fhex" | sed -n 's/.*"hex": "\(.*\)".*/\1/p')
  cli_stdin sendrawtransaction "$hex" 2>/dev/null
}
LOW=()
for _ in $(seq 8); do LOW+=("$(send_big 1.5)"); done
for _ in $(seq 70); do send_big 20 >/dev/null; done
settle
EVICTED=0; for t in "${LOW[@]}"; do cli getmempoolentry "$t" >/dev/null 2>&1 || EVICTED=$((EVICTED+1)); done
echo "  (node evicted $EVICTED of ${#LOW[@]} low-fee transactions; mempool $(cli getmempoolinfo | tr -d '\n ' | sed 's/.*"size":\([0-9]*\).*"usage":\([0-9]*\).*/\1 txs, \2 bytes usage/'))"
low_list=$(printf "hash_from_display('%s')," "${LOW[@]}")
check "node evicted low-fee txs"            '[ "$EVICTED" -ge 1 ]'
check "evicted: recorded as such"           '[ "$(psql_ "SELECT count(*) FROM mempool_txs WHERE removal = '"'"'evicted'"'"' AND txid IN (${low_list%,})")" = "$EVICTED" ]'
check "tables match the node after eviction" 'consistent'

echo "== restart (resync)"
DOWN1=$(w sendtoaddress "$(w getnewaddress)" 0.14)            # in the mempool at the stop, mined while down
settle
docker stop "$REC" >/dev/null
cli generatetoaddress 1 "$ADDR" >/dev/null
WHILE=$(w sendtoaddress "$(w getnewaddress)" 0.11)              # added while down
docker logs "$REC" > "$TMP/rec1.log" 2>&1; docker rm -f "$REC" >/dev/null
start_rec
check "restart: resynced"                   'wait_for 30 "docker logs $REC 2>&1 | grep -q \"mempool synced\""'
AFTER=$(w sendtoaddress "$(w getnewaddress)" 0.12)
settle
check "tables match the node after restart" 'consistent'
check "added while down: from the snapshot" '[ "$(psql_ "SELECT first_seen_src FROM mempool_txs WHERE txid = hash_from_display('"'"'$WHILE'"'"')")" = mempool ]'
check "mined while down: closed by the resync" '[ "$(psql_ "SELECT removal || '"'"':'"'"' || removed_src FROM mempool_txs WHERE txid = hash_from_display('"'"'$DOWN1'"'"')")" = "mined:resync" ]'
check "after restart: zmq again"            '[ "$(psql_ "SELECT first_seen_src FROM mempool_txs WHERE txid = hash_from_display('"'"'$AFTER'"'"')")" = zmq ]'
check "no duplicate open rows"              '[ "$(psql_ "SELECT count(*) FROM (SELECT txid FROM mempool_txs WHERE removed_at IS NULL GROUP BY txid HAVING count(*) > 1) d")" = 0 ]'

echo "== reorg"
R1=$(w sendtoaddress "$(w getnewaddress)" 0.13)
BR=$(cli generatetoaddress 1 "$ADDR" | tr -d ' "[]' | grep .)
settle
cli invalidateblock "$BR"
settle
check "reorg: disconnect recorded"          '[ "$(psql_ "SELECT count(*) FROM mempool_blocks WHERE event = '"'"'disconnect'"'"' AND block_hash = hash_from_display('"'"'$BR'"'"')")" = 1 ]'
check "reorg: tx back in the mempool, new row" '[ "$(psql_ "SELECT count(*) FROM mempool_txs WHERE txid = hash_from_display('"'"'$R1'"'"')")" = 2 ] && [ "$(psql_ "SELECT count(*) FROM mempool_txs WHERE txid = hash_from_display('"'"'$R1'"'"') AND removed_at IS NULL")" = 1 ]'
cli reconsiderblock "$BR"
settle
check "reorg: mined again in the same block" '[ "$(psql_ "SELECT count(*) FROM mempool_txs WHERE txid = hash_from_display('"'"'$R1'"'"') AND removal = '"'"'mined'"'"' AND block_hash = hash_from_display('"'"'$BR'"'"')")" = 2 ]'
check "tables match the node at the end"    'consistent'

echo "== ops"
check "/readyz ok"                          'readyz | grep -q "200 OK"'
metrics > "$TMP/metrics"
check "/metrics: events and removals"      'grep -q "^stratum_mempool_events_total{type=\"A\"} [1-9]" "$TMP/metrics" && grep -q "^stratum_mempool_txs_removed_total{reason=\"mined\"} [1-9]" "$TMP/metrics"'
check "/metrics: tracked = node size"      '[ "$(sed -n "s/^stratum_mempool_tracked_txs //p" "$TMP/metrics")" = "$(cli getmempoolinfo | tr -d "\n " | sed "s/.*\"size\":\([0-9]*\).*/\1/")" ]'
check "/metrics: no ZMQ gaps, no db errors" 'grep -q "^stratum_mempool_zmq_gaps_total{topic=\"sequence\"} 0" "$TMP/metrics" && grep -q "^stratum_mempool_sink_events_total{event=\"db_errors\"} 0" "$TMP/metrics"'
check "rpcwhitelist: recorder can't use the wallet" '! docker exec "$NODE" bitcoin-cli -regtest -rpcuser=recorder "-rpcpassword=$REC_PW" getbalance'
check "role: recorder can't read templates" '! docker exec "$PG" psql -U t_mempool -d stratum -c "SELECT 1 FROM templates"'
check "role: recorder can't delete"         '! docker exec "$PG" psql -U t_mempool -d stratum -c "DELETE FROM mempool_txs"'
check "no errors in the recorder logs"      '! cat "$TMP/rec1.log" <(docker logs "$REC" 2>&1) | grep -E "level=(ERROR|WARN)" | grep -v "reconnecting"'

echo "-- summary"
psql_ "SELECT coalesce(removal::text, 'open') AS state, first_seen_src, count(*) FROM mempool_txs GROUP BY 1, 2 ORDER BY 1, 2" | sed 's/^/  /'
grep -E "^stratum_mempool_(txs_removed_total|resyncs_total|rawtx_missing|unknown_removals)" "$TMP/metrics" | sed 's/^/  /'
echo "RESULT: $ok passed, $bad failed"
[ "$bad" = 0 ]
