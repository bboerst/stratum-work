# CLAUDE.md

Guidance for AI coding agents (and humans) working in this repo. Use the words in [docs/glossary.md](docs/glossary.md). Start with the [README](README.md) for architecture, local setup, Postgres, data analysis (schema, example SQL, public API) and CI.

## Components
| Path | What | Stack |
|---|---|---|
| `collector-go/` | The collector (#148): connects to one pool over Stratum, one process per pool. Writes each `mining.notify` to Postgres (`templates`) and RabbitMQ, with latency estimates and kernel receive timestamps; `/livez` `/readyz` `/metrics`. The node and chain-detection flags are accepted and ignored (every template goes to `templates`, classified at read time, [design](docs/design/one-templates-table.md)); passwords from env only. Golden test against a frozen fixture from the removed Python collector (`testdata/golden.json`). | Go |
| `mempool-recorder/` | Follows the Bitcoin node's mempool over ZMQ (`sequence` + `rawtx`) and records every transaction with first-seen time and how it left (mined, replaced, conflict, reorg, expired, evicted) in `mempool_txs`; blocks and off-mempool block transactions too (#180). Race-free sync and resync, `/livez` `/readyz` `/metrics`. ([README](mempool-recorder/README.md)) | Go |
| `backend/` | Follows the Bitcoin node (RPC + ZMQ `hashblock`). Writes `blocks`, the unknown- and stale-parents summaries (`unknown_parents.py`, `stale_parents.py`, each with a `--backfill` CLI) and the transaction-set counts per height behind template providers (`template_sets.py`, `--backfill` too, or `TEMPLATE_SETS_BACKFILL` in the background), runs analytics plug-ins (`backend/analytics/`, see [README "Adding an analyzer"](README.md#adding-an-analyzer); the coinbase checks re-run over stored blocks with `python -m coinbase_reanalysis`), publishes block events. `python -m reported_hashrate` stores pools' self-reported hashrate from a third-party site (`reported_hashrate`, a claim, never mixed with measured data; off unless configured). | Python |
| `web/` | Next.js app: realtime table, template details, timing, Sankey, infra/latency views, Forks (templates on a parent other than our best block, as episodes: a recorded stale block, or an unknown parent with an inferred kind; invalid-coinbase findings as badges; over the last 6 or 26 difficulty epochs or all history, on a block-height axis; unknown and stale parents read from the backend's `unknown_parent_pools` and `stale_parent_pools`). API routes in `web/app/api/`, data layer in `web/lib/db/`. | TypeScript, Next.js 16 |
| `helm-charts/` | Charts for collector, backend, and webapp | Helm |
| `db/` | Postgres schema as [dbmate](https://github.com/amacneil/dbmate) migrations (`db/migrations/`), local dev users, migration test | SQL |
| `postgres/` | CloudNativePG Postgres + TimescaleDB image for production | Dockerfile |

## Run it
```bash
cp .env.example .env          # optional: Bitcoin node, remote-access settings
docker compose up --build     # dev mode: web hot-reloads from ./web
```
- Rebuild a service after changes: `docker compose up -d --build backend` (or `collector-<pool>`).
- Machine-specific compose tweaks go in a gitignored `docker-compose.override.yml`, not in `docker-compose.yml`.
- Postgres + TimescaleDB is part of the stack: `postgres-migrate` applies `db/migrations` and `postgres-dev-users` creates the local users before the other services start ([README](README.md#postgres--timescaledb)).
- **Never `docker compose down -v`** on a stack with data you want: it deletes the `pg-data` volume.

## Test
```bash
(cd collector-go && go test ./...)      # collector (no local Go? run it in the golang image)
(cd mempool-recorder && go test ./...)  # mempool recorder: parsing vectors, sequence state machine, pipeline
mempool-recorder/test-e2e.sh            # mempool recorder end to end: regtest node + TimescaleDB + recorder image (Docker)
(cd backend && python -m pytest tests)  # from backend/
(cd web && npm test && npm run lint)    # vitest + eslint
(cd web && npm run perf)               # client performance against a running build (web/perf/README.md); CI runs it on every web PR
db/test-migrations.sh                   # migrations up/down/up + role privileges (Docker)
backend/test-stale-blocks-e2e.sh        # stale blocks: two regtest nodes, fork + reorg (Docker)
backend/test-reorg-reconcile-e2e.sh     # best chain across reorgs: tracker off, backend down, 2 deep, full-history check (Docker)
backend/test-block-gap-fill-e2e.sh      # historical gaps on a pruned node, filled via getblockfrompeer (Docker)
```
[README "Testing and CI"](README.md#testing-and-ci) shows how to run them inside the containers and what CI checks.

## Conventions
- **Defaults preserve existing behavior.** New settings are optional, documented in `.env.example`, and default to the previous value. Never commit machine-specific values (hostnames, IPs, credentials, node URLs).
- **Collector and backend config:** CLI flags win; env vars (`BITCOIN_*`, etc.) provide defaults. Keep secrets out of command lines.
- **Bitcoin RPC** may be `http` or `https` (`BITCOIN_RPC_SCHEME`). For private CAs, verify with `BITCOIN_RPC_CA_FILE`; never disable verification.
- **Database changes go through migrations** in `db/migrations/` (never hand-applied), with a working `-- migrate:down`. Applications connect as least-privilege roles (`stratum_collector`, `stratum_backend`, `stratum_web`, `stratum_mempool`), never as the owner or superuser.
- **PRs:** say what was broken or missing, what changed, and how it was tested (commands and results). Keep them focused. Squash merges are titled `Title (#N)`. Preserve contributor credit with `Co-authored-by:` trailers.

## Data gotchas
- **Not every template is a Bitcoin template.** Some pools mine other chains on the same endpoints, so a template's height can be far from Bitcoin's (e.g. 6,976,415). Take the Bitcoin tip from `blocks` (written from bitcoind), not from `max(height)` of templates. Every template is in `templates`: judge at read time (`bitcoin_parents` for the chain, `height_window()` for a height's receive window; [design doc](docs/design/one-templates-table.md)).
- **`templates` is large and append-only:** a hypertable on `received_at`, indexed on `(height, source_id, received_at)`. Height reads should also bound `received_at` (pass `height_window()`'s result as parameters) so TimescaleDB can skip chunks.
- Templates for height `h` are the work for the block *after* tip `h-1`.

## Images and deployment
`.github/workflows/images.yml` builds multi-arch (amd64 + arm64) images for `web`, `backend`, `collector-go`, `mempool-recorder` and `postgres`:
- **PRs:** build the changed components, push nothing.
- **Merge to `main`:** push `bboerst/stratum-work-<component>:sha-<7>` (and `:main`) for each changed component (`web`, `backend`, `collector-go`, `mempool-recorder`, `postgres`).
- **Releases:** push all components as `:<tag>` and `:latest`.

Deployments pin `sha-<7>` tags, and the same image is promoted from dev to prod, never rebuilt. Production deployment is managed in a separate repository. Never build or push images by hand.
