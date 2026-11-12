# Stratum Work

Stratum Work is a web application that provides real-time visualizations of mining work notifications from Stratum mining pools. It allows users to monitor and analyze the mining activity of various pools in a user-friendly interface. All credit for this idea goes to `0xB10C` and his thread here: https://primal.net/e/note1qckcs4y67eyaawad96j7mxevucgygsfwxg42cvlrs22mxptrg05qtv0jz3. I'm merely copying his idea and putting it into a form where many people can access this data.

## Architecture Overview

Stratum Work consists of three main components:

1. **Collector**: Connects to Bitcoin mining pools via the Stratum protocol, captures `mining.notify` messages, and forwards them to RabbitMQ.
2. **Backend**: Processes Bitcoin blocks, identifies mining pools, and provides block data to the web application.
3. **Web Application**: Displays real-time mining notifications and block information in an interactive interface.

### Data Flow

1. Multiple collector instances connect to different mining pools
2. When a pool sends a `mining.notify` message, the collector:
   - Stores the message in MongoDB
   - Publishes the message to RabbitMQ
3. The web application consumes these messages from RabbitMQ and displays them in real-time
4. The backend processes new blocks from a Bitcoin node and identifies which pool mined each block

## Technical Details

### Stratum Protocol and Mining.Notify Messages

The Stratum protocol is used by mining pools to coordinate miners. The `mining.notify` message is particularly important as it contains the template for a new block that miners should work on. Each message contains:

- **Job ID**: A unique identifier for this mining job
- **Previous Block Hash**: The hash of the last block in the chain
- **Coinbase (Part 1 & 2)**: The coinbase transaction split into two parts
- **Merkle Branches**: Hashes needed to construct the merkle root
- **Version**: Block version
- **nBits**: Target difficulty
- **nTime**: Current timestamp
- **Clean Jobs**: Boolean indicating if previous jobs should be discarded

### Trustless Data Processing

A key design principle of Stratum Work is **trustless data processing**. While the server collects and streams the raw data, **all decoding, formatting, and visualization is performed in the client browser**.

### Raw Data

The application provides a Server-Sent Events (SSE) endpoint:

```
GET /api/stream
```

This endpoint delivers the same real-time data that powers the web interface, allowing for custom integrations or alternative visualizations.

### Data Processing and Visualization

#### Collector Processing

The collector performs minimal processing to maintain data integrity:

See [collector/main.py:294-323](collector/main.py#L294-L323) for the notification document creation function.

#### Web Application Processing

The web application performs extensive processing to make the data more readable and visually informative:

1. **Coinbase Transaction Reconstruction**:  
   See [web/utils/formatters.ts:38-45](web/utils/formatters.ts#L41-L48)

2. **Coinbase Script ASCII Extraction**:  
   See [web/utils/bitcoinUtils.ts:48-76](web/utils/bitcoinUtils.ts#L53-L83)

3. **Coinbase Output Analysis**:  
   See [web/utils/bitcoinUtils.ts:95-126](web/utils/bitcoinUtils.ts#L122-L159)

4. **First Transaction Extraction**:  
   See [web/utils/bitcoinUtils.ts:129-139](web/utils/bitcoinUtils.ts#L108-L120)

5. **Fee Rate Calculation**:  
   See [web/utils/bitcoinUtils.ts:142-168](web/utils/bitcoinUtils.ts#L161-L191)

### Backend Block Processing

The backend identifies which pool mined each block by analyzing the coinbase transaction:

See [backend/main.py:815-890](backend/main.py#L814-L913) for the block processing function.

### Backend Analytics Plug‑ins

The backend supports a pluggable analytics system that runs whenever a new block is processed. These analytics inspect the set of `mining.notify` templates for the block’s height and may emit structured findings that get saved on the block document and forwarded to RabbitMQ.

- Location: `backend/analytics/`
  - `prev_hash_divergence.py` – detects pools advertising different previous block hashes
  - `invalid_coinbase_no_merkle.py` – flags templates with no merkle branches where the coinbase output exceeds the block subsidy
  - `pool_identification.py` – owns pool identification and the `PoolsManager`

- Output shape (stored on `db.blocks` and in the SSE payload):
  - `analysis.flags[]`: list of small findings with compact metadata
    - Each item: `{ key: string, icon: string, details: {...} }`
    - Example (prev-hash fork):
      ```json
      {
        "key": "prev_hash_fork",
        "icon": "fork",
        "details": {
          "groups": [
            { "prev_hash": "…", "pools": ["PoolA", "PoolB"] }
          ]
        }
      }
      ```
  - `analysis.pool_identification`: richer object for the winning pool
    - `{ mining_pool: {...}, method: "address|tag", addresses_considered: [] }`

#### Adding a New Analyzer

1. Create a new module in `backend/analytics/`, e.g. `my_new_analysis.py`, and export a function that returns either a finding dict or `None`:
   ```python
   from typing import Any, Dict, List, Optional

   def analyze_my_feature(templates: List[Dict[str, Any]], logger) -> Optional[Dict[str, Any]]:
       # inspect templates …
       if not interesting:
           return None
       return {
           "key": "my_feature",
           "icon": "star",
           "details": { "…": "…" }
       }
   ```

2. Import and append it in `backend/main.py` inside `run_block_analyses(...)` (the function already collects and passes the MongoDB `mining_notify` records for the block height):
   ```python
   from analytics.my_new_analysis import analyze_my_feature

   …
   finding = analyze_my_feature(templates, logger)
   if finding:
       flags.append(finding)
   ```

3. Rebuild the backend image so the new module is included (the Dockerfile copies `backend/analytics/`).

Guidelines:
- Keep findings small (store details needed to render UI, avoid large payloads).
- Prefer deterministic, height-scoped logic using the templates fetched for that block height.
- Use the shared logger for traceability; avoid printing secrets.

## Features

- Real-time display of `mining.notify` messages from Stratum pools
- Customizable table columns for displaying relevant data
- Light and dark mode
- Live and historical data views
- MongoDB integration for data storage and retrieval
- Most 'work' is done client-side for trustless data processing
- Raw data access via `/api/stream` endpoint

## Local Development with Docker Compose

`docker compose` runs the whole stack on one machine: RabbitMQ, MongoDB, five collectors connected to live pools, the backend, and the web app. By default the web app runs in **development mode with hot reload**, so edits under `web/` show up in the browser without a rebuild.

### Prerequisites

- [Docker Engine](https://docs.docker.com/engine/install/) with the [Compose plugin](https://docs.docker.com/compose/install/) (`docker compose`, not the old `docker-compose`)
- **Optional:** a Bitcoin Core node with RPC and ZMQ enabled. Without one, collectors still stream live templates, but block detection, pool identification and analytics stay empty. See [Connecting a Bitcoin node](#connecting-a-bitcoin-node).

### Quick start

```bash
git clone https://github.com/bboerst/stratum-work.git
cd stratum-work
cp .env.example .env        # optional settings: Bitcoin node, remote access, ...
docker compose up --build
```

Open http://localhost:3000. Collectors connect to their pools straight away, and new templates appear as pools send `mining.notify` messages.

To run the optimized production build (no hot reload):

```bash
ENVIRONMENT=production docker compose up --build
```

### What runs

| Service | Port | Notes |
|---|---|---|
| `web` | 3000 | Next.js app. Dev mode by default, with `./web` mounted into the container |
| `backend` | 8001 | Block processing and analytics. Needs a Bitcoin node |
| `collector-*` | none | One per pool: connects over Stratum and publishes `mining.notify` to RabbitMQ and MongoDB |
| `rabbitmq` | 5672, 15672 | Management UI at http://localhost:15672 (`mquser` / `mqpassword`) |
| `mongodb` | 27017 | `mongo:7.0.24`, the same version as production (`mongouser` / `mongopassword`) |

The credentials above are local development defaults. Don't expose these ports to an untrusted network. To change bindings, see [Machine-specific overrides](#machine-specific-overrides).

### Configuration (`.env`)

`docker compose` reads `./.env` automatically. It's gitignored, so credentials and machine-specific values stay out of the repo. Every setting is optional, and the defaults match the values in `docker-compose.yml`. `.env.example` documents each one.

| Setting | Default | Purpose |
|---|---|---|
| `CORS_ORIGINS` | `http://localhost:3000` | Origin(s) your browser uses to open the web app (comma-separated) |
| `ALLOWED_DEV_ORIGINS` | *(empty)* | Hostnames allowed to use dev-only resources, such as hot reload, when you browse from another machine |
| `BITCOIN_RPC_HOST` / `BITCOIN_RPC_PORT` | `host.docker.internal` / `8332` | Bitcoin node RPC endpoint |
| `BITCOIN_RPC_USER` / `BITCOIN_RPC_PASSWORD` | `rpc_user` / `rpc_password` | RPC credentials |
| `BITCOIN_RPC_SCHEME` | `http` | Set to `https` for nodes behind a TLS proxy |
| `BITCOIN_RPC_CA_FILE` | *(empty)* | Host path to a CA certificate (PEM) used to verify an `https` node |
| `BITCOIN_ZMQ_BLOCK` | `tcp://host.docker.internal:28332` | ZMQ block notifications |
| `MIN_BLOCK_HEIGHT` | `863998` | Lowest height the backend backfills on first start |

### Connecting a Bitcoin node

The backend and the collectors share the node settings above. The node needs:

- **RPC** reachable from the containers. If the node runs on the Docker host, `host.docker.internal` already points at it. Make sure `rpcallowip` allows the Docker network (e.g. `172.16.0.0/12`).
- **ZMQ block notifications** on `BITCOIN_ZMQ_BLOCK`. The backend subscribes to `hashblock` and the collectors to `rawblock` + `hashblock`, so publish both on that address:
  ```
  zmqpubhashblock=tcp://0.0.0.0:28332
  zmqpubrawblock=tcp://0.0.0.0:28332
  ```

**Nodes behind a TLS proxy** (e.g. StartOS, or a reverse proxy in front of RPC) serve RPC over `https`, often with a private CA. Point the stack at that CA rather than turning off verification:

```bash
BITCOIN_RPC_SCHEME=https
BITCOIN_RPC_CA_FILE=/path/to/root-ca.pem   # on the Docker host; mounted read-only into the containers
```

**First start:** the backend backfills every block from the tip down to `MIN_BLOCK_HEIGHT`. That's over 100k blocks with the default. For a quick local start, set it a few dozen blocks below the current tip. There are no templates for blocks mined before your collectors were running anyway.

### Developing

- **Web:** edit files under `web/` and the browser updates automatically.
- **Backend and collectors:** their code is built into the image, so rebuild the service you changed:
  ```bash
  docker compose up -d --build backend
  docker compose up -d --build collector-f2pool
  ```
- **Logs:**
  ```bash
  docker compose logs -f web backend
  docker compose logs -f collector-antpool
  ```
- **Tests:** with each component's `requirements.txt` (plus `pytest`) or `npm ci` installed locally:
  ```bash
  python -m pytest collector/tests       # collector: run from the repo root
  (cd backend && python -m pytest tests) # backend: run from backend/
  (cd web && npm test)                   # web: vitest
  ```
  Or run them inside the containers, with nothing installed locally:
  ```bash
  docker compose exec web npm test
  docker compose run --rm --no-deps -v "$PWD:/repo" -w /repo --entrypoint sh collector-antpool \
    -c "pip install -q pytest && python -m pytest collector/tests"
  docker compose run --rm --no-deps -v "$PWD:/repo" -w /repo/backend --entrypoint sh backend \
    -c "pip install -q pytest && python -m pytest tests"
  ```

### Customizing collectors

Each `collector-*` service in `docker-compose.yml` connects to one pool. They all extend the shared `x-collector-base` template, which holds the common environment variables, dependencies and restart policy. To add a pool, copy an existing collector and change only the pool-specific flags:

```yaml
collector-newpool:
  <<: *collector-base
  command: >
    /usr/local/bin/python main.py
    --pool-name "NewPool"
    --url "stratum+tcp://newpool.example.com:3333"
    --userpass "someuser:somepass"
    --rabbitmq-host "rabbitmq"
    --rabbitmq-username "mquser"
    --rabbitmq-password "mqpassword"
    --db-url "mongodb"
    --db-name "stratum-logger"
    --db-username "mongouser"
    --db-password "mongopassword"
    --log-level "DEBUG"
```

To run fewer collectors, start only the services you want, e.g. `docker compose up --build web backend collector-f2pool`.

### Running on a remote machine

If the stack runs on another machine (a VM, a home server, a box on your Tailscale network), use its hostname instead of `localhost`:

```bash
# .env
CORS_ORIGINS=http://my-devbox:3000
ALLOWED_DEV_ORIGINS=my-devbox            # without this, Next.js blocks hot reload from non-localhost hosts
```

Then open `http://my-devbox:3000`.

### Machine-specific overrides

For compose changes that only apply to your machine, such as binding ports to loopback or to a specific interface, create a `docker-compose.override.yml`. It's gitignored, and `docker compose` loads it automatically. `!override` replaces a list instead of appending to it:

```yaml
services:
  web:
    ports: !override
      - "100.64.0.10:3000:3000"   # e.g. only on a Tailscale address
  mongodb:
    ports: !override
      - "127.0.0.1:27017:27017"   # keep infrastructure on loopback
```

### Postgres + TimescaleDB (migration in progress)

The project is moving from MongoDB to Postgres + TimescaleDB (#90; design: [`docs/design/postgres-timescale.md`](docs/design/postgres-timescale.md)). MongoDB stays the default until the cutover. Postgres is opt-in through a Compose profile:

```bash
docker compose --profile postgres up --build
```

This adds:
- `postgres`: TimescaleDB 2.30 on Postgres 18, on `${POSTGRES_PORT:-5432}`; user, password and database are all `stratum`
- `postgres-migrate`: applies `db/migrations` with [dbmate](https://github.com/amacneil/dbmate), then exits
- `postgres-dev-users`: creates local per-service login users (`collector`, `backend`, `web`; password = user name), each granted its least-privilege role

```bash
psql postgres://web:web@localhost:5432/stratum -c '\dt'   # read-only user
db/test-migrations.sh                                       # migrations up/down/up + role privileges (needs Docker)
```

Add a migration: `docker run --rm -v "$PWD/db:/db" ghcr.io/amacneil/dbmate:2.37.0 new <name>`, then edit the `-- migrate:up` / `-- migrate:down` sections. Use `-- migrate:up transaction:false` for TimescaleDB procedures such as `add_columnstore_policy`.

To reset only the Postgres data (MongoDB is untouched): `docker compose rm -sf postgres && docker volume rm stratum-work_pg-data`.

### Stopping

```bash
docker compose down        # stop and remove containers
docker compose down -v     # also delete the MongoDB volume (all collected data)
```
