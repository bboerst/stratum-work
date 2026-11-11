# CLAUDE.md

Guidance for AI coding agents (and humans) working in this repo. Start with the [README](README.md) for architecture and local setup.

## Components
| Path | What | Stack |
|---|---|---|
| `collector/` | Connects to one pool over Stratum. Publishes each `mining.notify` to RabbitMQ and MongoDB (`mining_notify`), with latency estimates and BTC/BCH chain detection. | Python |
| `backend/` | Follows the Bitcoin node (RPC + ZMQ `hashblock`). Writes `blocks`, runs analytics plug-ins (`backend/analytics/`, see README "Adding a New Analyzer"), publishes block events. | Python |
| `web/` | Next.js app: realtime table, template details, timing, Sankey, infra/latency views. API routes in `web/app/api/`. Prisma schema in `web/prisma/`. | TypeScript, Next.js 16 |
| `helm-charts/` | Charts for collector, backend, and webapp | Helm |

## Run it
```bash
cp .env.example .env          # optional: Bitcoin node, remote-access settings
docker compose up --build     # dev mode: web hot-reloads from ./web
```
- Rebuild a Python service after changes: `docker compose up -d --build backend` (or `collector-<pool>`).
- Machine-specific compose tweaks go in a gitignored `docker-compose.override.yml`, not in `docker-compose.yml`.

## Test
```bash
python -m pytest collector/tests        # from the repo root
(cd backend && python -m pytest tests)  # from backend/
(cd web && npm test && npm run lint)    # vitest + eslint
```
The README shows how to run these inside the containers.

## Conventions
- **Defaults preserve existing behavior.** New settings are optional, documented in `.env.example`, and default to the previous value. Never commit machine-specific values (hostnames, IPs, credentials, node URLs).
- **Collector and backend config:** CLI flags win; env vars (`BITCOIN_*`, etc.) provide defaults. Keep secrets out of command lines.
- **Bitcoin RPC** may be `http` or `https` (`BITCOIN_RPC_SCHEME`). For private CAs, verify with `BITCOIN_RPC_CA_FILE`; never disable verification.
- **PRs:** say what was broken or missing, what changed, and how it was tested (commands and results). Keep them focused. Squash merges are titled `Title (#N)`. Preserve contributor credit with `Co-authored-by:` trailers.

## Data gotchas
- **Not every template is a Bitcoin template.** Some pools mine other chains on the same endpoints, so `mining_notify.height` can be far from Bitcoin's (e.g. 6,976,415). Take the Bitcoin tip from `blocks` (written from bitcoind), not from `max(mining_notify.height)`. Filter or classify by chain before analytics (see #72, #79, #98).
- **`mining_notify` is large and append-only:** about 136M documents in production. It's indexed on `_id` (UUID string, not time-ordered) and `height`. Range queries should go through `height`. `timestamp` is a hex-nanosecond string and isn't indexed.
- Templates for height `h` are the work for the block *after* tip `h-1`.

## Deployment
Images are built by GitHub Actions on a **GitHub release** (`.github/workflows/*-docker-release.yml`). Production deployment is managed in a separate repository.
