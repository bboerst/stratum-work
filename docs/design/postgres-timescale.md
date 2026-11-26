# Design: MongoDB → Postgres + TimescaleDB

> Historical: MongoDB, the Python collector (`collector/`) and Prisma have since been removed, and every component is Postgres only. This document describes the system as it was when written.

Tracking: #90 (epic). Status: **ready for review**. All five sections are drafted, and section 3 is measured on real production data.

1. [Current data access](#1-current-data-access) ✅
2. [Schema](#2-schema) ✅ (candidate A chosen in section 3)
3. [Measurements on real data](#3-measurements-on-real-data) ✅
4. [Backups and recovery](#4-backups-and-recovery)
5. [History migration](#5-history-migration) ✅

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
| R12 | backups (deployment) | `mining_notify` by `height >=` *h*; full and incremental dumps | Backups | Periodic |

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

Full DDL: [`postgres-timescale/schema.sql`](postgres-timescale/schema.sql) (candidate A, chosen in section 3), for **Postgres 18 + TimescaleDB 2.30**. It loads cleanly into `timescale/timescaledb:2.30.2-pg18`, and was tested functionally (below).

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
| `templates_rejected` | table | small, bounded per source | Quarantine (#105): messages a pool sent that couldn't be stored as a template (undecodable, over a decoding limit, malformed `mining.notify`, not storable losslessly), with `stage`, `reason`, the raw message (≤ 256 KiB), its length and SHA-256. A per-source hourly budget caps it; after that, rejections are counted. Odd but storable templates are not here. |
| `ingest_events` | table | small | Episodes worth analyzing (#105): `burst` (a pool sending templates far faster than normal: start/end, templates, peak per second, distinct job ids and prev hashes, per-second counts; written in 10-minute segments) and `sink_overflow` (a collector's queue dropped templates). The templates of a burst are stored as usual. |
| `sources` | table | ~40 per site | One per collector endpoint (today's `pool_name`) per collection `site` (section 5). `smallint` id. |
| `blocks` | table | ~129k, +144/day | Keyed by `block_hash`, so fork blocks at the same height can coexist. New `seen_at` column. `analysis` stays `jsonb` (analytics plug-ins write free-form results). |
| `pools` | table | 172 | mining-pools list. GIN index on `addresses`. |
| `mempool_txs` | hypertable, partitioned by `first_seen`, 1-day chunks | ~500k/day | Mempool recorder (#180, `mempool-recorder/`): one row per stay of a transaction in the node's mempool: first seen, txid/wtxid (`bytea`, internal byte order, comparable to `merkle_branches`), sizes, fees, ancestor/descendant stats, input count, and when and why it left (`mined`, `replaced`, `conflict`, `reorg`, `expired`, `evicted`, `unknown`). Unique `(txid, first_seen)`; GiST on `tstzrange(first_seen, removed_at)` for "mempool at time t"; partial index on open rows. Columnstore after 15 days (past `-mempoolexpiry`, so compressed rows never change), ordered by `(removed_at, first_seen)`, bloom filter on `txid`. |
| `mempool_tx_inputs` | hypertable, 1-day chunks | ~1.1M/day | One row per input (prevout txid + vout) of each `mempool_txs` row. **Kept forever**, like `mempool_txs` (a 30-day retention policy until #329): the recorder needs inputs only while a tx is in the mempool (≤ 14 days, reloaded from here after a restart), but the resolver, spend analyses (CPFP, conflict chains) and decoding a template's transaction order need every transaction's parent links. A deployment that ran with the old policy has inputs only from 30 days before this migration on. Columnstore after 2 days, bloom filters on `txid` and `prevout_txid`. |
| `mempool_tx_raw` | hypertable, 1-day chunks | 0 unless `--store-raw` | Raw transactions; columnstore after 1 day, dropped after 14 days. |
| `mempool_blocks`, `mempool_offmempool` | tables | +144/day; a few per block | Block connects/disconnects as the recorder saw them, and per block the transactions that were never in our mempool (position in the block). |

### Why partition by time but look up by height
Every read is by height, but partitioning by height would let other chains' and parse-failure heights (6,976,415, 0) create stray chunks, and would make time windows (#92, #94) awkward. Instead:
- **Partition by `received_at`,** with **`enable_chunk_skipping('templates', 'height')`**. TimescaleDB records each compressed chunk's min/max height, and the planner excludes chunks that can't match.
- **Order compressed data by `(height, received_at)` within each source.** Each 1,000-row batch carries its min/max height, so only matching batches are decompressed.
- **This only works if `templates` holds sane heights.** One 6,976,415 row would widen its chunk's range and defeat skipping. That's another reason for `templates_other`.

**Verified** with 151k synthetic rows, 7 chunks (6 compressed). `WHERE height = 902000` scanned **1 compressed chunk** (filtering batches on `_ts_meta_v2_first/last_height`) plus the current uncompressed chunk, and **skipped the other 5**. Chunk skipping requires the server setting `timescaledb.enable_chunk_skipping = on`. The planner reads it too, so in production it belongs in the Postgres config (CloudNativePG `spec.postgresql.parameters`).

### Ingest rules (collector)
1. **Parse the BIP34 height correctly:** read the push length from `script[0]` and decode that many bytes. Today's parser reads a fixed `script[1:4]` (#98).
2. **Route each template:**
   - **`templates`:** the parse succeeded, the collector's chain classifier doesn't flag it (`bch`/`unknown`), and, when the collector knows our tip, `tip − 6 ≤ height ≤ tip + 6` (it was `tip + 2`; pools are regularly ahead of our node by two or more blocks right after blocks, which misfiled real templates).
   - **`templates_other`:** everything else, with `reason`: `height_parse_failed`, `bch`, `unknown_chain`, or `height_implausible`.
   - **Without a node configured** (contributors' local setups), parsed templates go to `templates`. That's today's behavior.
3. `sources` upsert at collector startup. Inserts are single-row: ~1.4/s average, bursts of a few dozen per second when a block is found. That's trivial for Postgres, so no batching is needed.

### Candidates to measure (section 3)
| | Merkle branches | Expected trade-off |
|---|---|---|
| **A** | Inline `bytea` column (n × 32 bytes) | Simplest writes and reads. Relies on columnstore compression catching repeats within a source's batch. |
| **B** | `merkle_set_id bigint` → `merkle_branch_sets` (dedup by sha256) | One upsert per new set on write and a join on read. Saves space if sets repeat, and **gives cross-pool equality for free**: two sources pointing at the same set id is a strong shared-template-source signal for #94, and an index for #95. |

Coinbase parts stay inline in both: coinbase outputs change with fees, so they're mostly unique per template. **Decision (section 3): A.** B's set table was larger than what it saved: 1.47 templates per set. Cross-pool equality is cheap to compute on demand.

### Current reads in the new schema
| # | SQL |
|---|---|
| R1, R8 | `SELECT … FROM templates_dedup WHERE height = $1` (Bitcoin by construction; the chain filter is gone). Exact copies from secondary collector replicas hidden, see below |
| R2 | R1, plus `UNION ALL … FROM templates_other_dedup WHERE height = $1` only if the details page should keep showing non-BTC templates (decision for #98) |
| R3 | `SELECT … FROM blocks WHERE (analysis - 'pool_identification') <> '{}' ORDER BY height DESC LIMIT 200`: **index-only scan** on the partial index (verified), replacing today's full `$expr` scan |
| R4 | `SELECT DISTINCT ON (source_id) source_id, received_at, latency_ms FROM templates WHERE height = $1 ORDER BY source_id, received_at` (verified) |
| R5, R6, R9 | `blocks` by `height` range or equality (`blocks_height` index), or by `block_hash` (PK). Today these are unindexed 128k-document scans. |
| R7, R11 | `pools`: by name, all, or `addresses @> ARRAY[$1]` (GIN) |
| R10 | `SELECT block_hash FROM blocks ORDER BY height DESC` |
| R12 | Replaced by WAL archiving + base backups (section 4). No more dump-based incrementals. |

### Redundant collection: one stream per pool
With several collectors per pool (`sources.replica`, and sites in several regions), each template is stored once per connection that saw it. Some pools send every connection the same jobs; others give each connection its own job stream (other merkle branches, or the same job with another `ntime`). Hiding only exact copies (migration `20261115000001_templates_dedup.sql`) showed such a pool with about twice its templates: both streams. Migration `20261116200001_one_stream_per_pool.sql` makes the views show **one connection's stream per pool**, filled in from another connection only while that one had nothing. Nothing is deleted or altered: every row stays in `templates` and is classified in `templates_copies`.

- **Source order and primary.** A pool's (`sources.name`) sources are ranked by `(site, replica)`, compared byte-wise (`COLLATE "C"`, the order the live stream uses too). At each height the lowest-ranked source with rows there is the primary. The order is stable and decided by the names: to make a site the primary, give it the name that sorts first. Per height, so a height the usual primary missed entirely (collector down) is served by the next source.
- **Every primary row is shown as stored.** Re-sends (same job, new `ntime`) and any other change stay separate rows. With one source per pool the views return exactly the raw rows.
- **Exact copies are hidden** (`class = 'copy'`): a secondary row with the same height, pool, `prev_hash`, `merkle_branches`, `version`, `nbits` and `ntime` as a primary row, with no tolerance. Matching is one-to-one: per source, the copies of a key are numbered in that source's own receive order (`copy_no`), and a secondary's *n*-th copy hides only the primary's *n*-th.
- **Another connection's stream is hidden** (`class = 'secondary_stream'`): any other secondary row received while a *lower-ranked* source of the pool was active, i.e. has a row at that height received from `template_stream_silence()` (90 s) before to `template_stream_lead()` (10 s) after it. This uses only the receive times of that source's own rows, never template fields.
- **Gap fills are shown** (`class = 'gap_fill'`, `is_primary = false`): secondary rows received while every lower-ranked source was silent (collector down, connection lost, reconnecting). If replica `a` is down for five minutes, `b`'s rows from 90 s after `a`'s last row until 10 s before its next one are shown. With three sources, the third is shown only while the first two are both silent.
- **Why these windows.** Most pools refresh work on a timer, so a connection that is up usually gets a job well within 90 s, and a source with no row for more than 90 s is taken to have had no data. That is an assumption, not a guarantee: some pools go longer than 90 s between jobs, and one job often reaches our connections at different times (for many pools by more than the clock error, for some by over 100 ms), so "quiet on every connection together" is inferred. Over 545 blocks all 45 gap fills fell during a disconnect or restart of the primary; a small rate of wrong fills can't be excluded. Outages shorter than that aren't filled, because the pool's next job supersedes what was missed. A pool that is normally quieter than 90 s between jobs would show a few secondary rows in its quiet gaps; these appear as `gap_fills` in the report. At a new block every connection gets the new job within milliseconds to a few seconds of the others, in no fixed order. So a secondary's row up to 10 s before the primary's first row of the height belongs to that moment, not to an outage. Each window is one SQL function, so it can be changed in one place, together with `STREAM_SILENCE_MS` in `web/lib/streamDedup.ts`. Connection events aren't recorded (`ingest_events` has bursts and queue overflows only), so activity is judged from the rows themselves.
- **`primary_match`** keeps how a secondary row relates to the primary's rows at that height: `copy`, `extra` (the primary has that exact template, but fewer times), `near_miss` (the same job with another `ntime`) or `other_job`. `source_rank` and `active_rank` (the lowest-ranked source active around the row) show why it was hidden or shown.
- **Times.** `first_seen` = the earliest `received_at` over a primary row and its exact copies; `received_at` stays the row's own. `site_first_seen` (jsonb `{site: earliest received_at at that site}`) keeps each region's own time. `copies`, `replicas` and `sites` say who saw it.
- **Multi-site (regions).** The rule is the same across sites. Copy matching never compares clocks: it uses identical fields and per-source order. The activity window compares receive times across sources, so clock skew between sites shifts the window's edges by the skew, which is milliseconds against 90 s. For timing by region use `site_first_seen` or `templates_copies`, not `first_seen`, which mixes geographies.
- **Live stream.** `web/lib/streamDedup.ts` applies the same rule as messages arrive. A template is forwarded only if no lower-ranked source of the pool sent anything in the last 90 s, and exact copies are forwarded once. It can't look ahead, so it shows a secondary's templates right up to the primary's return, where the views hide those within 10 s before it. It also judges activity across heights, where the views judge it per height with the 10 s lead covering the new-block moment.
- **Views.** `templates_copies` holds every row, classified (`primary`, `copy`, `secondary_stream`, `gap_fill`). `templates_dedup` holds the rows to show (`primary` and `gap_fill`). The `templates_other_*` views do the same for `templates_other`, with `chain` in every copy key. Filters on height (or a height range, or pool) reach the height index and the columnstore's height metadata, at the cost of three sorts of that height's rows. Without a height filter the views read the whole table.
- **Reads.** R1, R2 and R8 read `templates_dedup` / `templates_other_dedup`, with `timestamp` = `first_seen` and the template `id` keeping the row's own receive time. R4 (first seen per pool) keeps reading `templates`: it is the earliest moment any connection to the pool got work for the height. That can be earlier than the shown rows when another connection's own job arrived first, and the pool did send it then. R4b is a set of names, which copies can't change. Block and pool reads are unaffected. Backend analytics (`templates_at_height`) read the raw rows of every collector, not the view, because an anomaly that only one collector received must still be analyzed. Each row carries its collector's `site` / `replica`; the invalid-coinbase analysis pairs exact copies one-to-one per collector, so a copy doesn't count twice. Prev-hash divergence groups pools into sets, so copies can't change it. MongoDB mode keeps one collector per pool.

**How to see what it does.** `template_dedup_report(from_ts, to_ts)` returns, for Bitcoin templates received in the window, one row per UTC day, pool and site, plus `site IS NULL` for the pool's total:
- rows, primary rows and secondary rows;
- `secondary_hidden` = `exact_copies` + `secondary_stream`, and `secondary_shown` = `gap_fills`;
- for the secondary rows that aren't exact copies, hidden or shown: `extra_copies` and `near_misses` (with `near_miss_ntime_1s` / `_2s` / `_3s` / `_4_10s` / `_over_10s`, the |ntime difference| to the closest primary row of the job). A pool with per-connection jobs shows a high `secondary_stream` and near-miss count, and few exact copies;
- first-seen gains with `gain_ms_p50` / `_p95` / `_max`. For the total, that's shown primary rows whose `first_seen` came from an earlier copy. Per site, it's that site's copies that arrived before the primary row.

`exact_copies` and `secondary_stream` are the last two columns, so readers of the earlier columns keep working. Heights are classified whole, so copies just outside the window still count as matched. `tools/replica-compare` includes the same table in its Markdown and JSON output.

```sql
-- yesterday, pool totals
SELECT * FROM template_dedup_report(date_trunc('day', now()) - interval '1 day', date_trunc('day', now())) WHERE site IS NULL;
-- one height: what was hidden and why, with per-site times of the shown rows
SELECT pool, site, replica, class, primary_match, source_rank, active_rank, received_at, first_seen
  FROM templates_copies WHERE height = 925000 ORDER BY pool, received_at;
SELECT pool, class, copies, sites, site_first_seen FROM templates_dedup WHERE height = 925000 AND copies > 1;
```

### Database users and credentials (from day one)
Every component gets its own least-privilege login; no shared admin account, and no passwords in manifests:
- **Least-privilege roles:**
  - `collector` (INSERT on `templates`/`templates_other`/`templates_rejected`/`ingest_events`, upsert on `sources`)
  - `backend` (read `templates`, `templates_rejected` and `ingest_events`, write `blocks`/`pools`)
  - `web` (read-only)
  - `migrator` (DDL, used only by the migration Job)
  - backups use CNPG's own replication/streaming credentials
- **Credentials only via Secrets**, generated by the database operator or the deployment's tooling, with no passwords in manifests or values files. Tools get credential-free connection strings, with the password supplied separately, so errors can't print it.
- No superuser access from applications.

### Not decided here
- **Tooling:** plain-SQL migrations with [dbmate](https://github.com/amacneil/dbmate) in `db/migrations/`, applied by an init Job. Web keeps Prisma, introspected with `prisma db pull`; Timescale DDL stays in SQL. Python uses psycopg 3. To confirm when implementing.
- **Retention:** keep everything (current behavior). The columnstore makes that cheap; section 3 gives the per-year cost.
- **Licensing:** columnstore compression is in TimescaleDB's TSL-licensed features, which are free to self-host and run in your own product, but can't be offered as a hosted database service. The `timescale/timescaledb` image includes it, so contributors' local setups work unchanged.
- **Continuous aggregates** for #94 windows (per-source features per time bucket): designed with that epic, on top of `templates`.

---

## 3. Measurements on real data

**Sample:** one day of production history (2026-11-12, heights 975,359–975,517), restored into a throwaway MongoDB. That's **130,620 templates from 29 sources over 1.17 days**, plus all 128,702 blocks. It was loaded into both candidates on **TimescaleDB 2.30.2 / Postgres 18** by a prototype of the migration tool ([`measure/`](postgres-timescale/measure/)), which does height re-derivation (#108), routing, lossless conversion, dedup and `COPY`. Everything ran on a 4-vCPU VM.

### Lossless and correct
- **Hex fields:** 0 of 130,620 templates have upper-case or odd-length hex. Every `prev_hash` is 32 bytes and every `version`/`nbits`/`ntime` 4 bytes. **`bytea`/`bigint` storage is lossless.**
- **Byte-exact round trip:** 10,000 random templates re-encoded from Postgres; **10,000 match** the original documents field for field.
- **Duplicates:** 0 duplicate templates on `(source, received_at, job_id)`. **1 duplicate block** (the same hash stored twice at height 949,837; MongoDB has no unique index), so the migration de-duplicates blocks on `block_hash`. No real forks: no height has two different hashes.

### Routing (`templates` vs `templates_other`)
| | Templates | Share |
|---|---|---|
| `templates` (Bitcoin) | 129,822 | 99.39% |
| `templates_other`: `unknown_chain` (the collector already flags these) | 319 | 0.24% |
| `templates_other`: `height_implausible` (outside tip−6…tip+2 at receive time; **not** flagged today) | 479 | 0.37% |

So the explicit routing catches **2.5× more** non-Bitcoin templates than today's `chain_family` flag (#98).

### Size
Same 1.17 days, compressed with the production settings (segment by source, order by height + time):

| | Templates | Separate table | **Total** |
|---|---|---|---|
| MongoDB (WiredTiger, snappy) | 232.7 MiB BSON → 100.3 MiB, plus 6.5 MiB indexes | — | **106.8 MiB** |
| **A: branches inline** | 117 MB → **45 MB** (2.6×) | — | **45 MB** (**2.4× smaller** than MongoDB) |
| B: deduplicated branch sets | 68 MB → 13 MB (5.2×) | 51 MB (`merkle_branch_sets`, row-store) | 64 MB |

**Candidate A is chosen.** Branch sets barely repeat: 88,211 distinct sets in 129,822 templates (1.47 per set), because pools refresh transaction selection constantly. B's lookup table costs more than it saves. B's one advantage, a key for "the same branch set across pools", is cheap on demand in A (below).

**Projection** (A, ~361 bytes per compressed template):
| | Size |
|---|---|
| Today's history (136M templates) | **≈ 41–49 GB** (vs. 103 GB in MongoDB) |
| Growth at today's rate (~123k templates/day) | **≈ 40 MB/day ≈ 15 GB/year** |
| Uncompressed hot data (last 2 days, before the columnstore policy) | ≈ 0.2 GB |
| `blocks` (incl. `analysis` JSON) | ≈ 0.1 GB |

**Sizing:** about **100 GB per Postgres instance** covers today's data, ~3 years of growth, WAL and compression headroom.

### Query latency
Median of 7 runs, warm cache, candidate A compressed, vs. the same data in MongoDB with production's indexes (`mining_notify`: `_id`, `height`; `blocks`: `_id` only).

| Query | Postgres + Timescale | MongoDB |
|---|---|---|
| R1: all templates at a height, all columns (549 rows) | 18.1 ms | 13 ms |
| R2: templates at a height, 3 columns, both tables | 0.65 ms | — |
| R4: first-seen per source (28 sources) | **0.85 ms** | 2 ms |
| R4b: sources present at h−1 (#104 reliability) | 0.30 ms | — |
| R3: interesting blocks (latest 200) | **0.04 ms** | 109 ms |
| R5: latest 20 blocks (block-strip polling) | **0.02 ms** | 47 ms |
| R6: block by height | **0.01 ms** | 40 ms |
| One source, last 6 h (time window) | 1.7 ms | — |
| Sources sharing an identical branch set at a height (72 found) | 9.2 ms | — |

- **R1 is the one query that's slower:** it decompresses every large `bytea` column for one batch per source. 18 ms is acceptable (the web layer caches per height), and reading only the needed columns makes it sub-millisecond (R2).
- **Block queries go from tens of milliseconds to microseconds,** because `blocks` finally has indexes.
- **Not exercised here:** chunk skipping across many weekly chunks. The sample spans 2 chunks; section 2's synthetic test covers that.

### Load throughput (for the migration, section 5)
`COPY` from a single Python process, conversion included: **~41–49k rows/s** → **≈ 50 minutes for 136M templates**, before parallelizing by day.

---

## 4. Backups and recovery

Backups, recovery and restore drills belong to the production deployment, which is managed in a separate repository. The database image they rely on is `postgres/` (Postgres 18 + TimescaleDB for CloudNativePG, built by CI).

## 5. History migration

The history (about 136M templates since June 2024) was converted from the MongoDB backups into Postgres, while new collectors wrote to Postgres from **T0**, the first template they received. The rules below are how every historical row was derived, so they are part of the dataset's provenance.

### Backfill conversion
Per document → row (all lossless):
- `timestamp` → `received_at timestamptz` (µs precision; the ns remainder is dropped, below the collectors' real clock precision). **History has two formats, and the converter handles both** (and BSON datetimes, defensively):
  - **ISO-8601 without a timezone,** for heights up to 880,228. **Parse as UTC.**
  - **16-hex-digit nanoseconds** from `time.time_ns()`, from height 880,227 onward (both formats appear at 880,227–880,228).
- **Timezone correction: detected from the data, not from fixed height thresholds.** There may have been a period when timestamps were recorded with a timezone that was later removed. Findings so far:
  - **Verified on production (2026-11-12), no systematic shift:**
    - *Against block header times:* sampled boundary heights, plus every 50th height across the ISO range. 669 heights, 519,691 templates, all naive ISO, none with a timezone suffix, **0 outliers**.
    - *Against each template's own `ntime`* (the pool's header time, ≈ wall-clock UTC): **667 of 669 heights at 0 h.** No −6 h / −7 h range exists.
    - *The two exceptions are single heights with positive offsets:* **867,946 (+12 h)** and **872,096 (+94 h)**. Those are templates received long after their `ntime`, i.e. stale or replayed jobs, or other-chain heights colliding with Bitcoin's, **not** a timezone shift. Routing sends them to `templates_other` (`height_implausible`, since the height is far behind the tip at receive time).
  - **The history starts around height 846.8k** (June 2024). A single stray template at 824,246 sits far below the rest.
  - Part of the earlier suspected 6 h / 7 h (MDT/MST) offset was a **parsing artifact**: Python's `datetime.fromisoformat(s).timestamp()` treats a timezone-less string as the *machine's local time*. Scripts should parse with `.replace(tzinfo=timezone.utc)`.
  - **Converter rules:**
    - parse strings **with** a timezone suffix by their suffix
    - parse naive strings as UTC
    - per height, if the first template sits a consistent −6 h / −7 h (±30 min) from the preceding block's time, apply that correction to the height's naive-ISO templates, and **log it** (height, offset, count) in a migration report, with the offset recorded per row in `received_at_offset_s`
    - never apply a blanket height-threshold offset
- `coinbase1`, `coinbase2`, `prev_hash`, `extranonce1`, `merkle_branches[]` hex → `bytea` (branches concatenated in order). `version`, `nbits`, `ntime` hex → `bigint`. `lat_ms`/`lat_m` as-is.
- **Height is re-derived from `coinbase1`** with the fixed parser (#108), not copied. The stored value is wrong for templates whose push isn't 3 bytes.
- **Routing**, with the same rules as live ingest. A template goes to `templates_other` with a `reason` if any of these holds:
  - it has a `chain_family`
  - the height doesn't parse
  - the height is implausible against the Bitcoin tip *at that time*, i.e. `blocks` with `block_time <= received_at`: outside `[tip − 6, tip + 6]` (the live collectors' window; it was `tip + 2`). Header times can be minutes *after* a block really arrived (seen on dev data: two consecutive blocks 2–3 min late made the next height's first templates look like tip + 3). So the tool also counts a block as known once any template has built on it (its `prev_hash`): `tip(t) = max(header-time tip, highest known block built on by t)`.

  Everything else goes to `templates`.
- `pool_name` → `sources` (one row per historical name; see "Collector site" below).
- **Dedup** on `(source_id, received_at, job_id)`. That covers the one-height overlap between backup increments, and any duplicates from collector reconnects.
- **Load:** `COPY` in day-sized batches, oldest first, into uncompressed chunks; the columnstore policy compresses them afterwards. The tool is resumable by day, so it can be stopped and restarted.
- **Expected time:** measured with `tools/mongo-to-postgres` on 325k real-shaped templates (4-vCPU VM, MongoDB and Postgres on the same machine): ~20k docs/s per worker, end to end, and ~53k docs/s with 4 workers → **about 45 min for 136M templates**, plus building a `timestamp` index on the restore, plus compression.

### Known gaps in the history
- **Collection outage:** blocks **876,882–876,902**, i.e. template heights 876,883–876,903. No templates are expected there. Verification reports these heights as a known gap, not as missing data.

### Verification
- **Exact, for the backfilled range:** per `(day, source)`, MongoDB document count = `templates` + `templates_other` rows + duplicates removed. Any mismatch is listed, not averaged away.
- **Byte-exact round trip:** for 10,000 random templates, re-encoding the row to hex reproduces the original MongoDB document field for field.
- **Routing report:** counts per `reason` in `templates_other`, with samples, reviewed by hand once (it also settles #98's "how many, which pools, which chains").
- **Parallel window (approximate):** per `(height, source)` template counts, old vs new collectors. These should be close but not identical (different network path, reconnect timing).
- **Read parity:** the R1–R11 queries return the same results on both backends for a sample of heights (scripted).
- **Timestamp sanity, every height:** first template minus block(h−1) header time stays within minutes, per timestamp format. This catches any mis-parsed timezone (a ±6–7 h outlier) or a clock problem. The sampled check already passed on production for both formats.

### Collector site
New collectors run from a different place on the network, so **absolute latency and first-seen times change at T0**. Comparisons between pools at the same height stay valid while every pool is measured from the same site. Since 21 November 2026 collection runs at two sites, so `first_seen` can come from either; compare by site with `site_first_seen`.
- Add **`sources.site`** (e.g. `old-cluster` for backfilled history, plus each collection site's own name), so analyses and charts can split or annotate at T0.
