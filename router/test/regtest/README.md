# Hashrate router regtest harness

**Regtest only.** Every credential in this directory is a throwaway value
(`regtest-only-not-secret`, `regtest-work-token-not-secret`). Never reuse them
or point this stack at mainnet or testnet.

## Topology

```
testminer (xN) ──> router ──┬─> collector-work (work mode) ──> pool-a (DATUM #2)
                            └─> datum (remainder DATUM)
bitcoind (regtest, ZMQ hashblock) ──> zmqnotify-datum / zmqnotify-pool-a ──> DATUM /NOTIFY
router + collector-work ──> rabbitmq (mining_notify_exchange)
```

| Service | Image / source | Notes |
|---|---|---|
| `bitcoind` | `bitcoin/bitcoin:28.1` | `bitcoin.conf`: regtest, RPC 18443, ZMQ 28332 |
| `datum` | `images/datum` | `datum-remainder.json`; `pool_host: ""`, `pooled_mining_only: false` (solo, no OCEAN) |
| `pool-a` | `images/datum` | `datum-pool-a.json`; stands in for an external pool |
| `zmqnotify-*` | `router/Dockerfile` `/zmqnotify` | one per DATUM (sidecar in Helm) |
| `rabbitmq` | `rabbitmq:3-management` | |
| `collector-work` | `collector/` | `--mode work`, listens on 3334, upstream `pool-a:23334` |
| `router` | `router/Dockerfile` `/router` | `router.yaml`; target `pool-a` via collector-work, remainder `datum` (`.router`) |
| `testminer` | `router/Dockerfile` `/testminer` | single-threaded CPU miner with version rolling; scaled by `run.sh` |

## Running

```bash
router/test/regtest/run.sh                          # docker compose
COMPOSE="podman compose" router/test/regtest/run.sh
DURATION=900 MINERS=8 KEEP=1 router/test/regtest/run.sh
```

`run.sh` builds the images, starts bitcoind, mines 101 blocks, starts the rest of
the stack, mines through the router for `DURATION` seconds (default 300), prints
`/status`, and then checks:

- `router_target_delivered_hashrate` is > 0 for both `pool-a` and `datum`
  (each target received verified work, which exercises scheduling and folding).
- With `STRICT=1` it also requires
  `router_upstream_submits_total{result="accepted"}` > 0 per target and a
  higher regtest chain height. Because of the share-rate caveat below, pair
  `STRICT=1` with a long run, e.g. `STRICT=1 DURATION=1800`.

Upstream accept counts and chain height are always printed.

Unless `KEEP=1`, the stack is torn down with `down -v`. The router admin port is
published on `127.0.0.1:${ROUTER_ADMIN_PORT:-19100}`.

Knobs: `MINERS` (default: CPU count), `POOL_A_THS` (default `MINERS * 2.5 MH/s`
in TH/s, about half of the total). `run.sh` writes this into `router.gen.yaml`, which is gitignored.
pool-a's target must stay below the total miner hashrate, or the remainder never
gets a slice.

## Share rate caveat

DATUM's minimum stratum difficulty is 1 (`vardiff_min` must be an integer >= 1).
The router only forwards shares that meet the upstream difficulty, so an accepted
upstream submit takes about 2^32 hashes. A single-threaded Go testminer does roughly
3-10 MH/s. That works out to about 7-25 minutes per accepted share per miner-thread
on each target. With 8 miners split about 50/50, expect a few accepted
submits per target in 5 minutes. On small hosts, raise `DURATION` (such as 900-1800)
or `MINERS`. Regtest blocks are trivial, so any share that gets forwarded is also a
block, and the chain advances with each one.
