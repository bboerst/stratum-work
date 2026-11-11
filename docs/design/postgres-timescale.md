# Design: MongoDB → Postgres + TimescaleDB

Tracking: #90 (epic). Status: **in progress**. Section 1 is complete; sections 2–5 follow.

1. [Current data access](#1-current-data-access) ✅
2. Schema (candidates and decision)
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
