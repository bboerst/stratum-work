# stratum.work

[stratum.work](https://stratum.work) shows, in real time, the block templates Bitcoin mining pools hand out to their miners. Collectors connect to pools over the Stratum protocol like an ordinary miner, record every `mining.notify` message, and stream them to the browser, which decodes and visualizes them: what each pool is building on, what it pays out, which transactions it put first, and how quickly it switches to a new block. The idea comes from `0xB10C` ([original thread](https://primal.net/e/note1qckcs4y67eyaawad96j7mxevucgygsfwxg42cvlrs22mxptrg05qtv0jz3)); this project puts it in a form many people can use. A development deployment runs at [dev.stratum.work](https://dev.stratum.work).

**Contents:** [How it works](#how-it-works) · [Repository map](#repository-map) · [Quick start](#quick-start-docker-compose) · [Postgres mode](#postgres--timescaledb) · [Data analysis](#running-it-for-data-analysis) · [Testing and CI](#testing-and-ci) · [Contributing](#contributing) · [Further reading](#further-reading)

Coding agents: also read [CLAUDE.md](CLAUDE.md) (conventions, test commands and data gotchas in short form).

## How it works

### What is collected
| Data | Source | Written by |
|---|---|---|
| **Templates:** every `mining.notify` a pool sends (job id, previous block hash, the two coinbase halves, merkle branches, version, nBits, nTime, clean-jobs flag), with receive time and latency estimates | Mining pools, over Stratum | collector |
| **Blocks:** every Bitcoin block, the pool that mined it (coinbase tags and payout addresses, matched against [mempool/mining-pools](https://github.com/mempool/mining-pools)) and the analytics findings for its height | Bitcoin Core node (RPC + ZMQ) | backend |
| **Stale blocks and reorgs:** blocks on non-active branches the node knows about, and switches of the active chain (Postgres mode only) | Bitcoin Core node (`getchaintips`) | backend |
| **Mempool:** every transaction the node's mempool accepted, with first-seen time and how it left (mined, replaced, conflict, ...) (Postgres only) | Bitcoin Core node (ZMQ `sequence` + `rawtx`) | mempool-recorder |

### Architecture
```mermaid
flowchart LR
  pools[Mining pools] -- "Stratum mining.notify" --> collector
  node[Bitcoin Core node] -- "RPC + ZMQ" --> backend
  node -. "chain detection" .-> collector
  node -- "ZMQ sequence, rawtx" --> recorder[mempool-recorder]
  collector -- templates --> db[("Postgres + TimescaleDB<br/>(or MongoDB, legacy)")]
  collector -- "live templates" --> mq[RabbitMQ]
  backend -- "blocks, pools, analytics, stale blocks" --> db
  backend -- "block events" --> mq
  recorder -- "mempool tables" --> db
  db --> web["web (Next.js)"]
  mq --> web
  web -- "SSE /api/stream + JSON API" --> browser[Browser: decodes and draws]
```

- **collector** (`collector/`, Python): one process per pool. Publishes each template to RabbitMQ for the live view and stores it. It asks the node for the current tip to tell Bitcoin templates from other chains' (some pools mine other chains on the same endpoints). **collector-go** (`collector-go/`) is a Go port with the same flags that writes Postgres only and adds ingest hardening (line caps, quarantine of unstorable messages in `templates_rejected`, burst detection in `ingest_events`).
- **backend** (`backend/`, Python): follows the node (RPC + ZMQ `hashblock`), backfills blocks down to `MIN_BLOCK_HEIGHT`, identifies the pool of each block, runs the [analytics plug-ins](#adding-an-analyzer) over the templates of that height, tracks stale blocks, and publishes block events.
- **web** (`web/`, Next.js): serves the UI, the live stream (`/api/stream`, Server-Sent Events) and a read-only JSON API (`web/app/api/`).
- **mempool-recorder** (`mempool-recorder/`, Go): records the node's mempool so templates can be resolved against it (a template's `merkle_branches[0]` is the txid of its first transaction). See its [README](mempool-recorder/README.md).

**Storage.** The project is moving from MongoDB to **Postgres + TimescaleDB**, the store going forward ([design doc](docs/design/postgres-timescale.md)). Both are supported and each component is switched by configuration. The local `docker compose` stack still **defaults to MongoDB** (collectors write `mining_notify`, backend and web use MongoDB); Postgres is an opt-in profile, see [Postgres + TimescaleDB](#postgres--timescaledb). Stale-block tracking, the mempool recorder and collector-go exist only in Postgres mode.

### Trustless processing
The server collects and forwards the raw messages; **all decoding, formatting and visualization happens in the browser** (coinbase reconstruction, scriptSig tags, outputs and fees, the first transaction, merkle and timing views). So anyone can check what the site shows against what the pools sent, and the stream (`GET /api/stream`) can power other tools. The browser doing the work also means client performance matters: CI measures it on every web PR ([web/perf](web/perf/README.md)).

Where the decoding lives: `web/utils/bitcoinUtils.ts` (coinbase transaction, scriptSig ASCII and info, outputs and value, first transaction, OP_RETURN and AuxPoW data), `web/utils/formatters.ts` (coinbase assembly, prev-hash, nTime, nBits). The collector only stores what it received (`create_notification_document` in `collector/main.py`); the backend's block processing is `process_block` / `build_block_doc` in `backend/main.py`.

### The `mining.notify` message
A pool sends `mining.notify` whenever it has new work: on a new block (with clean-jobs set, so miners drop old work) and periodically as it refreshes the transaction set. Its fields, and how the UI derives its columns from them, are documented one per page in [`docs/`](docs/):
[prev_block_hash](docs/prev_block_hash.md), [coinbase_raw](docs/coinbase_raw.md) (coinbase1 + extranonce1 + extranonce2 + coinbase2), [height](docs/height.md) (BIP34, from the coinbase), [coinbase_script_ascii](docs/coinbase_script_ascii.md), [coinbase_output_value](docs/coinbase_output_value.md), [merkle_branches](docs/merkle_branches.md), [first_transaction](docs/first_transaction.md), [version](docs/version.md) / [block_version](docs/block_version.md), [nbits](docs/nbits.md), [ntime](docs/ntime.md), [clean_jobs](docs/clean_jobs.md), [pool_name](docs/pool_name.md), [timestamp](docs/timestamp.md), [latency_tracking](docs/latency_tracking.md).

## Repository map
| Path | What | Stack |
|---|---|---|
| [`collector/`](collector/) | Stratum client, one per pool: `mining.notify` to RabbitMQ and MongoDB (`mining_notify`) and/or Postgres (`collector/pgsink.py`), latency estimates, chain detection | Python |
| [`collector-go/`](collector-go/) | Go port of the collector: Postgres + RabbitMQ only, kernel receive timestamps, quarantine and burst records, `/livez` `/readyz` `/metrics`. Golden tests against the Python functions (`testdata/gen_golden.py`) | Go |
| [`backend/`](backend/) | Follows the node; `blocks`, `pools`, analytics (`backend/analytics/`), stale blocks (`stale_blocks.py`), storage layer for both databases (`integrations/store.py`) | Python |
| [`web/`](web/) | Next.js app: realtime table, template details, timing, Sankey, infra/latency views; API routes in `web/app/api/`, data layer in `web/lib/db/`, Prisma schema (MongoDB) in `web/prisma/`, perf harness in [`web/perf/`](web/perf/README.md) | TypeScript, Next.js 16 |
| [`mempool-recorder/`](mempool-recorder/README.md) | Records the node's mempool in Postgres | Go |
| [`db/`](db/) | Postgres schema as [dbmate](https://github.com/amacneil/dbmate) migrations (`db/migrations/`), local dev users (`dev-users.sql`), migration and SQL tests | SQL |
| [`postgres/`](postgres/) | CloudNativePG Postgres + TimescaleDB image used in production | Dockerfile |
| [`helm-charts/`](helm-charts/) | Charts for [collector](helm-charts/stratum-work-collector/README.md), [backend](helm-charts/stratum-work-backend/README.md) and [webapp](helm-charts/stratum-work-webapp/README.md) | Helm |
| [`tools/mongo-to-postgres/`](tools/mongo-to-postgres/README.md) | Backfill of MongoDB history into Postgres, with verification | Python |
| [`tools/replica-compare/`](tools/replica-compare/README.md) | Compares two collector replicas of a pool in Postgres (field equality, coinbase structure, candidate job keys) | Python |
| [`tools/site-compare/`](tools/site-compare/README.md) | Compares two deployed sites through their public API only | Python |
| [`docs/`](docs/) | Field documentation and [design docs](docs/design/postgres-timescale.md) | |
| [`scripts/`](scripts/) | One-off MongoDB helpers (dump/import templates by height) | Python |

## Quick start (docker compose)
`docker compose` runs the stack on one machine: RabbitMQ, MongoDB, five collectors connected to public pools, the backend and the web app. The web app runs in **development mode with hot reload**.

### Prerequisites
- [Docker Engine](https://docs.docker.com/engine/install/) with the [Compose plugin](https://docs.docker.com/compose/install/) (`docker compose`, v2).
- About 5 GB of disk for images, plus the data you collect.
- **Optional:** a Bitcoin Core node with RPC and ZMQ, see [Connecting a Bitcoin node](#connecting-a-bitcoin-node).

### Start
```bash
git clone https://github.com/bboerst/stratum-work.git
cd stratum-work
cp .env.example .env        # optional: Bitcoin node, remote access, Postgres switches
docker compose up --build   # add -d to run in the background
```
Open http://localhost:3000. Collectors connect to their pools straight away, and templates appear as pools send `mining.notify`. The first build takes a few minutes.

**Without a Bitcoin node** the live template table works, and so does everything the browser derives from templates. Blocks, pool identification, analytics and (in Postgres mode) stale blocks stay empty, and the backend logs RPC connection errors and keeps retrying. Collectors can't check template heights against the tip, so templates from other chains may not be told apart.

To run the optimized production build (no hot reload): `ENVIRONMENT=production docker compose up --build`.

### What runs
| Service | Host port | Notes |
|---|---|---|
| `web` | 3000 | Next.js, dev mode by default, `./web` mounted into the container |
| `backend` | 8001 (`BACKEND_PORT`) | Block processing and analytics; needs a node |
| `collector-*` | none | One per pool (`antpool`, `f2pool`, `poolin`, `secpool`, `256foundation`) |
| `rabbitmq` | 5672, 15672 | Management UI at http://localhost:15672 (`mquser` / `mqpassword`) |
| `mongodb` | 27017 | `mongo:7.0.24` (`mongouser` / `mongopassword`), database `stratum-logger` |
| `postgres` | 5432 (`POSTGRES_PORT`) | Only with `--profile postgres`, see [below](#postgres--timescaledb) |

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
| `POSTGRES_PORT` | `5432` | Host port of the Postgres profile |
| `COLLECTOR_PG_HOST` (+ `_USER`, `_PASSWORD`) | *(empty: off)* | Collectors also write to Postgres |
| `COLLECTOR_SITE` / `COLLECTOR_REPLICA` | `local` / `a` | Collector identity in `sources` |
| `BACKEND_DB_BACKEND` / `WEB_DB_BACKEND` | `mongodb` | `postgres` switches the backend / web to Postgres |
| `STREAM_POOL_RATE` / `STREAM_POOL_BURST` | `5` / `20` | Per-pool live display limit (every template is still stored) |
| `EXTRANONCE1_MASK_KEY` | *(random per start)* | Key for masking extranonce1 in everything the web serves |

### Connecting a Bitcoin node
The backend and the collectors share the node settings. The node needs:
- **RPC** reachable from the containers. A node on the Docker host is `host.docker.internal`; make sure `rpcallowip` allows the Docker network (e.g. `172.16.0.0/12`). Read-only RPC is enough.
- **ZMQ block notifications** on `BITCOIN_ZMQ_BLOCK`: the backend subscribes to `hashblock`, the collectors to `rawblock` + `hashblock`, so publish both on that address:
  ```
  zmqpubhashblock=tcp://0.0.0.0:28332
  zmqpubrawblock=tcp://0.0.0.0:28332
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
> **Warning:** `docker compose down -v` also deletes the named volumes, i.e. **all collected data** (`mongo-data` and `pg-data`). Don't use it (or `docker volume prune`) unless that's what you want. To reset only one store, remove just its volume, e.g. Postgres:
> `docker compose rm -sf postgres && docker volume rm stratum-work_pg-data` (volume names are `<project>_<volume>`; the project defaults to the directory name, check with `docker volume ls`).

### Adding a pool (local)
Each `collector-*` service connects to one pool and extends the shared `x-collector-base` template (environment, dependencies, restart policy). To add one locally, put a service in your `docker-compose.override.yml` (gitignored) and change only the pool flags:
```yaml
services:
  collector-newpool:
    extends: {file: docker-compose.yml, service: collector-f2pool}
    command: >
      /usr/local/bin/python main.py
      --pool-name "NewPool"
      --url "stratum+tcp://newpool.example.com:3333"
      --userpass "someuser.worker:x"
      --rabbitmq-host "rabbitmq" --rabbitmq-username "mquser" --rabbitmq-password "mqpassword"
      --db-url "mongodb" --db-name "stratum-logger" --db-username "mongouser" --db-password "mongopassword"
      --log-level "INFO"
```
`--pool-name` is the name shown in the UI and stored as the source. `python main.py --help` (in `collector/`) lists every flag; settings with an env fallback (`BITCOIN_*`, `PG_*`, `RABBITMQ_*`) are documented there. Use a pool's public endpoint and a username it accepts for anonymous or test mining; respect its terms.

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
  mongodb:
    ports: !override
      - "127.0.0.1:27017:27017"   # keep infrastructure on loopback
```

## Postgres + TimescaleDB
Postgres is opt-in through a Compose profile:
```bash
docker compose --profile postgres up --build
```
This adds three services:
- `postgres`: TimescaleDB 2.30 on Postgres 18 (`timescale/timescaledb:2.30.2-pg18`); owner `stratum` / `stratum`, database `stratum`.
- `postgres-migrate`: applies [`db/migrations`](db/migrations) with dbmate, then exits.
- `postgres-dev-users`: creates the local login users `collector`, `backend` and `web` (password = user name), each granted its least-privilege role (`stratum_collector`, `stratum_backend`, `stratum_web`), then exits.

Then switch components in `.env` and recreate them (`docker compose --profile postgres up -d`):
```bash
COLLECTOR_PG_HOST=postgres      # collectors write Postgres too (in addition to MongoDB)
BACKEND_DB_BACKEND=postgres     # blocks, pools, analytics reads, stale blocks
WEB_DB_BACKEND=postgres         # the web reads Postgres (as the read-only `web` user)
```
With all three, the backend and web run fully on Postgres. Collectors write Bitcoin templates to `templates` and everything else (other chains, unparseable or implausible heights) to `templates_other`. The web's API responses are the same as in MongoDB mode except for ids and µs-precision timestamps (see `web/lib/db/pg-mapping.ts`); `npm run parity` (`web/scripts/read-parity.ts`) checks that both backends return the same data when both have it.
```bash
# needs data in both (e.g. collectors writing to both); the network is <project>_default
docker run --rm --network stratum-work_default -v "$PWD/web:/app" -w /app \
  -e DATABASE_URL='mongodb://mongouser:mongopassword@mongodb:27017/stratum-logger?authSource=admin' \
  -e PG_HOST=postgres -e PG_USER=web -e PG_PASSWORD=web node:24-alpine \
  sh -c 'npm ci && npx prisma generate && npm run parity'   # optional: -- --heights 975500-975520
```

Connect with psql (the image has it, no local install needed):
```bash
docker compose exec postgres psql postgres://web:web@localhost/stratum   # read-only, what the web sees
docker compose exec postgres psql -U stratum stratum                     # owner (local only)
psql postgres://web:web@localhost:5432/stratum                           # from the host, with a local psql
```

**Stale blocks** (backend in Postgres mode): on every new block and every `STALE_POLL_INTERVAL_S` (60) seconds the backend calls `getchaintips`, walks each non-active branch to the fork point and stores its blocks in `stale_blocks` (header always; coinbase, size and pool when the node has the full block); reorgs of the active chain go to `chain_reorgs`. `STALE_BLOCKS_ENABLED=false` turns it off. RPC methods used: `getchaintips`, `getblockheader`, `getblock`, `getblockhash`.

**Migrations:** `docker run --rm -v "$PWD/db:/db" ghcr.io/amacneil/dbmate:2.37.0 new <name>`, then fill `-- migrate:up` and a working `-- migrate:down`. TimescaleDB procedures such as `add_columnstore_policy` need `-- migrate:up transaction:false`. `db/test-migrations.sh` runs them up/down/up and checks the role privileges.

**Not in compose:** collector-go and the mempool recorder. Run them from their directories (`go run . -h` lists flags and env fallbacks) against the profile's Postgres; the recorder logs in as the local user `mempool` / `mempool` (`db/dev-users.sql`, role `stratum_mempool`) and needs a node with `-zmqpubsequence` / `-zmqpubrawtx` ([README](mempool-recorder/README.md)).

## Running it for data analysis

### Getting data
- **Collect your own.** Start the Postgres profile with the three switches above and a node, set `MIN_BLOCK_HEIGHT` near the tip, and let a few collectors run: `docker compose --profile postgres up -d --build web backend collector-f2pool collector-antpool`. A few hours give dozens of heights; every height has a few hundred templates per pool. Without a node you still get templates (but no blocks).
- **From the public site.** The web's JSON API is read-only and public (below). [`tools/site-compare`](tools/site-compare/README.md) shows how to fetch it politely (rate limit, retries, cache).
- **From your local MongoDB history.** [`tools/mongo-to-postgres`](tools/mongo-to-postgres/README.md) copies `mining_notify`, `blocks` and `pools` into the Postgres schema and verifies the copy.

### The schema in one table
All in [`db/migrations`](db/migrations); the [design doc](docs/design/postgres-timescale.md) explains the choices. Hashes and hex fields are `bytea`; `encode(x, 'hex')` shows them.

| Object | What |
|---|---|
| `sources` | One row per collector connection: `name` (the pool), `site`, `replica` |
| `templates` | Bitcoin templates, one row per `mining.notify` (hypertable on `received_at`, indexed on `(height, source_id, received_at)`). `prev_hash` is in Stratum's word order |
| `templates_other` | Everything not routed to `templates`, with `chain` (`btc`/`bch`/`unknown`) and `reason` |
| `templates_dedup` / `templates_copies` | One stream per pool when a pool is collected over several connections: `templates_dedup` is what reads show, `templates_copies` classifies every row (`primary`, `copy`, `secondary_stream`, `gap_fill`). With one collector per pool, `templates_dedup` = the raw rows. Also `templates_other_dedup` / `_copies` |
| `template_dedup_report(from_ts, to_ts)` | What the de-duplication did, per UTC day, pool and site |
| `blocks`, `blocks_best` | Every block stored (keyed by hash, so stale and best blocks coexist); `blocks_best` hides the currently stale ones. `block_hash` is in display (explorer) order. `mining_pool` and `analysis` are jsonb |
| `pools` | Pool definitions from mempool/mining-pools |
| `stale_blocks`, `chain_reorgs` | Stale blocks and reorgs the node saw |
| `stale_tip_templates(from_height, to_height)` | Templates built on a tip other than the best block at height − 1 (`tip` = `stale` or `unknown`), per height, pool and prev hash, with how long the pool kept mining on it |
| `mempool_txs`, `mempool_tx_inputs`, `mempool_blocks`, `mempool_offmempool`, `mempool_tx_raw` | Mempool recorder tables ([details](mempool-recorder/README.md)); hashes in internal byte order |
| `templates_rejected`, `ingest_events` | collector-go only: messages it couldn't store, and bursts / dropped templates |
| `hash_display(bytea)`, `hash_from_display(text)`, `stratum_prev_hash_to_block_hash(bytea)` | Byte-order helpers: internal ↔ display hex, and Stratum `prev_hash` → block hash |

**Gotchas.** Always filter template reads on `height` (or a height range): the views and functions push it down to the index, and without it they read the whole table. Take the Bitcoin tip from `blocks_best`, never from `max(height)` of templates (other chains land in `templates_other`, but in MongoDB `mining_notify` mixes them in). Templates at height `h` are work for the block after `h − 1`. With several collectors per pool, count from `templates_dedup`, or group raw rows by pool: one row per collector is not one template.

### Example queries
```sql
-- The tip
SELECT max(height) AS tip FROM blocks_best;

-- Recent blocks and who mined them
SELECT height, encode(block_hash, 'hex') AS hash, block_time, mining_pool->>'name' AS pool, analysis->'flags' AS flags
  FROM blocks_best ORDER BY height DESC LIMIT 10;

-- Per pool at one height: templates, first template time, how many distinct first transactions
SELECT pool, count(*) AS templates, min(first_seen) AS first_seen,
       count(DISTINCT substring(merkle_branches FROM 1 FOR 32)) AS first_txs
  FROM templates_dedup WHERE height = 925000
 GROUP BY pool ORDER BY first_seen;

-- Which pools built on which previous block at a height (a fork shows up as two prev hashes)
SELECT encode(stratum_prev_hash_to_block_hash(prev_hash), 'hex') AS prev_block, array_agg(DISTINCT pool) AS pools
  FROM templates_dedup WHERE height = 925000 GROUP BY 1;

-- Each pool's first transaction of its latest template at a height, as an explorer txid
SELECT DISTINCT ON (pool) pool, hash_display(substring(merkle_branches FROM 1 FOR 32)) AS first_txid
  FROM templates_dedup WHERE height = 925000 AND length(merkle_branches) >= 32
 ORDER BY pool, received_at DESC;

-- ... joined to the mempool recorder: when the node first saw it, and its fee rate
SELECT t.pool, hash_display(m.txid) AS txid, m.first_seen, m.fee::numeric / m.vsize AS sat_per_vb
  FROM templates_dedup t
  JOIN mempool_txs m ON m.txid = substring(t.merkle_branches FROM 1 FOR 32)
 WHERE t.height = 925000;

-- Templates that weren't Bitcoin's, by chain and reason (last day)
SELECT s.name AS pool, o.chain, o.reason, count(*)
  FROM templates_other o JOIN sources s ON s.id = o.source_id
 WHERE o.received_at > now() - interval '1 day' GROUP BY 1, 2, 3;

-- Pools that kept mining on a stale or unknown tip in the last 100 heights
SELECT height, pool, tip, templates, mined_after_switch
  FROM stale_tip_templates((SELECT max(height) - 100 FROM blocks_best), (SELECT max(height) + 1 FROM blocks_best));

-- What the de-duplication did over the last day (one collector per pool: every row is primary)
SELECT day, pool, site, rows, secondary_hidden, gap_fills FROM template_dedup_report(now() - interval '1 day', now());
```

### Tools
- [`tools/replica-compare`](tools/replica-compare/README.md): two collectors of the same pool, field by field (what identifies "the same job" across connections). Reads Postgres; any role with `SELECT` works.
- [`tools/site-compare`](tools/site-compare/README.md): two deployed sites through their public API only, height by height. Gentle by default (2 requests/s, retries honoring `Retry-After`, a response cache). Keep reports of real sites out of the repository.
- [`tools/mongo-to-postgres`](tools/mongo-to-postgres/README.md): backfill and verification.

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
| `GET /api/stale-blocks?n=20` | Recent stale blocks with the pools that built on them (Postgres deployments) |
| `GET /api/realtime-prefill` | The tip and the current templates the realtime views start from |

## Testing and CI

### Tests per component
```bash
python -m pytest collector/tests        # collector (from the repo root)
(cd backend && python -m pytest tests)  # backend (from backend/)
(cd web && npm ci && npm test && npm run lint)   # web: vitest + eslint
(cd collector-go && go test ./...)      # Go collector
(cd mempool-recorder && go test ./...)  # mempool recorder
```
Python tests need the component's `requirements.txt` plus `pytest`; Go tests need Go (or the `golang` image). Some tests use a real Postgres when `PG_TEST_*` is set and skip otherwise (see `.github/workflows/db.yml` for the setup). With nothing installed locally, run them in the compose containers:
```bash
docker compose exec web npm test
docker compose run --rm --no-deps -v "$PWD:/repo" -w /repo --entrypoint sh collector-antpool \
  -c "pip install -q pytest && python -m pytest collector/tests"
docker compose run --rm --no-deps -v "$PWD:/repo" -w /repo/backend --entrypoint sh backend \
  -c "pip install -q pytest && python -m pytest tests"
```

End-to-end scripts (need Docker; everything runs in throwaway containers):
```bash
db/test-migrations.sh                  # migrations up/down/up + role privileges
backend/test-stale-blocks-e2e.sh       # stale blocks: two regtest nodes, a fork and a reorg, backend in Postgres mode
mempool-recorder/test-e2e.sh           # regtest node + TimescaleDB + recorder image
tools/mongo-to-postgres/test-e2e.sh    # backfill: unit tests + synthetic fixture
tools/replica-compare/test-e2e.sh      # unit tests + synthetic fixture
tools/site-compare/test-e2e.sh         # unit tests + two fake sites over HTTP
```
Client performance: `npm run perf` against a running production build ([web/perf/README.md](web/perf/README.md)).

### CI (`.github/workflows/`)
| Workflow | Runs on | Checks |
|---|---|---|
| `images.yml` | PRs, `main`, releases | Builds multi-arch images (amd64 + arm64) of changed components; PRs push nothing, `main` pushes `bboerst/stratum-work-<component>:sha-<7>` and `:main`, releases push every component as `:<tag>` and `:latest` |
| `db.yml` | Changes to `db/`, `postgres/`, the Postgres code paths | Migrations on the local and the production image, collector sink and backend store against a migrated database (as their roles), backfill tool e2e, stale blocks e2e |
| `mempool-recorder.yml` | Changes to `mempool-recorder/` or migrations | gofmt, go vet, go test, e2e |
| `perf.yml` | PRs touching `web/` | Measures the PR against its base with `web/perf` and posts the table as a PR comment |

CI doesn't yet run the web unit tests and lint, the collector's tests or collector-go's: run them locally before a PR.

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
2. Call it in `run_block_analyses(...)` in `backend/main.py`, which fetches the height's templates from the configured store (`store.templates_at_height(height)`, MongoDB or Postgres):
   ```python
   finding = analyze_my_feature(templates, logger)
   if finding:
       flags.append(finding)
   ```
3. Add tests in `backend/tests/` and rebuild: `docker compose up -d --build backend`.

Guidelines: keep findings small (what the UI needs to render); keep the logic deterministic and scoped to the height's templates; with several collectors per pool the templates are every collector's rows (`site` / `replica` say which), so group by pool or pair exact copies per collector as `invalid_coinbase_no_merkle.py` does, rather than counting rows; use the shared logger and never log secrets.

## Further reading
- [Design: MongoDB → Postgres + TimescaleDB](docs/design/postgres-timescale.md): data access, schema, measurements, backups, migration plan, redundant collection.
- Field docs in [`docs/`](docs/); component READMEs: [mempool-recorder](mempool-recorder/README.md), [web/perf](web/perf/README.md), [mongo-to-postgres](tools/mongo-to-postgres/README.md), [replica-compare](tools/replica-compare/README.md), [site-compare](tools/site-compare/README.md), Helm charts ([collector](helm-charts/stratum-work-collector/README.md), [backend](helm-charts/stratum-work-backend/README.md), [webapp](helm-charts/stratum-work-webapp/README.md)).
- [CLAUDE.md](CLAUDE.md): guidance for coding agents.

**License:** the repository has no license file yet.
