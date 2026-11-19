# stratum.work

[stratum.work](https://stratum.work) shows, in real time, the block templates Bitcoin mining pools hand out to their miners. Collectors connect to pools over the Stratum protocol like an ordinary miner, record every `mining.notify` message, and stream them to the browser, which decodes and visualizes them: what each pool is building on, what it pays out, which transactions it put first, and how quickly it switches to a new block. The idea comes from `0xB10C` ([original thread](https://primal.net/e/note1qckcs4y67eyaawad96j7mxevucgygsfwxg42cvlrs22mxptrg05qtv0jz3)); this project puts it in a form many people can use. A development deployment runs at [dev.stratum.work](https://dev.stratum.work).

**Contents:** [How it works](#how-it-works) · [Repository map](#repository-map) · [Quick start](#quick-start-docker-compose) · [Postgres](#postgres--timescaledb) · [Data analysis](#running-it-for-data-analysis) · [Testing and CI](#testing-and-ci) · [Contributing](#contributing) · [Further reading](#further-reading)

Coding agents: also read [CLAUDE.md](CLAUDE.md) (conventions, test commands and data gotchas in short form).

## How it works

### What is collected
| Data | Source | Written by |
|---|---|---|
| **Templates:** every `mining.notify` a pool sends (job id, previous block hash, the two coinbase halves, merkle branches, version, nBits, nTime, clean-jobs flag), with receive time and latency estimates | Mining pools, over Stratum | collector |
| **Blocks:** every Bitcoin block, the pool that mined it (coinbase tags and payout addresses, matched against [mempool/mining-pools](https://github.com/mempool/mining-pools)) and the analytics findings for its height | Bitcoin Core node (RPC + ZMQ) | backend |
| **Stale blocks and reorgs:** blocks on non-active branches the node knows about, and switches of the active chain | Bitcoin Core node (`getchaintips`); for stale blocks our node never had, headers from the public [stale-blocks dataset](https://github.com/bitcoin-data/stale-blocks), validated | backend |
| **Mempool:** every transaction the node's mempool accepted, with first-seen time and how it left (mined, replaced, conflict, ...) | Bitcoin Core node (ZMQ `sequence` + `rawtx`) | mempool-recorder |

### Architecture
```mermaid
flowchart LR
  pools[Mining pools] -- "Stratum mining.notify" --> collector
  node[Bitcoin Core node] -- "RPC + ZMQ" --> backend
  node -- "ZMQ sequence, rawtx" --> recorder[mempool-recorder]
  collector -- templates --> db[("Postgres + TimescaleDB")]
  collector -- "live templates" --> mq[RabbitMQ]
  backend -- "blocks, pools, analytics, stale blocks" --> db
  backend -- "block events" --> mq
  recorder -- "mempool tables" --> db
  db --> web["web (Next.js)"]
  mq --> web
  web -- "SSE /api/stream + JSON API" --> browser[Browser: decodes and draws]
```

- **collector** (`collector-go/`, Go): one process per pool. Publishes each template to RabbitMQ for the live view and stores every template in `templates` without asking a node: which chain a template belongs to is derived at read time ([design doc](docs/design/one-templates-table.md); some pools mine other chains on the same endpoints). It also hardens ingest (line caps, quarantine of unstorable messages in `templates_rejected`, burst detection in `ingest_events`). It replaced an earlier Python collector (`collector/`, removed).
- **backend** (`backend/`, Python): follows the node (RPC + ZMQ `hashblock`), backfills blocks down to `MIN_BLOCK_HEIGHT`, identifies the pool of each block, runs the [analytics plug-ins](#adding-an-analyzer) over the templates of that height, tracks stale blocks, and publishes block events.
- **web** (`web/`, Next.js): serves the UI, the live stream (`/api/stream`, Server-Sent Events) and a read-only JSON API (`web/app/api/`).
- **mempool-recorder** (`mempool-recorder/`, Go): records the node's mempool so templates can be resolved against it (a template's `merkle_branches[0]` is the txid of its first transaction). See its [README](mempool-recorder/README.md).

**Storage.** Everything is stored in **Postgres + TimescaleDB** ([design doc](docs/design/postgres-timescale.md); the project moved there from MongoDB). The local `docker compose` stack runs it too, see [Postgres + TimescaleDB](#postgres--timescaledb).

### How the data is measured
What each value is (observed, verified or modelled), how arrival times and clocks are measured and how far they can be off, what the latency adjustment assumes, how several connections per pool and duplicates are handled, and the limits of older history: [docs/methodology.md](docs/methodology.md).

### Trustless processing
The server collects and forwards the raw messages; **all decoding, formatting and visualization happens in the browser** (coinbase reconstruction, scriptSig tags, outputs and fees, the first transaction, merkle and timing views). So anyone can check what the site shows against what the pools sent, and the stream (`GET /api/stream`) can power other tools. The browser doing the work also means client performance matters: CI measures it on every web PR ([web/perf](web/perf/README.md)).

Where the decoding lives: `web/utils/bitcoinUtils.ts` (coinbase transaction, scriptSig ASCII and info, outputs and value, first transaction, OP_RETURN and AuxPoW data), `web/utils/formatters.ts` (coinbase assembly, prev-hash, nTime, nBits). The collector only stores what it received (`newDocument` in `collector-go/document.go`); the backend's block processing is `process_block` / `build_block_doc` in `backend/main.py`.

### The `mining.notify` message
A pool sends `mining.notify` whenever it has new work: on a new block (with clean-jobs set, so miners drop old work) and periodically as it refreshes the transaction set. Its fields, and how the UI derives its columns from them, are documented one per page in [`docs/`](docs/):
[prev_block_hash](docs/prev_block_hash.md), [coinbase_raw](docs/coinbase_raw.md) (coinbase1 + extranonce1 + extranonce2 + coinbase2), [height](docs/height.md) (BIP34, from the coinbase), [coinbase_script_ascii](docs/coinbase_script_ascii.md), [coinbase_output_value](docs/coinbase_output_value.md), [merkle_branches](docs/merkle_branches.md), [first_transaction](docs/first_transaction.md), [version](docs/version.md) / [block_version](docs/block_version.md), [nbits](docs/nbits.md), [ntime](docs/ntime.md), [clean_jobs](docs/clean_jobs.md), [pool_name](docs/pool_name.md), [timestamp](docs/timestamp.md), [latency_tracking](docs/latency_tracking.md).

## Repository map
| Path | What | Stack |
|---|---|---|
| [`collector-go/`](collector-go/) | Stratum client, one per pool: `mining.notify` to Postgres and RabbitMQ, latency estimates, kernel receive timestamps, quarantine and burst records, `/livez` `/readyz` `/metrics`. A golden test against a frozen fixture from the earlier Python collector (`testdata/golden.json`) | Go |
| [`backend/`](backend/) | Follows the node; `blocks`, `pools`, analytics (`backend/analytics/`), stale blocks (`stale_blocks.py`; `stale_import.py` for ones the node never had), storage layer (`integrations/store.py`) | Python |
| [`web/`](web/) | Next.js app: realtime table, template details, timing, Sankey, infra/latency views; API routes in `web/app/api/`, data layer in `web/lib/db/`, perf harness in [`web/perf/`](web/perf/README.md) | TypeScript, Next.js 16 |
| [`mempool-recorder/`](mempool-recorder/README.md) | Records the node's mempool in Postgres | Go |
| [`db/`](db/) | Postgres schema as [dbmate](https://github.com/amacneil/dbmate) migrations (`db/migrations/`), local dev users (`dev-users.sql`), migration and SQL tests | SQL |
| [`postgres/`](postgres/) | CloudNativePG Postgres + TimescaleDB image used in production | Dockerfile |
| [`helm-charts/`](helm-charts/) | Charts for [collector](helm-charts/stratum-work-collector/README.md), [backend](helm-charts/stratum-work-backend/README.md) and [webapp](helm-charts/stratum-work-webapp/README.md) | Helm |
| [`docs/`](docs/) | Field documentation and [design docs](docs/design/postgres-timescale.md) | |

## Quick start (docker compose)
`docker compose` runs the stack on one machine: RabbitMQ, Postgres + TimescaleDB (migrations applied at startup), five collectors connected to public pools, the backend and the web app. The web app runs in **development mode with hot reload**.

### Prerequisites
- [Docker Engine](https://docs.docker.com/engine/install/) with the [Compose plugin](https://docs.docker.com/compose/install/) (`docker compose`, v2).
- About 5 GB of disk for images, plus the data you collect.
- **Optional:** a Bitcoin Core node with RPC and ZMQ, see [Connecting a Bitcoin node](#connecting-a-bitcoin-node).

### Start
```bash
git clone https://github.com/bboerst/stratum-work.git
cd stratum-work
cp .env.example .env        # optional: Bitcoin node, remote access
docker compose up --build   # add -d to run in the background
```
Open http://localhost:3000. Collectors connect to their pools straight away, and templates appear as pools send `mining.notify`. The first build takes a few minutes.

**Without a Bitcoin node** the live template table works, and so does everything the browser derives from templates. Blocks, pool identification, analytics and stale blocks stay empty, and the backend logs RPC connection errors and keeps retrying. Without stored blocks, templates from other chains can't be told apart from Bitcoin's (that's judged against the stored blocks at read time).

To run the optimized production build (no hot reload): `ENVIRONMENT=production docker compose up --build`.

### What runs
| Service | Host port | Notes |
|---|---|---|
| `web` | 3000 | Next.js, dev mode by default, `./web` mounted into the container |
| `backend` | 8001 (`BACKEND_PORT`) | Block processing and analytics; needs a node |
| `collector-*` | none | One per pool (`antpool`, `f2pool`, `poolin`, `secpool`, `256foundation`) |
| `rabbitmq` | 5672, 15672 | Management UI at http://localhost:15672 (`mquser` / `mqpassword`) |
| `postgres` | 5432 (`POSTGRES_PORT`) | TimescaleDB, plus `postgres-migrate` and `postgres-dev-users`, which run once at startup; see [below](#postgres--timescaledb) |

These are local development credentials: don't expose the ports to an untrusted network. To bind them elsewhere, see [machine-specific overrides](#machine-specific-overrides). To start only some services: `docker compose up --build web backend collector-f2pool` (dependencies start with them).

### Configuration (`.env`)
`docker compose` reads `./.env` (gitignored). Every setting is optional; the defaults are those in `docker-compose.yml`, and [`.env.example`](.env.example) documents each one.

| Setting | Default | Purpose |
|---|---|---|
| `CORS_ORIGINS` | `http://localhost:3000` | Origin(s) your browser uses for the web app (comma-separated) |
| `ALLOWED_DEV_ORIGINS` | *(empty)* | Hostnames allowed to use Next.js dev resources (hot reload) from another machine |
| `BITCOIN_RPC_HOST` / `_PORT` | `host.docker.internal` / `8332` | Node RPC endpoint |
| `BITCOIN_RPC_USER` / `_PASSWORD` | `rpc_user` / `rpc_password` | RPC credentials |
| `BITCOIN_RPC_SCHEME` / `_CA_FILE` | `http` / *(empty)* | `https` and a CA file for nodes behind a TLS proxy |
| `BITCOIN_ZMQ_BLOCK` | `tcp://host.docker.internal:28332` | ZMQ block notifications |
| `MIN_BLOCK_HEIGHT` | `863998` | Lowest height the backend backfills on first start |
| `BLOCK_GAP_WINDOW` | `144` | Heights below the tip the backend checks against the node's active chain after each sync, new block and reorg: missing blocks are fetched, blocks a reorg replaced are swapped for the node's and marked stale (0 = off; see "Best chain" below) |
| `BLOCK_GAP_FILL_INTERVAL_S` | `3600` | Seconds between runs of the historical gap fill (also once after the startup sync): every height missing between `MIN_BLOCK_HEIGHT` and the stored tip is fetched, on a pruned node through `getblockfrompeer` (0 = off; see "Historical gaps" below) |
| `BLOCK_GAP_FILL_MAX_BLOCKS` / `_PEERS` / `_PEER_TIMEOUT_S` | `50` / `3` / `30` | Per gap-fill run: blocks at most, peers tried per pruned block, seconds to wait for each peer |
| `UNKNOWN_PARENTS_ENABLED` | `true` | Keep the unknown-parents summary (`unknown_parent_pools`) up to date: after each new block over the last two hours, and once after the startup sync over the last seven days (`false` = off; see "Unknown parents" below) |
| `BEST_CHAIN_HISTORY_INTERVAL_S` | `86400` | Seconds between runs of the full-history best-chain check (also once after the startup sync): the stored best block at every height between `MIN_BLOCK_HEIGHT` and the stored tip is compared with the node's (0 = off; see "Best chain, full history" below) |
| `POSTGRES_PORT` | `5432` | Host port of the Postgres service |
| `COLLECTOR_PG_*` / `BACKEND_PG_*` / `WEB_PG_*` | the local `postgres` service, each as its own user | Point a component at another database (`_HOST`, `_PORT`, `_DATABASE`, `_USER`, `_PASSWORD`, and `_SSLMODE` for collectors and web) |
| `COLLECTOR_SITE` / `COLLECTOR_REPLICA` | `local` / `a` | Collector identity in `sources` |
| `COLLECTOR_NODE` | *(empty)* | The machine whose clock stamps `received_at`, recorded in its `ingest_events` `start` row (in Kubernetes, the pod's `spec.nodeName`) |
| `STREAM_POOL_RATE` / `STREAM_POOL_BURST` | `5` / `20` | Per-pool live display limit (every template is still stored) |
| `EXTRANONCE1_MASK_KEY` | *(random per start)* | Key for masking extranonce1 in everything the web serves |
| `TX_API_SOURCE` / `TX_API_MEMPOOL_SPACE_FALLBACK` | `mempool.space` / `false` | Where the table's first-transaction fee rates come from. Compose runs no mempool recorder, so it defaults to mempool.space; `auto` (the web's own default) = this deployment's `/api/tx` with historical data enabled, mempool.space otherwise; `local` forces `/api/tx`. The fallback asks mempool.space when `/api/tx` fails |

### Connecting a Bitcoin node
Only the backend uses the node (the collectors don't). The node needs:
- **RPC** reachable from the containers. A node on the Docker host is `host.docker.internal`; make sure `rpcallowip` allows the Docker network (e.g. `172.16.0.0/12`). Read-only RPC is enough.
- **ZMQ block notifications** on `BITCOIN_ZMQ_BLOCK`: the backend subscribes to `hashblock`:
  ```
  zmqpubhashblock=tcp://0.0.0.0:28332
  ```
- **Nodes behind a TLS proxy** (e.g. StartOS) serve RPC over `https`, often with a private CA. Point the stack at the CA rather than turning off verification: `BITCOIN_RPC_SCHEME=https` and `BITCOIN_RPC_CA_FILE=/path/to/root-ca.pem` (a host path, mounted read-only).
- **First start:** the backend backfills every block from the tip down to `MIN_BLOCK_HEIGHT`, over 100k blocks with the default. For a quick start set it a few dozen blocks below the current tip; there are no templates for blocks mined before your collectors ran anyway.

### Developing
- **Web:** edit files under `web/`; the browser updates. After changing `web/package.json`, rebuild with fresh `node_modules`: `docker compose up -d --build --renew-anon-volumes web`.
- **Backend and collectors:** the code is baked into the image, so rebuild the service you changed: `docker compose up -d --build backend` (or `collector-f2pool`, ...).
- **Logs:** `docker compose logs -f web backend`, `docker compose logs -f collector-antpool`.
- **Shell / status:** `docker compose ps`, `docker compose exec web sh`.

### Stopping and data safety
```bash
docker compose stop          # stop, keep containers and data
docker compose down          # remove containers and the network, KEEP the data volumes
```
> **Warning:** `docker compose down -v` also deletes the named volumes, i.e. **all collected data** (`pg-data`). Don't use it (or `docker volume prune`) unless that's what you want. To reset only one store, remove just its volume, e.g. Postgres:
> `docker compose rm -sf postgres && docker volume rm stratum-work_pg-data` (volume names are `<project>_<volume>`; the project defaults to the directory name, check with `docker volume ls`). The next `docker compose up` migrates the empty database again.

### Adding a pool (local)
Each `collector-*` service connects to one pool and extends the shared `x-collector-base` template (environment, dependencies, restart policy). To add one locally, put a service in your `docker-compose.override.yml` (gitignored) and change only the pool flags:
```yaml
services:
  collector-newpool:
    extends: {file: docker-compose.yml, service: collector-f2pool}
    command:
      - --pool-name=NewPool
      - --url=stratum+tcp://newpool.example.com:3333
      - --userpass=someuser.worker:x
      - --log-level=INFO
```
`--pool-name` is the name shown in the UI and stored as the source. RabbitMQ and Postgres come from the template's environment (passwords only from the environment: the collector refuses them on the command line). `docker compose run --rm --no-deps collector-f2pool --help` lists every flag with its env fallback (`PG_*`, `RABBITMQ_*`, `COLLECTOR_*`). Use a pool's public endpoint and a username it accepts for anonymous or test mining; respect its terms.

### Running on a remote machine
If the stack runs on another machine, use its hostname instead of `localhost`:
```bash
# .env
CORS_ORIGINS=http://my-devbox:3000
ALLOWED_DEV_ORIGINS=my-devbox     # without it, Next.js blocks hot reload from non-localhost hosts
```

### Machine-specific overrides
Compose changes that apply only to your machine (port bindings, extra services) go in a gitignored `docker-compose.override.yml`, which `docker compose` loads automatically. `!override` replaces a list instead of appending to it:
```yaml
services:
  web:
    ports: !override
      - "100.64.0.10:3000:3000"   # e.g. only on a VPN address
  postgres:
    ports: !override
      - "127.0.0.1:5432:5432"     # keep infrastructure on loopback
```

## Postgres + TimescaleDB
`docker compose up` runs Postgres with three services:
- `postgres`: TimescaleDB 2.30 on Postgres 18 (`timescale/timescaledb:2.30.2-pg18`); owner `stratum` / `stratum`, database `stratum`.
- `postgres-migrate`: applies [`db/migrations`](db/migrations) with dbmate, then exits.
- `postgres-dev-users`: creates the local login users `collector`, `backend` and `web` (password = user name), each granted its least-privilege role (`stratum_collector`, `stratum_backend`, `stratum_web`), then exits.

The collectors, backend and web start once the users exist, each connected as its own user. The collectors write every template to `templates`, other chains' and unparseable heights included: which chain a template belongs to, and whether it is current, is judged at read time ([design doc](docs/design/one-templates-table.md)). The web turns rows into API responses in `web/lib/db/pg-mapping.ts`.

Connect with psql (the image has it, no local install needed):
```bash
docker compose exec postgres psql postgres://web:web@localhost/stratum   # read-only, what the web sees
docker compose exec postgres psql -U stratum stratum                     # owner (local only)
psql postgres://web:web@localhost:5432/stratum                           # from the host, with a local psql
```

**Stale blocks**: on every new block and every `STALE_POLL_INTERVAL_S` (60) seconds the backend calls `getchaintips`, walks each non-active branch to the fork point and stores its blocks in `stale_blocks` (header always; coinbase, size and pool when the node has the full block); reorgs of the active chain go to `chain_reorgs`. `STALE_BLOCKS_ENABLED=false` turns it off. RPC methods used: `getchaintips`, `getblockheader`, `getblock`, `getblockhash`.

**Stale blocks our node never had** (one-off or occasional): templates from two or more pools on a previous block we don't know prove a Bitcoin block we never stored. `backend/stale_import.py` finds them (read per chunk of heights through the templates height index), takes their headers (and full blocks, where present) from the public [stale-blocks dataset](https://github.com/bitcoin-data/stale-blocks) (CC0, [doi:10.5281/zenodo.22667157](https://doi.org/10.5281/zenodo.22667157); thanks to its contributors), validates each one (hash, proof of work at our chain's difficulty, parent = our best block at height − 1, height, merkle root of a full block) and stores the valid ones in `stale_blocks` with `header_source = 'bitcoin-data/stale-blocks'` ([methodology](docs/methodology.md#blocks)). Nothing that fails a check is stored; the JSON summary lists candidates, matches, rejections and their reasons. It connects like the backend (`PG_*`, a user in the `stratum_backend` role) and needs no node:
```bash
git clone --depth 1 https://github.com/bitcoin-data/stale-blocks /tmp/stale-blocks
cd backend && python -m stale_import --csv /tmp/stale-blocks/stale-blocks.csv --blocks-dir /tmp/stale-blocks/blocks --dry-run
# then without --dry-run; --from-height / --to-height bound the template heights read, --chunk the heights per query
```

**Best chain**: after each sync, new block and reorg the backend compares its stored best block at each of the last `BLOCK_GAP_WINDOW` heights with the node's (`getblockhash`). A missing block is fetched; a stored block the node's active chain no longer has (a reorg) is replaced by the node's block, stored with `seen_at` = when the backend noticed. The replaced block stays stored: it gets a `stale_blocks` row (`was_active`, and a `chain_reorgs` row), so `blocks_best` hides it, even with `STALE_BLOCKS_ENABLED=false`. RPC methods used: `getblockcount`, `getblockhash`, `getblock`, `getchaintips`, `getblockheader`.

**Historical gaps**: the startup sync only extends the stored range at both ends, and the best-chain check covers the last `BLOCK_GAP_WINDOW` heights. Deeper gaps (e.g. blocks that failed while the database was unreachable) are filled by a separate pass, once after the startup sync and then every `BLOCK_GAP_FILL_INTERVAL_S` seconds. It reads the stored heights between `MIN_BLOCK_HEIGHT` and the stored tip (no RPC when nothing is missing) and stores up to `BLOCK_GAP_FILL_MAX_BLOCKS` missing blocks per run, newest first, as synced blocks (`seen_at` NULL, like the backfill). A pruned node answers "Block not available (pruned data)" for old blocks: then the backend asks it to download the block again from a connected peer that advertises `NETWORK` (full history; `NETWORK_LIMITED` peers only serve the last 288 blocks), outbound peers first, up to `BLOCK_GAP_FILL_PEERS` peers with `BLOCK_GAP_FILL_PEER_TIMEOUT_S` seconds each, and stores it once it arrives (the node may prune it again later; it is only needed once). The wait happens outside the block processor, so new blocks are never delayed. A block that can't be fetched is logged and retried on the next run. RPC methods used: `getblockhash`, `getblock`, plus `getpeerinfo` and `getblockfrompeer` (Bitcoin Core 23+) on a pruned node.

**Best chain, full history**: the best-chain check above only covers the recent window, so a wrong block deeper down (e.g. a history backfill that stored a block which later lost a race, while the winner isn't stored) stays wrong. Once after the startup sync and then every `BEST_CHAIN_HISTORY_INTERVAL_S` seconds (default daily), the backend compares the stored best block at every height between `MIN_BLOCK_HEIGHT` and the stored tip with the node's, in chunks of 2,000 heights: one indexed read and one `getblockhash` per height, outside the block processor, so new blocks aren't delayed. Only the fixes run on the block processor: the node's block is stored first, as a synced block (`seen_at` NULL: it wasn't seen live), on a pruned node through the gap fill's `getblockfrompeer` path, and only then is the stored block marked replaced, the same way as above. A height with no stored block is left to the gap fill. Marking a block replaced needs its header from the node (`getblockheader`); if the node never saw that block it has no header, the block stays in `blocks_best` next to the node's, and the height is logged as failed and retried on the next run. Each run logs one summary line (checked, mismatched, stored, replaced, failed, duration).

**Unknown parents**: the web's [Unknown parents](docs/methodology.md#unknown-parents) page reads `unknown_parent_pools`, which the backend keeps current from the last hours of templates (`UNKNOWN_PARENTS_ENABLED`). A new database, or history from before the backend ran, is filled by the backfill, run once from `backend/` with the backend's `PG_*` settings (as a user in the `stratum_backend` role); it walks the templates in 7-day chunks, logs each, prints a JSON summary, and can be re-run at any time (each parent is recomputed whole):
```bash
python -m unknown_parents --backfill                      # from the first template to now
python -m unknown_parents --backfill --from 2026-01-01 --to 2026-02-01 --chunk 1d
```
Until the table has rows, the page's 90-day view reads templates directly.

**Migrations:** `docker run --rm -v "$PWD/db:/db" ghcr.io/amacneil/dbmate:2.37.0 new <name>`, then fill `-- migrate:up` and a working `-- migrate:down`. TimescaleDB procedures such as `add_columnstore_policy` need `-- migrate:up transaction:false`. `db/test-migrations.sh` runs them up/down/up and checks the role privileges.

**Not in compose:** the mempool recorder. Run it from its directory (`go run . -h` lists flags and env fallbacks) against the compose Postgres; it logs in as the local user `mempool` / `mempool` (`db/dev-users.sql`, role `stratum_mempool`) and needs a node with `-zmqpubsequence` / `-zmqpubrawtx` ([README](mempool-recorder/README.md)).

## Running it for data analysis

### Getting data
- **Collect your own.** Connect a node, set `MIN_BLOCK_HEIGHT` near the tip, and let a few collectors run: `docker compose up -d --build web backend collector-f2pool collector-antpool`. A few hours give dozens of heights; every height has a few hundred templates per pool. Without a node you still get templates (but no blocks).
- **From the public site.** The web's JSON API is read-only and public (below). Fetch it politely: a request or two per second, honor `Retry-After`, and cache what you've read.

### The schema in one table
All in [`db/migrations`](db/migrations); the [design doc](docs/design/postgres-timescale.md) explains the choices. Hashes and hex fields are `bytea`; `encode(x, 'hex')` shows them.

| Object | What |
|---|---|
| `sources` | One row per collector connection: `name` (the pool), `site`, `replica` |
| `templates` | Every template, one row per `mining.notify`, whatever chain it is for (hypertable on `received_at`, indexed on `(height, source_id, received_at)`). `prev_hash` is in Stratum's word order; `height` is as the pool sent it (0 if unparseable) |
| `bitcoin_parents` | The blocks we know (`blocks` and `stale_blocks`) by `prev_hash` in Stratum's order: a template whose `prev_hash` isn't here doesn't build on our Bitcoin chain |
| `unknown_parent_pools` | The backend's summary of templates on a parent that was no known block, per (`prev_hash`, `pool`): de-duplicated count `n`, `first_received` / `last_received`, `auxpow`, connection ranks `conns`, `heights` and `nbits` (jsonb value → templates). Facts only: join `bitcoin_parents` at read time to keep the still-unknown ones ([methodology](docs/methodology.md#unknown-parents)) |
| `template_routing_labels` | The old write-time chain classification (`chain`, `reason`) of the rows that were in the former `templates_other` table, kept as a fact |
| `templates_dedup(h1, h2, t1, t2)` / `templates_copies(…)` | One stream per pool when a pool is collected over several connections, for heights `h1`–`h2` received in `[t1, t2]`: `templates_dedup` is what reads show, `templates_copies` classifies every row (`primary`, `copy`, `secondary_stream`, `gap_fill`). With one collector per pool, `templates_dedup` = the raw rows. `height_window(h1, h2)` gives a height range's receive window (`t_from`, `t_to`); pass `'-infinity', 'infinity'` for every row at the heights. The bounds go to chunk exclusion, so pass them as values |
| `blocks`, `blocks_best` | Every block stored (keyed by hash, so stale and best blocks coexist); `blocks_best` hides the currently stale ones. `block_hash` is in display (explorer) order. `mining_pool` and `analysis` are jsonb |
| `pools` | Pool definitions from mempool/mining-pools |
| `stale_blocks`, `chain_reorgs` | Stale blocks and reorgs the node saw, plus stale blocks our node never had whose headers were imported from the public [stale-blocks dataset](https://github.com/bitcoin-data/stale-blocks) after validation (`header_source` = `node` or `bitcoin-data/stale-blocks`; imported rows have status `not-in-node`) |
| `stale_tip_templates(from_height, to_height)` | Templates built on a tip other than the best block at height − 1 (`tip` = `stale` or `unknown`), per height, pool and prev hash, with how long the pool kept mining on it |
| `mempool_txs`, `mempool_tx_inputs`, `mempool_blocks`, `mempool_offmempool`, `mempool_tx_raw` | Mempool recorder tables ([details](mempool-recorder/README.md)); hashes in internal byte order |
| `templates_rejected`, `ingest_events` | collector-go only: messages it couldn't store, and bursts / dropped templates |
| `hash_display(bytea)`, `hash_from_display(text)`, `stratum_prev_hash_to_block_hash(bytea)` | Byte-order helpers: internal ↔ display hex, and Stratum `prev_hash` → block hash |

**Gotchas.** Always filter template reads on `height` (or a height range): the functions take it as arguments, and a raw `templates` read without it reads the whole table. Take the Bitcoin tip from `blocks_best`, never from `max(height)` of templates: other chains' templates are stored too, at their own heights. For one height's templates, bound the receive time with `height_window(h, h)` (the web's height reads do), so a stuck feed's late re-send or another chain's template at a past height isn't counted. Templates at height `h` are work for the block after `h − 1`. With several collectors per pool, count from `templates_dedup(…)`, or group raw rows by pool: one row per collector is not one template.

### Example queries
```sql
-- The tip
SELECT max(height) AS tip FROM blocks_best;

-- Recent blocks and who mined them
SELECT height, encode(block_hash, 'hex') AS hash, block_time, mining_pool->>'name' AS pool, analysis->'flags' AS flags
  FROM blocks_best ORDER BY height DESC LIMIT 10;

-- Per pool at one height (received in its window): templates, first template time, distinct first transactions.
-- The bounds come from height_window(). As values they exclude chunks at plan time (in psql:
-- `SELECT * FROM height_window(925000, 925000) \gset`, then :'t_from', :'t_to'); the subqueries below work in any
-- client but are slower (measured: 0.6 s against 20 ms).
SELECT pool, count(*) AS templates, min(first_seen) AS first_seen,
       count(DISTINCT substring(merkle_branches FROM 1 FOR 32)) AS first_txs
  FROM templates_dedup(925000, 925000, (SELECT t_from FROM height_window(925000, 925000)), (SELECT t_to FROM height_window(925000, 925000)))
 GROUP BY pool ORDER BY first_seen;

-- Which pools built on which previous block at a height (a fork shows up as two prev hashes)
SELECT encode(stratum_prev_hash_to_block_hash(prev_hash), 'hex') AS prev_block, array_agg(DISTINCT pool) AS pools
  FROM templates_dedup(925000, 925000, (SELECT t_from FROM height_window(925000, 925000)), (SELECT t_to FROM height_window(925000, 925000))) GROUP BY 1;

-- Each pool's first transaction of its latest template at a height, as an explorer txid
SELECT DISTINCT ON (pool) pool, hash_display(substring(merkle_branches FROM 1 FOR 32)) AS first_txid
  FROM templates_dedup(925000, 925000, (SELECT t_from FROM height_window(925000, 925000)), (SELECT t_to FROM height_window(925000, 925000)))
 WHERE length(merkle_branches) >= 32
 ORDER BY pool, received_at DESC;

-- ... joined to the mempool recorder: when the node first saw it, and its fee rate
SELECT t.pool, hash_display(m.txid) AS txid, m.first_seen, m.fee::numeric / m.vsize AS sat_per_vb
  FROM templates_dedup(925000, 925000, (SELECT t_from FROM height_window(925000, 925000)), (SELECT t_to FROM height_window(925000, 925000))) t
  JOIN mempool_txs m ON m.txid = substring(t.merkle_branches FROM 1 FOR 32);

-- Templates that don't build on a block we know, per pool (last day; /api/unknown-parents groups them by parent, from unknown_parent_pools)
SELECT s.name AS pool, count(*), min(t.height), max(t.height)
  FROM templates t JOIN sources s ON s.id = t.source_id
 WHERE t.received_at > now() - interval '1 day'
   AND NOT EXISTS (SELECT 1 FROM bitcoin_parents p WHERE p.prev_hash = t.prev_hash)
 GROUP BY 1;

-- Pools that kept mining on a stale or unknown tip in the last 100 heights
SELECT height, pool, tip, templates, mined_after_switch
  FROM stale_tip_templates((SELECT max(height) - 100 FROM blocks_best), (SELECT max(height) + 1 FROM blocks_best));

```

### Public API
Read-only, served by `web/app/api/` on any deployment (e.g. `https://stratum.work/api/...`). The public sites rate-limit per client; cache what you fetch, and prefer your own instance for bulk reads.

| Route | Returns |
|---|---|
| `GET /api/stream` | Server-Sent Events: live templates and block events, what the UI renders |
| `GET /api/mining-notify?height=H` | Templates at a height |
| `GET /api/blocks?n=20[&before=H\|&after=H\|&height=H]` | Blocks, newest first, with pool and analysis |
| `GET /api/block-pool-first-seen?height=H` | Each pool's first template time at a height, with a `reliable` flag |
| `GET /api/analysis-data?height=H[,H2]` / `?interesting=true` | Templates with decoded fields plus block details / blocks with analytics findings |
| `GET /api/pools` | Pool definitions |
| `GET /api/stale-blocks?n=20` | Recent stale blocks with the pools that built on them |
| `GET /api/unknown-parents?range=90d\|1y\|all` | Templates whose previous block is no block we know, over the last 90 days (default), the last year or all history, as episodes (one per parent): height, pools with their connections (a/b), first / last receive time, duration, templates (exact copies on a pool's connections count once), AuxPoW share, the facts (tip when first seen, offset from it, nbits, Bitcoin's bits at height − 1, proof of work, recorded as stale) and the kind inferred from them (`bitcoin_block`, `other_chain`, `invalid_parent`, `undetermined`; [rules](docs/methodology.md#unknown-parents)). Read from the backend's `unknown_parent_pools`; recomputed every 5 minutes |
| `GET /api/unknown-parents?parent=<hex>[&range=…]` | One episode's details: every template from its pools at heights h − 1 … h + 1 within its minutes ± 5, decoded (scriptSig height, tags, AuxPoW root, outputs) and labelled by the parent it built on (`best`, `stale`, `this`, `other`), plus the blocks we know at h − 1 and h with their arrival |
| `GET /api/tx/<txid>` / `GET /api/tx?txids=a,b,…[&at=ms]` | A transaction as our node saw it: fee, vsize, fee rates (own and ancestor package), first seen, how it left (mined, replaced, …) or mined off-mempool; `found: false` if never seen. Up to 100 txids, display-order hex ([details](web/app/api/tx/README.md)) |
| `GET /api/realtime-prefill` | The tip and the current templates the realtime views start from |

## Testing and CI

### Tests per component
```bash
(cd backend && python -m pytest tests)  # backend (from backend/)
(cd web && npm ci && npm test && npm run lint)   # web: vitest + eslint
(cd collector-go && go test ./...)      # collector
(cd mempool-recorder && go test ./...)  # mempool recorder
```
Python tests need the component's `requirements.txt` plus `pytest`; Go tests need Go (or the `golang` image). Some tests use a real Postgres when `PG_TEST_*` is set and skip otherwise (see `.github/workflows/db.yml` for the setup). With nothing installed locally, run them in the compose containers:
```bash
docker compose exec web npm test
docker compose run --rm --no-deps -v "$PWD:/repo" -w /repo/backend --entrypoint sh backend \
  -c "pip install -q pytest && python -m pytest tests"
```

End-to-end scripts (need Docker; everything runs in throwaway containers):
```bash
db/test-migrations.sh                  # migrations up/down/up + role privileges
backend/test-stale-blocks-e2e.sh       # stale blocks: two regtest nodes, a fork and a reorg
backend/test-reorg-reconcile-e2e.sh    # best chain across reorgs: tracker off, backend down, 2 deep, full-history check
backend/test-block-gap-fill-e2e.sh     # historical gaps on a pruned node (-prune=550 -fastprune), filled via getblockfrompeer
mempool-recorder/test-e2e.sh           # regtest node + TimescaleDB + recorder image
```
Client performance: `npm run perf` against a running production build ([web/perf/README.md](web/perf/README.md)).

### CI (`.github/workflows/`)
| Workflow | Runs on | Checks |
|---|---|---|
| `images.yml` | PRs, `main`, releases | Builds multi-arch images (amd64 + arm64) of changed components; PRs push nothing, `main` pushes `bboerst/stratum-work-<component>:sha-<7>` and `:main`, releases push every component as `:<tag>` and `:latest` |
| `tests.yml` | Changes to `web/`, `collector-go/`, `backend/` | Web vitest, tsc and eslint; collector-go gofmt, vet and tests; backend pytest (Postgres-backed tests skip there; `db.yml` runs them) |
| `db.yml` | Changes to `db/`, `postgres/`, `collector-go/`, the backend's storage code | Migrations on the local and the production image, collector-go's sink and the backend store against a migrated database (as their roles), stale blocks e2e, best-chain reconciliation e2e, historical gap fill e2e |
| `mempool-recorder.yml` | Changes to `mempool-recorder/` or migrations | gofmt, go vet, go test, e2e |
| `perf.yml` | PRs touching `web/` | Measures the PR against its base with `web/perf` and posts the table as a PR comment |


## Contributing
Issues and pull requests are welcome. The essentials (longer form in [CLAUDE.md](CLAUDE.md)):
- **Defaults preserve existing behavior.** New settings are optional, documented in `.env.example`, and default to the previous behavior.
- **No machine-specific values** in the repo: hostnames, IPs, credentials, node URLs go in your gitignored `.env` or `docker-compose.override.yml`. Keep secrets out of command lines (env vars or files).
- **Database changes only through migrations** in `db/migrations/`, with a working `-- migrate:down`. Applications connect as least-privilege roles (`stratum_collector`, `stratum_backend`, `stratum_web`, `stratum_mempool`), never as the owner.
- **Bitcoin RPC over https** is verified with `BITCOIN_RPC_CA_FILE`; never disable verification.
- **The browser does the processing**: keep client CPU and memory low and check `npm run perf` for web changes.
- **Images are built by CI only** (`images.yml`); deployments pin `sha-<7>` tags and promote the same image from dev to prod.
- **Pull requests:** what was broken or missing, what changed, how it was tested (commands and results). Keep them focused. Squash merges are titled `Title (#N)`.

### Adding an analyzer
The backend runs analytics plug-ins for each processed block. They inspect the templates of the block's height and may emit small findings, stored on the block (`analysis`) and sent with the block event.

- Location: `backend/analytics/`: `prev_hash_divergence.py` (pools advertising different previous block hashes), `invalid_coinbase_no_merkle.py` (templates with no merkle branches whose coinbase pays more than the subsidy), `pool_identification.py` (pool identification and `PoolsManager`).
- Output: `analysis.flags[]`, each `{ key, icon, details }`, e.g. `{"key": "prev_hash_fork", "icon": "fork", "details": {"groups": [{"prev_hash": "…", "pools": ["PoolA", "PoolB"]}]}}`; and `analysis.pool_identification` = `{ mining_pool, method: "address|tag", addresses_considered }`.

1. Add a module, e.g. `backend/analytics/my_feature.py`, with a function returning a finding or `None`:
   ```python
   from typing import Any, Dict, List, Optional

   def analyze_my_feature(templates: List[Dict[str, Any]], logger) -> Optional[Dict[str, Any]]:
       if not interesting(templates):
           return None
       return {"key": "my_feature", "icon": "star", "details": {"…": "…"}}
   ```
2. Call it in `run_block_analyses(...)` in `backend/main.py`, which fetches the height's templates from the store (`store.templates_at_height(height)`):
   ```python
   finding = analyze_my_feature(templates, logger)
   if finding:
       flags.append(finding)
   ```
3. Add tests in `backend/tests/` and rebuild: `docker compose up -d --build backend`.

Guidelines: keep findings small (what the UI needs to render); keep the logic deterministic and scoped to the height's templates; with several collectors per pool the templates are every collector's rows (`site` / `replica` say which), so group by pool or pair exact copies per collector as `invalid_coinbase_no_merkle.py` does, rather than counting rows; use the shared logger and never log secrets.

## Further reading
- [Design: MongoDB → Postgres + TimescaleDB](docs/design/postgres-timescale.md): data access, schema, measurements, history migration, redundant collection.
- [How the data is measured](docs/methodology.md): what each value is, how it was taken, and its limits.
- Field docs in [`docs/`](docs/); component READMEs: [mempool-recorder](mempool-recorder/README.md), [web/perf](web/perf/README.md), Helm charts ([collector](helm-charts/stratum-work-collector/README.md), [backend](helm-charts/stratum-work-backend/README.md), [webapp](helm-charts/stratum-work-webapp/README.md)).
- [CLAUDE.md](CLAUDE.md): guidance for coding agents.

**License:** [MIT](LICENSE), © the stratum.work contributors.
