# CLAUDE.md

Guidance for AI coding agents (and humans) working in this repo. Start with the [README](README.md) for architecture, local setup, Postgres mode, data analysis (schema, example SQL, public API) and CI.

## Components
| Path | What | Stack |
|---|---|---|
| `collector/` | Connects to one pool over Stratum. Publishes each `mining.notify` to RabbitMQ and MongoDB (`mining_notify`), optionally also Postgres (`pgsink.py`: every template into `templates`), with latency estimates and, for MongoDB, BTC/BCH chain detection (`chain_family`). | Python |
| `collector-go/` | Go port of the collector (#148): one process per pool, Postgres + RabbitMQ (no MongoDB), kernel receive timestamps, `/livez` `/readyz` `/metrics`. Same flags (the node and chain-detection ones are accepted and ignored: every template goes to `templates`, classified at read time, [design](docs/design/one-templates-table.md)); passwords from env only. Golden tests against the Python functions (`testdata/gen_golden.py`). | Go |
| `mempool-recorder/` | Follows the Bitcoin node's mempool over ZMQ (`sequence` + `rawtx`) and records every transaction with first-seen time and how it left (mined, replaced, conflict, reorg, expired, evicted) in `mempool_txs`; blocks and off-mempool block transactions too (#180). Race-free sync and resync, `/livez` `/readyz` `/metrics`. ([README](mempool-recorder/README.md)) | Go |
| `backend/` | Follows the Bitcoin node (RPC + ZMQ `hashblock`). Writes `blocks`, runs analytics plug-ins (`backend/analytics/`, see [README "Adding an analyzer"](README.md#adding-an-analyzer)), publishes block events. | Python |
| `web/` | Next.js app: realtime table, template details, timing, Sankey, infra/latency views, other chains (read-time judgement over 90 days). API routes in `web/app/api/`. Prisma schema in `web/prisma/`. | TypeScript, Next.js 16 |
| `helm-charts/` | Charts for collector, backend, and webapp | Helm |
| `db/` | Postgres schema as [dbmate](https://github.com/amacneil/dbmate) migrations (`db/migrations/`), local dev users, migration test | SQL |
| `postgres/` | CloudNativePG Postgres + TimescaleDB image for production | Dockerfile |
| `tools/site-compare/` | Compares two deployed sites through their public API only (blocks, templates by job key, first seen, pools), for checking a new stack before switching to it ([README](tools/site-compare/README.md)) | Python |

## Run it
```bash
cp .env.example .env          # optional: Bitcoin node, remote-access settings
docker compose up --build     # dev mode: web hot-reloads from ./web
```
- Rebuild a Python service after changes: `docker compose up -d --build backend` (or `collector-<pool>`).
- Machine-specific compose tweaks go in a gitignored `docker-compose.override.yml`, not in `docker-compose.yml`.
- Postgres: `docker compose --profile postgres up --build`, then `COLLECTOR_PG_HOST=postgres`, `BACKEND_DB_BACKEND=postgres`, `WEB_DB_BACKEND=postgres` in `.env` ([README](README.md#postgres--timescaledb)). MongoDB is still the compose default.
- **Never `docker compose down -v`** on a stack with data you want: it deletes the `mongo-data` and `pg-data` volumes.

## Test
```bash
python -m pytest collector/tests        # from the repo root
(cd collector-go && go test ./...)      # Go collector (no local Go? run it in the golang image)
(cd mempool-recorder && go test ./...)  # mempool recorder: parsing vectors, sequence state machine, pipeline
mempool-recorder/test-e2e.sh            # mempool recorder end to end: regtest node + TimescaleDB + recorder image (Docker)
(cd backend && python -m pytest tests)  # from backend/
(cd web && npm test && npm run lint)    # vitest + eslint
(cd web && npm run perf)               # client performance against a running build (web/perf/README.md); CI runs it on every web PR
db/test-migrations.sh                   # migrations up/down/up + role privileges (Docker)
backend/test-stale-blocks-e2e.sh        # stale blocks: two regtest nodes, fork + reorg, backend in Postgres mode (Docker)
backend/test-reorg-reconcile-e2e.sh     # best chain across reorgs: tracker off, backend down, 2 deep, MongoDB mode, full-history check (Docker)
backend/test-block-gap-fill-e2e.sh      # historical gaps on a pruned node, filled via getblockfrompeer (Docker)
tools/site-compare/test-e2e.sh          # site comparison: unit tests + two synthetic fake sites over HTTP (Docker)
```
[README "Testing and CI"](README.md#testing-and-ci) shows how to run them inside the containers and what CI checks.

## Conventions
- **Defaults preserve existing behavior.** New settings are optional, documented in `.env.example`, and default to the previous value. Never commit machine-specific values (hostnames, IPs, credentials, node URLs).
- **Collector and backend config:** CLI flags win; env vars (`BITCOIN_*`, etc.) provide defaults. Keep secrets out of command lines.
- **Bitcoin RPC** may be `http` or `https` (`BITCOIN_RPC_SCHEME`). For private CAs, verify with `BITCOIN_RPC_CA_FILE`; never disable verification.
- **Database changes go through migrations** in `db/migrations/` (never hand-applied), with a working `-- migrate:down`. Applications connect as least-privilege roles (`stratum_collector`, `stratum_backend`, `stratum_web`, `stratum_mempool`), never as the owner or superuser.
- **PRs:** say what was broken or missing, what changed, and how it was tested (commands and results). Keep them focused. Squash merges are titled `Title (#N)`. Preserve contributor credit with `Co-authored-by:` trailers.

## Data gotchas
- **Not every template is a Bitcoin template.** Some pools mine other chains on the same endpoints, so a template's height can be far from Bitcoin's (e.g. 6,976,415). Take the Bitcoin tip from `blocks` (written from bitcoind), not from `max(height)` of templates. In Postgres every template is in `templates`: judge at read time (`bitcoin_parents` for the chain, `height_window()` for a height's receive window; [design doc](docs/design/one-templates-table.md)). In MongoDB, filter on `chain_family` (see #72, #79, #98).
- **`mining_notify` is large and append-only:** about 136M documents in production. It's indexed on `_id` (UUID string, not time-ordered) and `height`. Range queries should go through `height`. `timestamp` is a hex-nanosecond string and isn't indexed.
- Templates for height `h` are the work for the block *after* tip `h-1`.

## Images and deployment
`.github/workflows/images.yml` builds multi-arch (amd64 + arm64) images for `web`, `backend`, `collector`, `collector-go`, `mempool-recorder` and `postgres`:
- **PRs:** build the changed components, push nothing.
- **Merge to `main`:** push `bboerst/stratum-work-<component>:sha-<7>` (and `:main`) for each changed component (`web`, `backend`, `collector`, `collector-go`, `mempool-recorder`, `postgres`).
- **Releases:** push all components as `:<tag>` and `:latest`.

Deployments pin `sha-<7>` tags, and the same image is promoted from dev to prod, never rebuilt. Production deployment is managed in a separate repository. Never build or push images by hand.
