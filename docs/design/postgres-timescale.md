# Design: MongoDB → Postgres + TimescaleDB

Tracking: #90 (epic). Status: **in progress**. Sections 1, 2, 4 and 5 drafted; section 3 (measurements) follows.

1. [Current data access](#1-current-data-access) ✅
2. [Schema](#2-schema) ✅ (draft; final choice after section 3)
3. Measurements on real data (size per day, query latency)
4. [Backups and recovery](#4-backups-and-recovery) ✅ (draft; sizes filled in after section 3)
5. [Migration plan](#5-migration-plan) ✅ (draft)

---

## 1. Current data access

Inventory of every MongoDB read and write in `collector/`, `backend/` and `web/` (as of `main` @ 2fc0764). The **live stream doesn't touch the database:** collectors and the backend publish to RabbitMQ fanout exchanges (`mining_notify_exchange`, `blocks`), and `web/app/api/stream` relays them over SSE.

### Volumes (production, 2026-11-11)
| Collection | Documents | Size | Growth | Indexes |
|---|---|---|---|---|
| `mining_notify` | 135.9M | 255.6 GB BSON, 102.9 GB on disk | **~123k/day ≈ 0.23 GB/day BSON** | `_id`, `height` (created by hand, not by code) |
| `blocks` | 128.7k | ~0.1 GB | ~144/day | `_id` only |
| `pools` | 172 | tiny | replaced daily | `_id` only |

### Writes
| # | Where | Operation | Rate | Notes |
|---|---|---|---|---|
| W1 | `collector/main.py` `insert_notification` | `mining_notify.insert_one` | ~1.4/s average; **bursts when a block is found** (every pool sends a `clean_jobs` template within about a second) | `_id` = random UUID string. `timestamp` = receive time as **16-hex-digit nanoseconds string**. `height` parsed from the coinbase (see gotchas). Optional `lat_ms`/`lat_m`; `chain_family` set only for non-BTC |
| W2 | `backend/main.py` `process_block` | `blocks.update_one({block_hash}, $set, upsert)` for new blocks; `insert_one` during backfill; `replace_one` on reprocess | ~144/day | Document: `height, block_hash, timestamp (unix s), coinbase_script_sig, mining_pool{…}, analysis{…}` |
| W3 | `backend/analytics/pool_identification.py` | `pools.delete_many({})` + `insert_many` | daily | Full replace from mempool/mining-pools `pools-v2.json` |

### Reads
| # | Where | Query | Used by | Frequency |
|---|---|---|---|---|
| R1 | `web/lib/db/mining-notify.ts` `getMiningNotifyByHeight` | `mining_notify` **by `height`**, BTC only (`chain_family` null or unset), all fields | Realtime table when viewing a past height (`hooks/useTableData`) | Per page view. 500 MB LRU cache per web pod |
| R2 | `web/app/api/analysis-data` `?height=a,b,…` | `mining_notify` **by `height`**, *no chain filter*, all fields, plus `blocks` at `h` and `h-1` | Template details page (`AnalyticsPanel`) | Per view. Decodes coinbases server-side |
| R3 | `web/app/api/analysis-data` `?interesting=true` | `blocks` where `analysis` has any key besides `pool_identification`, newest 200 | Visualization panel | Per view. **`$expr` full scan** of `blocks` |
| R4 | `web/app/api/block-pool-first-seen` | aggregate `mining_notify` **by `height`**, BTC only, non-empty `pool_name`, sort by `timestamp`, first per pool → `(pool, timestamp, lat_ms)` | Historical timing (`HistoricalPoolTiming`, `/height/[height]`) | Per view |
| R5 | `web/lib/db/blocks.ts` `getBlocks` | `blocks`: latest *n* / *n* around a height / *n* after a height, sorted by height | Blocks strip (`Blocks.tsx`): initial 20, jump-to 40, poll 10 after the newest | Frequent (polling). **No `height` index on `blocks`** |
| R6 | `web/lib/db/blocks.ts` `getBlockByHeight` / `getBlockByHash` | `blocks` by equality | R2, R5 | Frequent. Unindexed |
| R7 | `web/lib/db/pools.ts` | `pools` all / by name / by address | `/api/pools` | Low |
| R8 | `backend/main.py` `run_block_analyses` | `mining_notify` **by `height`**, BTC only, all fields | Analytics plug-ins, once per block | ~144/day |
| R9 | `backend/main.py` startup sync | `blocks`: highest, lowest, heights in a range, by height | Backfill missing blocks | Startup |
| R10 | `backend/main.py` `start_full_reindex_background` | all `blocks` by height, descending | Manual full reindex (off by default) | Rare |
| R11 | `backend/analytics/pool_identification.py` | `pools` all | Pool identification cache | Startup / daily |
| R12 | backups (`server-vps1`) | `mining_notify` by `height >=` *h*; full dumps | Weekly full, daily incremental | Daily |

**Summary:** every `mining_notify` read is "all templates at height *h*", sometimes BTC-only, sometimes grouped by pool. Nothing reads by time range, pool range, or content today.

### Planned access (from the roadmap)
These don't exist yet, but the schema has to serve them:
- **LLM data API (#92):** bulk export by height range, time range and pool; arbitrary read-only queries.
- **LLM analytics processor (#93):** per height, all pools' templates plus diffs against each pool's previous template.
- **Similarity scoring (#94):** rolling windows (N blocks / N days) of per-pool features: transaction-set and ordering overlap, merkle-branch equality per depth, coinbase structure, update timing.
- **Merkle reconstruction (#95):** look up templates *by merkle-branch hash* ("which pools' templates contain branch X at depth d"), and compare branches across pools and over time.
- **Timing and latency views:** first-seen per pool per height (R4), latency history per pool, update cadence per pool.

### Gotchas the schema must fix or absorb
1. **Chain filtering is inconsistent.** R1 treats `chain_family` null *or* unset as BTC, R4/R8 use `$exists: false`, and R2 doesn't filter at all. → Make a **non-null `chain` column** the explicit filter everywhere.
2. **`height` isn't reliable.** The collector reads a fixed 3 bytes of the coinbase's BIP34 push (`script[1:4]`) and ignores the push length. It stores `0` when parsing fails. Other chains' templates and odd pushes therefore get impossible heights (one prod document has 6,976,415; see #98). → Store the parsed height and a validity/chain classification, and take the Bitcoin tip from `blocks`.
3. **Time is a hex string.** `mining_notify.timestamp` sorts correctly only because it's fixed-width. `blocks.timestamp` is unix seconds. → Use `timestamptz` (microsecond precision; keep `received_ns bigint` if nanoseconds matter for timing).
4. **IDs.** `mining_notify._id` is a random UUID string (no locality). The Prisma schema claims `ObjectId`.
5. **Indexes aren't code.** The only secondary index (`mining_notify.height`) was created by hand. `blocks` has none, despite `@unique` in `schema.prisma`, so every block lookup is a 128k-document scan. → Migrations own all indexes.
6. **The Prisma schema drifts from the data.** `blocks.mining_pool` and `analysis` aren't modeled (hence `$runCommandRaw`), and `pool` is declared but unused. → The new schema is the source of truth, managed by migrations, with Prisma generated from it.
7. **Templates repeat heavily.** Consecutive templates from a pool usually share `prev_hash`, `nbits`, `version`, most or all of `merkle_branches`, and most of `coinbase1/2`. That's the main lever for size: columnar compression segmented by pool, or deduplicated branch and coinbase storage. Section 3 measures both.

---

## 2. Schema

Full DDL: [`postgres-timescale/schema.sql`](postgres-timescale/schema.sql), for **Postgres 18 + TimescaleDB 2.30**. It loads cleanly into `timescale/timescaledb:2.30.2-pg18`, and was tested functionally (below).

### Principles
1. **Lossless.** Store exactly what the pool sent, in compact types: hex → `bytea` (half the size), hex `u32` → `bigint`. Anything derived (decoded coinbase, outputs, tags) is computed, or kept in separate analytics tables.
2. **Bitcoin by construction.** Bitcoin templates and everything else go in different tables, so no query can forget a chain filter (gotcha 1). The rule is applied once, at ingest.
3. **Shaped for the reads we have:** "templates at height *h*" (R1, R2, R4, R8, R12). Time-range and per-pool access (#92, #94) should come almost free.
4. **Migrations own the schema.** Indexes and Timescale settings are code, never hand-applied (gotcha 5).

### Tables
| Table | Kind | Rows | Notes |
|---|---|---|---|
| `templates` | hypertable, partitioned by `received_at`, 7-day chunks | ~136M, +123k/day | Bitcoin templates only. Columnstore after 2 days, segmented by `source_id`, ordered by `(height, received_at)`. Chunk skipping on `height`. |
| `templates_other` | hypertable, 30-day chunks | small (measured in section 3) | Other chains, BIP34 parse failures, implausible heights. Same columns plus `chain` and `reason`. |
| `sources` | table | ~40 per site | One per collector endpoint (today's `pool_name`) per collection `site` (section 5). `smallint` id. |
| `merkle_branch_sets` | table | candidate B only | Deduplicated branch sets with `sha256` digest. |
| `blocks` | table | ~129k, +144/day | Keyed by `block_hash`, so fork blocks at the same height can coexist. New `seen_at` column. `analysis` stays `jsonb` (analytics plug-ins write free-form results). |
| `pools` | table | 172 | mining-pools list. GIN index on `addresses`. |

### Why partition by time but look up by height
Every read is by height, but partitioning by height would let other chains' and parse-failure heights (6,976,415, 0) create stray chunks, and would make time windows (#92, #94) awkward. Instead:
- **Partition by `received_at`,** with **`enable_chunk_skipping('templates', 'height')`**. TimescaleDB records each compressed chunk's min/max height, and the planner excludes chunks that can't match.
- **Order compressed data by `(height, received_at)` within each source.** Each 1,000-row batch carries its min/max height, so only matching batches are decompressed.
- **This only works if `templates` holds sane heights.** One 6,976,415 row would widen its chunk's range and defeat skipping. That's another reason for `templates_other`.

**Verified** with 151k synthetic rows, 7 chunks (6 compressed). `WHERE height = 902000` scanned **1 compressed chunk** (filtering batches on `_ts_meta_v2_first/last_height`) plus the current uncompressed chunk, and **skipped the other 5**. Chunk skipping requires the server setting `timescaledb.enable_chunk_skipping = on`. The planner reads it too, so in production it belongs in the Postgres config (CloudNativePG `spec.postgresql.parameters`).

### Ingest rules (collector)
1. **Parse the BIP34 height correctly:** read the push length from `script[0]` and decode that many bytes. Today's parser reads a fixed `script[1:4]` (#98).
2. **Route each template:**
   - **`templates`:** the parse succeeded, the collector's chain classifier doesn't flag it (`bch`/`unknown`), and, when the collector knows our tip, `tip − 6 ≤ height ≤ tip + 2`.
   - **`templates_other`:** everything else, with `reason`: `height_parse_failed`, `bch`, `unknown_chain`, or `height_implausible`.
   - **Without a node configured** (contributors' local setups), parsed templates go to `templates`. That's today's behavior.
3. `sources` upsert at collector startup. Inserts are single-row: ~1.4/s average, bursts of a few dozen per second when a block is found. That's trivial for Postgres, so no batching is needed.

### Candidates to measure (section 3)
| | Merkle branches | Expected trade-off |
|---|---|---|
| **A** | Inline `bytea` column (n × 32 bytes) | Simplest writes and reads. Relies on columnstore compression catching repeats within a source's batch. |
| **B** | `merkle_set_id bigint` → `merkle_branch_sets` (dedup by sha256) | One upsert per new set on write and a join on read. Saves space if sets repeat, and **gives cross-pool equality for free**: two sources pointing at the same set id is a strong shared-template-source signal for #94, and an index for #95. |

Coinbase parts stay inline in both: coinbase outputs change with fees, so they're mostly unique per template. Section 3 decides between A and B with real numbers. It's also possible we keep A for storage and build B-style tables later, purely as analytics indexes.

### Current reads in the new schema
| # | SQL |
|---|---|
| R1, R8 | `SELECT … FROM templates WHERE height = $1` (Bitcoin by construction; the chain filter is gone) |
| R2 | R1, plus `UNION ALL … FROM templates_other WHERE height = $1` only if the details page should keep showing non-BTC templates (decision for #98) |
| R3 | `SELECT … FROM blocks WHERE (analysis - 'pool_identification') <> '{}' ORDER BY height DESC LIMIT 200`: **index-only scan** on the partial index (verified), replacing today's full `$expr` scan |
| R4 | `SELECT DISTINCT ON (source_id) source_id, received_at, latency_ms FROM templates WHERE height = $1 ORDER BY source_id, received_at` (verified) |
| R5, R6, R9 | `blocks` by `height` range or equality (`blocks_height` index), or by `block_hash` (PK). Today these are unindexed 128k-document scans. |
| R7, R11 | `pools`: by name, all, or `addresses @> ARRAY[$1]` (GIN) |
| R10 | `SELECT block_hash FROM blocks ORDER BY height DESC` |
| R12 | Replaced by WAL archiving + base backups (section 4). No more dump-based incrementals. |

### Database users and credentials (from day one)
The current MongoDB setup has every component sharing one admin account, with the password in plaintext in deployment manifests. Not again:
- **Least-privilege roles:**
  - `collector` (INSERT on `templates`/`templates_other`, upsert on `sources`)
  - `backend` (read `templates`, write `blocks`/`pools`)
  - `web` (read-only)
  - `migrator` (DDL, used only by the migration Job)
  - backups use CNPG's own replication/streaming credentials
- **Credentials only via Secrets**, generated by CNPG or Terraform, with no passwords in manifests or values files. Tools get credential-free connection strings, with the password supplied separately, so errors can't print it.
- No superuser access from applications.

### Not decided here
- **Tooling:** plain-SQL migrations with [dbmate](https://github.com/amacneil/dbmate) in `db/migrations/`, applied by an init Job. Web keeps Prisma, introspected with `prisma db pull`; Timescale DDL stays in SQL. Python uses psycopg 3. To confirm when implementing.
- **Retention:** keep everything (current behavior). The columnstore makes that cheap; section 3 gives the per-year cost.
- **Licensing:** columnstore compression is in TimescaleDB's TSL-licensed features, which are free to self-host and run in your own product, but can't be offered as a hosted database service. The `timescale/timescaledb` image includes it, so contributors' local setups work unchanged.
- **Continuous aggregates** for #94 windows (per-source features per time bucket): designed with that epic, on top of `templates`.

---

## 4. Backups and recovery

Goals, from #90:
- the database survives node and volume loss without manual heroics
- any point in time within the retention window can be restored
- backups are off-site, automatic, protected against deletion, and **proven by regular restore drills**

### Building blocks
| Piece | Choice | Why |
|---|---|---|
| Operator | [CloudNativePG](https://cloudnative-pg.io/) (CNPG) | Kubernetes-native HA Postgres: automated failover, declarative backups, recovery as a `Cluster` bootstrap mode. |
| Image | Postgres 18 + TimescaleDB 2.30, built by our CI image pipeline | CNPG needs its own image layout. There's no upstream CNPG + Timescale image, so we build `FROM` the CNPG Postgres image and add the TimescaleDB packages. To verify at implementation: extension packages and `shared_preload_libraries`. |
| Backup engine | CNPG **Barman Cloud plugin** | Continuous WAL archiving plus base backups to S3-compatible storage. It's the supported path (the in-tree `barmanObjectStore` is deprecated). |
| Storage | **Backblaze B2** (S3 API), a **dedicated bucket** for Postgres | Different provider from the cluster, so it's off-site by construction. Already used for the interim MongoDB backups, and Terraform-managed. |
| Volumes | Hetzner Cloud Volumes (CSI), not node-local disks | They survive node replacement, can be resized, and aren't tied to one server's root disk (unlike today's local-path volumes). |

### Topology
- **2 instances:** a primary and one streaming replica, on separate nodes (anti-affinity) in a dedicated database node pool, with a PodDisruptionBudget. Writes are only ~1.4/s, so a small replica keeps up easily. CNPG promotes it automatically if the primary fails.
- **Replication:** asynchronous to start with. Synchronous would cut the failover RPO from seconds to zero, at the cost of write latency on every template insert. Revisit if it's needed.
- **Server settings** (via `spec.postgresql.parameters`): `timescaledb.enable_chunk_skipping = on` (section 2), and `archive_timeout = 5min`. The latter bounds the RPO of a full restore: WAL is shipped at least every 5 minutes even during quiet periods.

### Backups
- **WAL archiving:** continuous. Every completed WAL segment is compressed and uploaded. This is what makes point-in-time recovery possible.
- **Base backups:** weekly (`ScheduledBackup`), compressed. Taken from the replica when one is available, so the primary isn't loaded.
- **Retention:** 30 days, enforced by Barman (`retentionPolicy: 30d`), which deletes base backups and WAL that are no longer needed. That gives PITR to any second in the last 30 days.
- **Long-term monthly copies:** not needed from the physical backups; see "Logical exports".

### Protection against deletion
Barman must be able to delete expired backups, so its key needs delete permission. A stolen or misused key could then purge the backups, older versions included. Instead of withholding delete:
- **B2 Object Lock on the bucket**, governance mode, with a default retention **slightly shorter than Barman's** (e.g. 29 days vs 30). Every object is undeletable until its lock expires, so Barman's own deletions (always of objects past the retention window) succeed. A compromised key can't remove anything younger than the lock.
- **Keys** (all Terraform-generated and prefix-scoped):
  - **writer:** read, write, delete. Used by the cluster. **No `bypassGovernance`**, so it can't override the lock.
  - **drill reader:** read-only. Used by restore drills, in a separate namespace from production.
  - Only the account's master key, held by Brian, can bypass governance in an emergency.
- **Encryption:** server-side (SSE-B2), like the interim backups.

### Recovery scenarios
| Scenario | What happens | RTO | RPO |
|---|---|---|---|
| Primary pod or node lost | CNPG promotes the replica, and a new replica rebuilds from it | ~1 min (automatic) | seconds (async replication) |
| A volume lost or corrupted | The affected instance is rebuilt from the other one, or from backup | minutes (automatic) | 0 |
| Both instances / the whole cluster lost | New `Cluster` with `bootstrap.recovery` from the latest base backup + WAL | download + WAL replay: roughly tens of minutes for a ~50 GB database (to measure in drills) | ≤ 5 min (`archive_timeout`) |
| Bad migration, bug or accidental delete | **PITR** to a timestamp just before it, into a *new* cluster; then cut over, or copy the affected rows back | same as above | to the second |
| Hosting provider or region lost | Terraform builds a new cluster elsewhere and restores from B2 (a different provider) | hours (rebuild-dominated) | ≤ 5 min |
| Backup credentials compromised | Object Lock: nothing younger than the lock can be deleted. Rotate keys with Terraform. | — | — |

### Restore drills (automated)
A backup that has never been restored isn't a backup. So, **monthly**, plus after any backup-config change:
1. In a dedicated `pg-restore-drill` namespace, with the read-only drill key, create a CNPG `Cluster` bootstrapped from the **latest backup**. Recovery target: the latest consistent point.
2. Run checks:
   - `templates` row counts per day for the last 7 days match the source within the WAL lag
   - `max(received_at)` is within `archive_timeout` of the drill's recovery target
   - `blocks` max height matches
   - the schema migration version matches
3. Record duration and size, which become the measured RTO. Then delete the drill cluster.
4. **Alert on failure.** Also alert separately on the last archived WAL age (> 15 min), the last successful base backup age (> 8 days), and archiving errors. These are CNPG metrics, wired into the new cluster's monitoring.

Implementation: a CronJob (or Flux-managed manifests on a schedule) whose ServiceAccount may only manage CNPG `Cluster` objects in the drill namespace.

### Logical exports (optional, later)
Physical backups restore only to a compatible Postgres + TimescaleDB version. A **monthly logical export** would be an independent, long-term, version-agnostic copy: completed days of `templates` as **Parquet** files, plus `blocks`/`pools`/`sources` as CSV, written to B2 with a longer retention (e.g. 1 year). It overlaps with the bulk exports planned for the LLM data API (#92), so build it once for both.

### Cost (rough; replaced with measured numbers after section 3)
B2 stores ~5 base backups (weekly × 30 days) plus 30 days of WAL.
- With a compressed database of **~40 GB** (to measure): ~200 GB of base backups + WAL.
- WAL estimate: ingest is ~0.23 GB/day of raw data. Columnstore compression jobs also rewrite each chunk once (WAL bursts). Call it ~1–2 GB/day → ~30–60 GB.
- **≈ 0.25 TB ≈ $1.75/month**, comparable to the interim MongoDB backups.

### Transition from the interim MongoDB backups
1. Keep the MongoDB weekly-full + daily-incremental backups running until Postgres is primary **and** its backups have passed one full restore drill.
2. Take a base backup right after the migration (section 5), then run a drill.
3. Then stop the MongoDB backup jobs, and let the bucket's lifecycle rules age out the old dumps. Keep the last full as a final cold copy, on a longer lifecycle rule, until the migration is beyond doubt.

---

## 5. Migration plan

**Constraints:**
- no gap in collection
- no extra load on the production MongoDB, whose host is memory- and disk-constrained
- a rollback path until the move is proven
- the migration coincides with moving to the new Terraform-built cluster (bboerst/server-vps1#1, #2)

### Approach: parallel collection plus backfill from backups
Avoid dual-writing from one collector to two databases. Instead:
1. **Run a second, independent set of collectors on the new cluster that write only to Postgres,** while the existing collectors keep writing to MongoDB. The overlap is a built-in comparison period, and the old stack is a ready rollback.
2. **Backfill history from the B2 backups,** not the live database: restore the latest weekly full and the daily incrementals into a throwaway MongoDB *inside the new cluster*, and convert from there. Production MongoDB isn't touched. About 35 GiB is downloaded from B2, which is free up to 3× the stored volume, instead of 255 GB of raw data crossing the public network.
3. **Switch reads by switching clusters.** The web app on the new cluster reads Postgres. Cut over DNS once it's verified; roll back by pointing DNS back.

```
time ─────────────────────────────────────────────────────────────────────────────►
old cluster:  collectors → MongoDB ────────────────────────────────────┤ retire
new cluster:                 collectors → Postgres ────────────────────────────────►
                             ▲ T0
backfill:     [ … history < T0 from B2 backups … ] → Postgres
web:          stratum.work → old ────────────────────┤ DNS cutover → new ───────────►
                                   dev on new cluster ▲ (compare side by side)
```

### Steps
| # | Step | Done when |
|---|---|---|
| 0 | **Prerequisites:** the new cluster (#1) with a DB node pool, CNPG and backups (section 4); the schema as migrations (section 2, dbmate); the CI-built Postgres + TimescaleDB image | A restore drill on the *empty* database passes |
| 1 | **Postgres support in the code:** collector sink (ingest routing rules from section 2, `sources` upsert); backend (`blocks`, `pools`, analytics reads); web data layer (R1–R11 from section 1). Selected by configuration; MongoDB stays the default until cutover | Local docker-compose runs fully on Postgres, and the tests pass on both backends |
| 2 | **Start the new collectors** on the new cluster → Postgres. Record **T0**, the first template received | Every source is inserting, and per-height counts are close to the old collectors' |
| 3 | **Backfill templates with `received_at < T0`:** restore full + incrementals into a scratch MongoDB on the new cluster, then convert and load (below) | Verification passes (below) |
| 4 | **Backfill `blocks`** with their `analysis` results (~129k rows) from the same restore. `pools` is regenerated by the backend's daily refresh | Block counts and heights match |
| 5 | **Dev on the new cluster:** dev.stratum.work moves to the new cluster, reading Postgres. Compare it with prod (still old) page by page | Brian signs off on dev |
| 6 | **Cutover:** lower the DNS TTL a day ahead, then point stratum.work at the new cluster. The old web and collectors keep running | Prod serves from Postgres; error rates and latency are normal |
| 7 | **Soak (≥ 1–2 weeks):** old collectors still running, so rollback is a DNS change with no data loss | No rollback needed |
| 8 | **Retire:** stop the old collectors, take a final MongoDB full backup (kept as a cold copy, section 4), and decommission the old cluster (#2) | The old stack is gone |

### Backfill conversion
Per document → row (all lossless):
- `timestamp` (16-hex-digit ns) → `received_at timestamptz`. µs precision; the ns remainder is dropped, below the collectors' real clock precision.
- `coinbase1`, `coinbase2`, `prev_hash`, `extranonce1`, `merkle_branches[]` hex → `bytea` (branches concatenated in order). `version`, `nbits`, `ntime` hex → `bigint`. `lat_ms`/`lat_m` as-is.
- **Height is re-derived from `coinbase1`** with the fixed parser (#108), not copied. The stored value is wrong for templates whose push isn't 3 bytes.
- **Routing**, with the same rules as live ingest. A template goes to `templates_other` with a `reason` if any of these holds:
  - it has a `chain_family`
  - the height doesn't parse
  - the height is implausible against the Bitcoin tip *at that time*, i.e. `blocks` with `block_time <= received_at`: outside `[tip − 6, tip + 2]`

  Everything else goes to `templates`.
- `pool_name` → `sources` (one row per historical name; see "Collector site" below).
- **Dedup** on `(source_id, received_at, job_id)`. That covers the one-height overlap between backup increments, and any duplicates from collector reconnects.
- **Load:** `COPY` in day-sized batches, oldest first, into uncompressed chunks; the columnstore policy compresses them afterwards. The tool is resumable by day, so it can be stopped and restarted.
- **Expected time:** 136M rows at ~50–100k rows/s via `COPY` → about 30–60 min load, plus compression. To be measured on the section 3 sample.

### Verification
- **Exact, for the backfilled range:** per `(day, source)`, MongoDB document count = `templates` + `templates_other` rows + duplicates removed. Any mismatch is listed, not averaged away.
- **Byte-exact round trip:** for 10,000 random templates, re-encoding the row to hex reproduces the original MongoDB document field for field.
- **Routing report:** counts per `reason` in `templates_other`, with samples, reviewed by hand once (it also settles #98's "how many, which pools, which chains").
- **Parallel window (approximate):** per `(height, source)` template counts, old vs new collectors. These should be close but not identical (different network path, reconnect timing).
- **Read parity:** the R1–R11 queries return the same results on both backends for a sample of heights (scripted).

### Collector site
New collectors run from a different place on the network, so **absolute latency and first-seen times change at T0**. Comparisons between pools at the same height stay valid, because every pool is measured from the same site.
- Add **`sources.site`** (e.g. `old-cluster` for backfilled history, plus the new cluster's name), so analyses and charts can split or annotate at T0.
- Where the new cluster runs, and which region, is a decision in #1. Staying near the current location keeps timing data comparable; another region may have cheaper traffic but changes everyone's latency.

### Risks
| Risk | Mitigation |
|---|---|
| The backfill misses or corrupts data | Exact per-day counts, the byte-exact sample, and the old MongoDB kept as a cold copy |
| Read-path behavior changes (a page renders differently) | Dev on the new cluster first, plus scripted read parity |
| Postgres ingest falls behind in bursts (block found → all sources at once) | ~40 inserts/s peak is trivial for Postgres; the sink logs and counts failures without dropping into MongoDB code paths |
| Timing data discontinuity at T0 | `sources.site`, and an annotation in charts |
| A rollback after cutover loses data | During the soak the old collectors still write MongoDB, so nothing is lost by pointing DNS back |

### Slices (for #90)
1. Schema and migrations (dbmate), CNPG + TimescaleDB image, local docker-compose on Postgres
2. Collector Postgres sink (routing rules, `sources`)
3. Backend on Postgres
4. Web data layer on Postgres
5. Backfill + verification tool (`tools/mongo-to-postgres`), measured first on the section 3 sample
6. New-cluster deployment, parallel collection, backfill run, dev on the new cluster
7. Cutover, soak, retire
