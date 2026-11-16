# mongo-to-postgres: backfill and verification

Copies the MongoDB history (`mining_notify`, `blocks`, `pools`) into the Postgres + TimescaleDB schema in [`db/migrations`](../../db/migrations), then checks the copy is complete and exact. Design: [`docs/design/postgres-timescale.md`](../../docs/design/postgres-timescale.md), section 5. Tracking: #114.

**Source: a throwaway MongoDB restored from the backups, never a live database.** The tool reads only. Its one write to MongoDB, `--create-index`, is opt-in and meant for the restore.

## What it does
- **One UTC day per transaction, oldest first.** Each day's rows and its progress record commit together, so a crash or Ctrl-C leaves nothing half-loaded. A re-run skips completed days and redoes the rest. `--workers N` loads N days in parallel (processes).
- **Lossless conversion.** Hex fields become `bytea`, `version`/`nbits`/`ntime` become `bigint`, merkle branches are concatenated. A document is loaded only if re-encoding the row gives back exactly what MongoDB holds. Anything else (upper-case or odd-length hex, a non-string `job_id`, ...) is **rejected**: stored in full in the bookkeeping table `rejected`, counted and reported, never altered.
- **Timestamps:**
  - 16-hex-digit nanoseconds (µs kept)
  - ISO-8601 with an offset, parsed by its offset
  - ISO-8601 **without** an offset, parsed as **UTC**
  - BSON dates
- **Height** is re-derived from `coinbase1` with the collector's parser (`collector/coinbase.py`). It is never copied.
- **Routing** uses the collector's own `route()` (`collector/pgsink.py`, loaded from the repo, not copied), fed with the Bitcoin tip at receive time:

  `tip(t) = max(height of blocks with header time ≤ t, highest known block any template had built on by t)`

  The second term matters. Header times are often minutes *after* a block's real arrival. With header times alone, the next height's first templates look like tip + 3 and would be misrouted to `templates_other`. A template's `prev_hash` proves the block it builds on was already out.
- **Timezone safety net, per height, from the data:**
  - **Corrects only when both clocks agree.** That height's naive-ISO templates must sit −6 h or −7 h (±30 min) from their own `ntime` (≥ 90% of them, and the median), and its first template the same distance from block *h*−1's header time.
  - **Never a blanket offset by height or date.**
  - **What it changes:** the correction is applied to those rows. `received_at_offset_s` records it (`received_at = as recorded − offset`, so −6 h is stored as −21600).
  - **What gets reported:** every corrected height, plus "suspect" heights where only one signal agreed (those are left unchanged).
- **Dedup** on `(source, received_at µs, job_id)`; the smallest MongoDB `_id` of a group is kept. Each dropped duplicate is recorded, including whether its content differed from the kept one.
- **`sources`:** one row per historical `pool_name`, with `site = old-cluster` (`--site`).
- **Blocks:** de-duplicated on `block_hash` (newest document wins), in the backend's row shape (`backend/integrations/store.py`). By default, rows already in Postgres are kept, so blocks written by a new backend win; `--blocks-overwrite` updates them instead.
- **Pools:** loaded with their full definition through the backend's own `replace_pools()`, if `pools` is empty (`--pools-overwrite` replaces it otherwise).

## Run it against a restored backup
1. **Restore** the latest weekly full plus every later incremental (complete sets only) into an empty, throwaway MongoDB.
2. **Create the target:** an empty database with the migrations applied.

   ```bash
   docker run --rm -v "$PWD/db:/db" -e DATABASE_URL=... ghcr.io/amacneil/dbmate:2.37.0 --wait up
   ```
3. **Configure.** The tool connects as the database owner: it writes to all five tables and creates its own schema. Connection details:
   - **MongoDB:** `MONGO_URI` (environment only, since it may hold credentials) and `--mongo-db` (default `stratum-logger`).
   - **Postgres:** `--pg-host/--pg-port/--pg-database/--pg-user/--pg-sslmode`, or libpq's `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGSSLMODE`. The password goes only in `PGPASSWORD` or a `PGPASSFILE`.

   Connections take keyword arguments, never a URL, and nothing secret is logged.
4. **Run** from a checkout of this repository: the tool loads `collector/` and `backend/` code from it.

```bash
cd tools/mongo-to-postgres
pip install -r requirements.txt          # Python 3.13

python -m m2p migrate --create-index --until 2026-12-01T00:00:00Z --workers 4   # --until: T0, the new collectors' start
python -m m2p verify --out verify.json   # exit 1 on any FAIL
python -m m2p report --verify-json verify.json --out report.md
python -m m2p cleanup --yes              # after sign-off: drops the bookkeeping schema
```

`migrate` options:
- `--from-day` / `--to-day`: limit the day range.
- `--until`: an exclusive cut-off for receive times. A day that is still being written is always cut 2 minutes behind now, and the cut is recorded. A later run with a later cut redoes that day (delete and reload, in one transaction), and never shrinks it.
- `--pool-until NAME=INSTANT` (repeatable): for the source `NAME`, cut at `INSTANT` instead of `--until`. See [Per-pool cut-off](#per-pool-cut-off).
- `--only-pools NAME[,NAME]` (repeatable): load only these sources; every other source keeps what it has.
- `--skip-blocks`, `--skip-pools`.
- `--batch-size`: MongoDB cursor batch size.

Without the `timestamp` index, every day is a collection scan: still correct, just slow.

### Per-pool cut-off
Sometimes one pool keeps being collected only by the old deployment after T0, until it switches at a later T_L. Its documents in [T0, T_L) must be copied too, and no other pool's documents after T0. `--pool-until NAME=T_L` gives that source its own cut. `NAME` is matched exactly as stored (`pool_name` in MongoDB, `sources.name` in Postgres). A name that matches nothing is logged as a warning at the end of the run.

How it fits the day model:
- **Each day records a cut per source:** `days.until` is the default, and `days.pool_until` holds the sources with their own cut. Per source, coverage only grows: the new cut is the larger of what is recorded and what is asked for.
- **Every day is built whole.** Each source's documents up to its own cut are read, and the timezone safety net, de-duplication and routing (whose `prev_hash` evidence draws on every source) run over all of them. The rows and the bookkeeping are therefore the same however the work was split over runs.
- **What a run does to a day:**
  - When only some sources' own cuts grew, only their rows are deleted and reloaded, in one transaction. The day's bookkeeping is rewritten from the whole-day build, and the other sources' rows are left alone. Before that, the rebuilt rows of every other source are compared with what Postgres holds (time, offset, `job_id`, height, table, reason). If anything differs, the day is reloaded whole: the warning is logged and the mode is recorded in `stats.redo`.
  - When the default cut grows, the whole day is reloaded, as before.
- **Days after T0's day** hold nothing of the other sources (their cut is the day's start), so they are loaded for that pool alone.

Worked example, with `ExamplePool` standing in for the pool's name:

```bash
# 1. one pass: every pool up to T0, ExamplePool up to T_L
python -m m2p migrate --create-index --until 2026-12-01T00:00:00Z --pool-until ExamplePool=2026-12-03T12:00:00Z --workers 4

# 2. or a second pass after a first one without the option (same result as 1). --only-pools keeps every other
#    source as loaded, even if --until were mistyped or left out.
python -m m2p migrate --until 2026-12-01T00:00:00Z --workers 4                     # first pass, earlier
python -m m2p migrate --until 2026-12-01T00:00:00Z --pool-until ExamplePool=2026-12-03T12:00:00Z \
    --only-pools ExamplePool --workers 4
#    -> 2026-12-01: ExamplePool's rows reloaded alone (its cut grows from T0 to the whole day)
#    -> 2026-12-02 and 2026-12-03: new, ExamplePool only (until 12:00 on the 3rd)

python -m m2p verify --out verify.json   # counts per (day, source) up to each source's own cut
```

A re-run with the same options is a no-op, and so is a re-run without `--pool-until`, because a cut never shrinks. Use the same image for `verify` and `report`: an older version doesn't read `days.pool_until` and miscounts those days.

### Bookkeeping (`mongo_to_postgres` schema)
It's a one-off job's state, not part of the app's schema, so the tool creates it with `IF NOT EXISTS`, and `cleanup` drops it.

| Table | Holds |
|---|---|
| `days` | per day: cut-off (`until`, and per source `pool_until`), counts, seconds, statistics (formats, reasons, height changes, unknown fields, how the day was last reloaded, ...) |
| `day_sources` | per day and source: MongoDB documents, `templates`, `templates_other`, duplicates, rejected |
| `tz_findings` | per height: offset, count, evidence, corrected or suspect |
| `rejected` | full documents that couldn't be converted losslessly, with the reason |
| `duplicates` | kept and dropped `_id`, and whether they were identical |

## Verification
`verify` recounts MongoDB and Postgres independently. The bookkeeping supplies only what can't be recounted: the dropped duplicates, the rejects and the timezone corrections. Each check ends **PASS**, **WARN** (a human should look, but the copy is not wrong) or **FAIL**.

| Check | FAIL when | WARN when |
|---|---|---|
| coverage | a timestamp is in no known format (no day can select the document) | days with documents were not migrated |
| counts per (day, source), each source up to its own cut | MongoDB ≠ `templates` + `templates_other` + duplicates + rejected | rejects, or duplicates whose content differed |
| byte-exact round trip (default 10,000 random templates) | any field differs after re-encoding, or the routing invariants break (`chain_family` kept, parse failure → `height_parse_failed`) | — |
| routing by reason | — | `height_implausible` rows that build on the known block *h*−1 within an hour of it (misrouting) |
| timestamp sanity per height (first template − block *h*−1 header time) | an outlier at ±6 h / ±7 h (a timezone that wasn't caught) | other outliers beyond ±1 h |
| missing heights | — | heights without templates outside the known gaps (default `876883-876903`, `--known-gap`) |
| blocks | a MongoDB `block_hash` missing in Postgres | fields differ (expected for rows the new backend wrote) |
| pools | — | definitions differ (expected after the backend's daily refresh) |

With `--pool-until`, the counts check also reports each such source's window: its days, its cut against the day's default, and the documents beyond the default cut. `verify` prints it as `pool window '<name>': ...`, and `report --verify-json` includes it as a table.

The routing check also reports, for each reason, row counts, shares, sources, the height range and samples. `latency_ms` is a `real` column, so the round trip compares it as float4.

Expected output (the synthetic fixture, which includes a rejected document and a differing duplicate on purpose):
```
PASS  coverage
WARN  counts per (day, source): mongo = templates + templates_other + duplicates + rejected
PASS  byte-exact round trip (10000 random templates)
PASS  routing by reason
PASS  timestamp sanity per height: first template - block(h-1) header time
PASS  missing heights (known gaps expected)
PASS  blocks: every MongoDB block_hash present, fields equal
PASS  pools: full definition
OVERALL: WARN
```

## Throughput
Measured on a 4-vCPU VM, with MongoDB, Postgres and the tool all on it. The data was 325k real-shaped templates over 31 days.

| Workers | docs/s |
|---|---|
| 1 | ~20k (per day: ~half read and convert, ~half `COPY`) |
| 2 | ~39k |
| 4 | ~53k |

At 4 workers, today's ~136M templates take about 45 minutes, plus building the `timestamp` index on the restore. `verify` reads every migrated document's `timestamp` and `pool_name` once.

## Image
CI builds `bboerst/stratum-work-mongo-to-postgres:sha-<7>` (amd64 + arm64) from [`Dockerfile`](Dockerfile), for running next to a restored MongoDB in a cluster. The build context is the repository root, and only the tool and the three modules it loads (`collector/coinbase.py`, `collector/pgsink.py`, `backend/integrations/store.py`) are in it. A change to any of them rebuilds the image. It runs as an unprivileged user with `python -m m2p` as the entrypoint, so the arguments are the subcommand:
```bash
docker run --rm -e MONGO_URI=... -e PGHOST=... -e PGUSER=... -e PGPASSWORD=... \
  -v "$PWD/out:/out" bboerst/stratum-work-mongo-to-postgres:sha-<7> verify --out /out/verify.json
```

## Tests
```bash
tools/mongo-to-postgres/test-e2e.sh                      # everything, in throwaway containers (Docker)
M2P_IMAGE=<image> tools/mongo-to-postgres/test-e2e.sh    # the same checks against the image
(cd tools/mongo-to-postgres && python -m pytest tests)   # unit tests only (needs requirements-dev.txt)
```
`test-e2e.sh` loads [`tests/fixture.py`](tests/fixture.py) into a throwaway MongoDB. The fixture covers:
- naive-ISO, offset-ISO (including across midnight), hex and BSON timestamps
- a −6 h height, stale +12 h replays, and late block header times
- duplicate templates and blocks
- `chain_family` documents, an impossible height, a parse failure, an upper-case hex document
- a collection outage

The script then migrates with 2 workers, verifies, asserts every case, re-runs to prove resumability, and checks that `verify` catches a deleted row and an unrecognized timestamp.

The per-pool cut-off runs on its own copy of the fixture: global cut T0, `PoolB` until T_L the next day. The script checks:
- one pass with the option, against a first pass without it followed by a second `--only-pools` pass: the same rows and bookkeeping
- the second pass leaves the other pools' rows untouched
- the re-runs are no-ops
- `verify` passes and reports the window
- the whole-day fallback, when another source's rows differ
