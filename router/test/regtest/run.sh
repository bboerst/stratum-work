#!/usr/bin/env bash
# REGTEST ONLY: end-to-end hashrate-router harness. See README.md.
#   COMPOSE   compose command (default: "docker compose"; e.g. "podman compose")
#   DURATION  seconds to mine through the router (default: 300)
#   MINERS    testminer replicas (single-threaded each; default: CPU count)
#   POOL_A_THS  pool-a targetThs (default: MINERS * 2.5 MH/s, ~half the total)
#   KEEP=1    leave the stack running afterwards
#   STRICT=1  also require upstream-accepted shares per target and chain
#             advance (use a long DURATION, e.g. 1800, on CPU miners)
set -euo pipefail

cd "$(dirname "$0")"
COMPOSE=${COMPOSE:-docker compose}
DURATION=${DURATION:-300}
STRICT=${STRICT:-0}
MINERS=${MINERS:-$( (command -v nproc >/dev/null && nproc) || sysctl -n hw.ncpu 2>/dev/null || echo 2)}
ADMIN_PORT=${ROUTER_ADMIN_PORT:-19100}
ADMIN="http://127.0.0.1:${ADMIN_PORT}"
# Valid regtest P2PKH (hash160 of "regtest-remainder"); no key needed to mine to it.
MINE_ADDR=mznPoBvyxTGLB8w8Wojod1DmpakNzyuzY1
# Each single-threaded testminer does ~3-10 MH/s; aim pool-a at about half.
POOL_A_THS=${POOL_A_THS:-$(awk -v m="$MINERS" 'BEGIN {printf "%.8f", m * 0.0000025}')}
export ROUTER_ADMIN_PORT=$ADMIN_PORT
export ROUTER_CONFIG=./router.gen.yaml
sed "s/^\(    targetThs:\).*/\1 ${POOL_A_THS}/" router.yaml > router.gen.yaml

dc() { $COMPOSE -f docker-compose.yml "$@"; }
cli() { dc exec -T bitcoind bitcoin-cli -conf=/etc/bitcoin/bitcoin.conf "$@"; }
log() { printf '[regtest] %s\n' "$*"; }

cleanup() {
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    log "FAILED (exit $rc); recent logs:"
    dc logs --tail=40 router datum pool-a collector-work 2>/dev/null || true
  fi
  if [[ "${KEEP:-0}" == "1" ]]; then
    log "KEEP=1: stack left running (${COMPOSE} -f $(pwd)/docker-compose.yml down -v to stop)"
  else
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f router.gen.yaml
  fi
  exit $rc
}
trap cleanup EXIT

log "building images"
dc build

log "starting bitcoind"
dc up -d bitcoind
for _ in $(seq 1 60); do cli getblockchaininfo >/dev/null 2>&1 && break; sleep 2; done
cli getblockchaininfo >/dev/null
log "mining 101 blocks to $MINE_ADDR"
cli generatetoaddress 101 "$MINE_ADDR" >/dev/null
START_HEIGHT=$(cli getblockcount)
log "chain height after activation: $START_HEIGHT"

log "starting stack with $MINERS testminer(s); pool-a targetThs=$POOL_A_THS"
dc up -d --scale "testminer=${MINERS}"

for _ in $(seq 1 60); do
  curl -fsS "$ADMIN/healthz" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "$ADMIN/healthz" >/dev/null || { log "router admin not reachable at $ADMIN"; exit 1; }

log "mining through the router for ${DURATION}s"
elapsed=0
while (( elapsed < DURATION )); do
  step=$(( DURATION - elapsed < 30 ? DURATION - elapsed : 30 ))
  sleep "$step"
  elapsed=$(( elapsed + step ))
  log "t=${elapsed}s height=$(cli getblockcount) $(curl -fsS "$ADMIN/metrics" | grep '^router_upstream_submits_total' | tr '\n' ' ')"
done

log "router /status:"
curl -fsS "$ADMIN/status"
echo
METRICS=$(curl -fsS "$ADMIN/metrics")

# Upstream accept counts are only exported on /metrics
# (router_upstream_submits_total{result,target}); /status carries targets,
# remainder and per-connection downstream counts.
accepted() {
  printf '%s\n' "$METRICS" \
    | awk -v t="target=\"$1\"" '/^router_upstream_submits_total\{/ && /result="accepted"/ && index($0, t) {s += $NF} END {printf "%d", s}'
}

delivered() {
  printf '%s\n' "$METRICS" \
    | awk -v t="target=\"$1\"" '/^router_target_delivered_hashrate\{/ && index($0, t) {s += $NF} END {printf "%.0f", s}'
}

# Always required: both targets received valid (downstream-verified) work,
# proving scheduling and extranonce folding for each. DATUM's minimum share
# difficulty is 1 (~2^32 hashes), so upstream accepts from CPU miners are
# Poisson-rare in a short run; they are required only with STRICT=1.
fail=0
for target in pool-a datum; do
  d=$(delivered "$target")
  n=$(accepted "$target")
  if [[ "$d" != "0" ]]; then
    log "OK   $target: delivered ${d} H/s, $n accepted upstream submits"
  else
    log "FAIL $target: no work delivered"
    fail=1
  fi
  if (( STRICT )) && (( n == 0 )); then
    log "FAIL $target: no accepted upstream submits (STRICT=1)"
    fail=1
  fi
done

END_HEIGHT=$(cli getblockcount)
log "chain height: start=$START_HEIGHT end=$END_HEIGHT (+$(( END_HEIGHT - START_HEIGHT )))"
if (( STRICT )) && (( END_HEIGHT <= START_HEIGHT )); then
  log "FAIL chain did not advance (no block-level share found; STRICT=1)"
  fail=1
fi

if (( fail )); then
  exit 1
fi
log "PASS"
