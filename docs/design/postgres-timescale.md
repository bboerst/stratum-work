# Design: MongoDB → Postgres + TimescaleDB

Tracking: #90 (epic). Status: **in progress**. Sections 1–2 drafted; 3–5 follow.

1. [Current data access](#1-current-data-access) ✅
2. [Schema](#2-schema) ✅ (draft; final choice after section 3)
3. Measurements on real data (size per day, query latency)
4. Backups and recovery (WAL archiving, PITR, restore drills)
5. Migration plan

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
| `sources` | table | ~40 | One per collector endpoint (today's `pool_name`). `smallint` id. |
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

### Not decided here
- **Tooling:** plain-SQL migrations with [dbmate](https://github.com/amacneil/dbmate) in `db/migrations/`, applied by an init Job. Web keeps Prisma, introspected with `prisma db pull`; Timescale DDL stays in SQL. Python uses psycopg 3. To confirm when implementing.
- **Retention:** keep everything (current behavior). The columnstore makes that cheap; section 3 gives the per-year cost.
- **Licensing:** columnstore compression is in TimescaleDB's TSL-licensed features, which are free to self-host and run in your own product, but can't be offered as a hosted database service. The `timescale/timescaledb` image includes it, so contributors' local setups work unchanged.
- **Continuous aggregates** for #94 windows (per-source features per time bucket): designed with that epic, on top of `templates`.
