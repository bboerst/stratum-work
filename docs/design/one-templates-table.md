# Design: one templates table, classification at read time

Status: **done** (2026-11-18), before the production cutover rather than after it, so the data is settled first. Steps (section 5): 1 the reads, with height windows (#237); 2 the collectors stop classifying (#238); 3 the rows moved (1,130,445, each batch checked by count and checksum; their write-time labels in `template_routing_labels`); 4 `templates_other`, its views and the `chain` type dropped, the "other chains" view judged at read time, and the backfill tool deleted. The rest of this document is the proposal as written, with its measurements.

**Recommendation: do it.** Store every received template in `templates`. Drop `templates_other`, and stop classifying in the collectors and the backfill. Height reads pass the height's **time window** (derived from `blocks`) as query parameters, so the planner can drop chunks by time. With that, one table reads as fast as today's Bitcoin-only table, even at production's chunk count. Without it, the lost height-based chunk skipping costs about 40 ms per height read at ~160 chunks, and that grows with history (section 4). The window is also what keeps stale and other-chain rows out of height reads, so it is part of the design, not an optional optimization (see "Why the window is required" below). Only one read gets slower: the "other chains" summary now scans the table instead of a 0.6 % side table. It defaults to the last 90 days, which keeps it around a second.

## 1. Why

Today two places decide, at write time, whether a template is Bitcoin's:
- the collectors: `collector/pgsink.py` `route()` and `collector-go` `chain.go` / `tip.go`;
- the backfill: `tools/mongo-to-postgres/m2p/convert.py`.

(These have since been removed: the Python collector, the collectors' classification and the backfill tool.)

The rule is that the height must be within ±6 of the collector's node tip at that moment. The collector also asks an external BCH block API about suspicious prev hashes. Bitcoin rows go to `templates`, and everything else goes to `templates_other` with a `chain` and a `reason`. Section 2 of [postgres-timescale.md](postgres-timescale.md) explains the split:
- no query could forget a chain filter;
- one far-off height (6,976,415) couldn't widen a chunk's height range and defeat chunk skipping.

The write-time judgement is the part that breaks, because it depends on state that is sometimes wrong:
- About 40k real Bitcoin templates were misfiled. The blocks index had gaps, and a collector kept a stale tip after a failed update ([#221](https://github.com/bboerst/stratum-work/pull/221)). They needed a re-route.
- About 1.1M rows filed as "implausible height" were real Bitcoin templates from a stuck feed re-sending old jobs.

Once a row is in the wrong table, fixing it takes a data migration.

The facts that settle the question are stored anyway: each template's `prev_hash` and `received_at`, and our `blocks` / `stale_blocks` with `seen_at`. A judgement made from them at read time corrects itself when the facts improve, for example when a gap in `blocks` is filled. MongoDB had one collection, too.

## 2. Design

**Storage.** `templates` is one hypertable and stays as it is today: partitioned by time, columnstore segmented by `source_id` and ordered by `(height, received_at)`, chunk skipping on `height` (harmless, though it no longer skips anything). Every template a collector can store goes in. `templates_other`, the `chain` enum and `reason` go away. No table, setting or background job is added.

**The collector stores what it received, nothing more:** no tip, no chain detection, no BCH API, no routing. That also removes the collector's dependency on a Bitcoin node, since RPC and ZMQ were used only for the tip.

Should the collector store the node tip it saw as an annotation? **No.** `blocks.seen_at` already gives the tip at any moment, from one place. A copy on every row would be redundant and could disagree with it.

**Classification at read time,** from stored facts only:

| Derived | Rule | Notes |
|---|---|---|
| **Bitcoin parent** | `prev_hash` is a block in `blocks` or `stale_blocks` | One view, `bitcoin_parents(prev_hash)`. It holds both block tables with each hash converted once per *block* into stratum's word order (`stratum_prev_hash_to_block_hash()` is its own inverse), so templates join it on the raw column. Converting per *template* instead was 43× slower (section 4). |
| **Unknown parent** | anything else | Either another chain, or a Bitcoin block we don't have. That can be a tip race (the block isn't stored yet), a gap in `blocks` (resolves when the gap is filled), or a block that lost a race before it reached our node. The prev hash alone can't tell these apart, and nothing below needs it to. |
| **Height window** | from the arrival of the block at `height − 1` to the arrival of the block at `height`, widened by 2 h on each side | Arrival is the earliest `seen_at` at that height, or `block_time` where `seen_at` is null (backfilled history). The 2 h is the consensus limit on how far ahead a header time may run, so the window also holds for header times. If the block at a bound isn't stored (a gap in `blocks`), that side uses the nearest stored block below or above instead, so the window widens but never opens. An open side would turn off both chunk exclusion and the stale filter at exactly the heights with gaps. |
| **Stale** | Bitcoin parent, received after its height's window | The stuck-feed case: an old job re-sent hours or days later. |

**BCH detection: drop it.** A BCH template has no Bitcoin parent, so it is an "unknown parent" like every other chain. The other-chains page already characterizes each pool's group (height range, prev hashes, AuxPoW share). A chain name would need per-chain knowledge (today an external API, called at ingest) for a label on a page that works without it. If a name is ever wanted, that page can derive it from stored facts, e.g. heights and `nbits`, without storing it.

**The one new constant** is the window's 2 h margin. Today's rule (tip ± 6 at receive time) is the same kind of constant, but it's applied at write time, where it can't be revisited.

**Passing the window.** The window must reach the planner as values: literals, or parameters of a custom plan. Only then are chunks outside it dropped before planning. Two things were tried and don't work (section 4):
- computing the window inside the query (stable functions, subqueries) still plans every chunk;
- filtering a view on `received_at` stops at the view's window functions.

**Why the window is required.** Without it, a read at `height = h` returns every row at that height, wherever it came from:
- stuck-feed rows, which carry the old height they were mined for and arrive hours or days later;
- another chain's templates whose heights pass through a past Bitcoin height (a chain a few thousand blocks behind Bitcoin today crosses heights Bitcoin had years ago).

The synthetic data covered the first case and the "Bitcoin + 5" collision, but not the second: its BCH-like chain sat below every synthetic block height. A plain one-table read without the window would change what height pages show, so the window is not optional.

So there are two pieces:
- `height_window(from_height, to_height)` → `(from_ts, to_ts)`: a small SQL function over `blocks`. Readers call it first, which is one indexed lookup.
- The two de-duplication views become inlinable SQL functions with the same body, plus a height range and a time range: `templates_copies(h1, h2, t1, t2)` and `templates_dedup(h1, h2, t1, t2)`. Postgres inlines them, so the bounds reach chunk exclusion (verified, section 4). The time range also does the stale filtering, before de-duplication, which is where it belongs.

### Reads

| Read | Today | One table |
|---|---|---|
| R1 / R8 templates at a height, R4 first seen per pool, backend analytics `templates_at_height` | `templates` / `templates_dedup` at `height = h` | Same SQL plus `received_at` within `height_window(h, h)`. Unknown-parent rows inside the window stay, as today; they are the "unknown tip" prev hashes of the fork visual. Collisions are no worse than today's ±6 rule, which also admits another chain's template whose height happens to be near Bitcoin's. |
| R2 template details, all chains | `templates_dedup ∪ templates_other_dedup` | `templates_dedup` with an open time range (no union) |
| Fork visual, `stale_tip_templates()` | `templates` by height range | Same, with the range's window; prev hashes are labelled from `blocks` / `stale_blocks` as today |
| Other chains page (`/api/other-chains`) | aggregate over `templates_other` | aggregate over `templates` where `NOT EXISTS (SELECT 1 FROM bitcoin_parents p WHERE p.prev_hash = t.prev_hash)`, plus a "stale Bitcoin" group, over the **last 90 days by default** (a longer range on request). The `templates_other_*` views and the single-/multi-source split in `other-chains.ts` go away. The cache stays at 5 minutes. |
| Live stream (browser) | drops templates the collector tagged with `chain_family` | The browser already knows the tip from the blocks stream and applies the same ±6 rule itself. This only affects display; nothing stored depends on it. |

## 3. What gets deleted

- **Collectors:**
  - Python: `collector/chain_detection.py` and its tests, the routing in `collector/pgsink.py`, and the tip state in `collector/main.py`.
  - Go: `collector-go/chain.go` and `tip.go` with their tests, and the classifier wiring in `main.go`.
  - The `--btc-*` / `--bch-*` flags, and the node RPC/ZMQ settings that only they needed.
  - That's about 1,900 lines including tests.
- **Backfill:** `TipIndex`, `DayTips`, `tip_for_route` and `route_converted` in `m2p/convert.py`, the `templates_other` columns of its day report, and the re-route job.
- **Schema:** `templates_other`, its columnstore policy, the `templates_other_copies` / `templates_other_dedup` views, the `chain` type, and the `templates_other` grants.
- **Web:** the `chain_family` handling (`templateBuffer.isBitcoinTemplate` becomes the window check), the `templates_other` half of R2, and the dual read in `other-chains.ts`.

## 4. Measurements

**Setup:**
- Throwaway `timescale/timescaledb:2.30.2-pg18` with every migration of `main` applied by dbmate, `timescaledb.enable_chunk_skipping = on`, on a 4-vCPU VM.
- Synthetic data for the 60 days up to now: 8,499 blocks at exponential 10-minute intervals.
- **13,988,037 Bitcoin templates** (~1,650 per height) from 40 sources, each refreshing every 10–30 s.
- **82,087 non-Bitcoin rows (0.58 %):**
  - 5 other chains, one template every 400 s each, at heights near 14k, 915k (BCH-like), Bitcoin + 5 (collides with Bitcoin heights at the same time), 6.98M and 23.0–23.6M;
  - 2 stuck feeds re-sending an old Bitcoin job every 20 s for 2 days.
- Compressed like production: 7-day chunks, columnstore after 2 days.

The variants:
- **A**, today: Bitcoin rows in `templates`, the rest in `templates_other`. The generator routes them, so the split is perfect.
- **B**, one table, naive: all rows in one table with the same settings.
- **C**, B plus the window computed in the query (`received_at >= height_window_start(h)` …, stable SQL functions). Chunks are then excluded at executor startup.
- **C′**, B plus the window passed as values (the design above).

**Chunk skipping is indeed defeated in B.** Every chunk's recorded height range is 14,000…23.4M, so the planner can't drop any of them. In A each weekly chunk has a tight range, e.g. 972,893…973,864.

**Classification is exact on this data:**
- Unknown parent = 64,805 rows = exactly the other-chain rows.
- Stale = 16,460 of the 17,282 stuck-feed rows. The other 822 arrived within 2 h of their height being mined, when the job was still current.
- Bitcoin parent and not stale = 13,988,859 = A's `templates` plus those 822.

**Queries.** Each figure is the median of 7 warm runs in one session (like a pooled connection), from `EXPLAIN (ANALYZE, BUFFERS)`, written as planning + execution time, with the chunks whose scan ran.

*7-day chunks (9 chunks):*

| Query | A | B | C |
|---|---|---|---|
| R1 all templates at a compressed height (~1,530 rows) | 0.4 + 26.8 ms, 2 chunks | 1.1 + 25.0 ms, 9 | 2.8 + 26.8 ms, 1 |
| R1 at a recent height (open chunk) | 0.1 + 0.2 ms, 1 | 0.9 + 1.6 ms, 9 | 2.7 + 1.4 ms, 1 |
| R4 first seen per source, compressed height | 0.2 + 1.3 ms | 0.9 + 2.6 ms | 2.4 + 3.2 ms |
| One day of heights (144), per height/source/prev_hash | 0.5 + 45.9 ms | 1.3 + 46.2 ms | 2.6 + 49.8 ms |
| Other chains summary, all time | 58 ms | **1,481 ms** | |
| Other chains summary, last 30 days | 11 ms | 936 ms | |
| Stale Bitcoin templates, all time | (mixed into `templates_other`) | 1,574 ms | |

*Same rows in 9-hour chunks (161 chunks).* This is about production's chunk count for ~3 years of weekly chunks. Wide columns were emptied to save disk; they don't affect the per-chunk cost.

| Query | A | B | C | **C′** |
|---|---|---|---|---|
| R1 compressed height | 0.5 + 6.5 ms, 7 chunks | 23.8 + 23.2 ms, 161 | 46.1 + 20.0 ms, 1 | **0.3 + 6.3 ms, 1** |
| R1 recent height | 0.3 + 0.3 ms | 25.4 + 18.2 ms | 46.5 + 14.3 ms | **0.2 + 0.2 ms** |
| R4 first seen, compressed height | 0.4 + 1.1 ms | 21.9 + 16.5 ms | 43.7 + 15.8 ms | **0.3 + 1.0 ms** |
| One day of heights | 0.9 + 41.4 ms, 10 chunks | 25.2 + 68.7 ms | 47.7 + 67.0 ms | **1.0 + 42.6 ms, 4** |
| A window function over the rows: SQL function with bounds vs. view filtered from outside | | | | **0.3 + 0.9 ms** vs 21.6 + 15.5 ms |

**Reading the numbers:**
- **With 9 chunks, B is within noise of A (~1–2 ms).** In a compressed chunk the columnstore keeps a B-tree on each batch's first/last height, so a chunk that can't match costs one index probe, not a scan.
- **With 161 chunks, B is not within noise: about +40 ms per height read** (half planning, half one probe per chunk), and it grows by about 0.25 ms per chunk as history accumulates.
- **C makes it worse.** Excluding at executor startup still plans every chunk and evaluates the functions for each.
- **C′ matches A, or beats it,** because the time window is narrower than a chunk's height range.
- **Plan modes for C′.**
  - The web queries through node-postgres `pool.query(text, values)` without a statement name (checked in `web/lib/db/postgres.ts`), so every plan is custom and gets the C′ numbers.
  - A cached generic plan (psycopg after 5 executions) excludes at startup instead: 0.1 + 10.2 ms. That's still 4× better than B.
- **The other-chains summary is the real cost:** a full scan of `prev_hash` instead of a 0.6 % table. It's linear in the rows scanned (30 days: 936 ms vs all time: 1,481 ms on 14M rows), so about 15 s over all 136M templates. That's why the page defaults to the last 90 days, about a second at production's current rate. The per-pool template pages stay cheap, since they filter on pool and receive time.
- **Classify the small side.** The first anti-join converted every template's hash (`stratum_prev_hash_to_block_hash(t.prev_hash) = b.block_hash`) and took 64 s. Converting the blocks instead (`bitcoin_parents`) took 1.5 s.

## 5. Migration (after the production cutover)

**Before step 1:** port the real `templates_copies` / `templates_dedup` bodies into the bounds-taking functions and check with `EXPLAIN` that a height read scans one chunk. Only a reduced function was verified (section 4). If Postgres declines to inline the real body, the bounds stop reaching chunk exclusion without any error, and reads go back to planning every chunk.

1. **Web and backend first,** reading both ways:
   - functions with windows for the height reads;
   - R2 without the `templates_other` union;
   - other chains from the anti-join;
   - the live filter in the browser.

   This works before and after the data move: until then `templates` simply has no non-Bitcoin rows, and the reads keep the `templates_other` part until step 4.
2. **Collectors:** deploy them without classification and routing. From then on every template lands in `templates`. Old collectors keep working in the meantime, because `templates_other` still exists.
3. **Move the rows:** per source and 7-day range, one transaction deletes them from `templates_other` and inserts them into `templates` (~1.13M rows), writing each row's `chain` and `reason` to `template_routing_labels` (migration `20261118000007`); then `compress_chunk()` on the chunks it touched. TimescaleDB recompresses only the touched segments (one source in one chunk each).
   - **Measured:** 82,087 rows into 8 compressed chunks took 57 MB of WAL for the insert and 129 MB for the recompression (2.6 s + 2.4 s), and left no partially compressed chunks.
   - **Production:** the insert scales with rows, about 0.8 GB for 1.16M. The recompression scales with the compressed size of the touched (source, chunk) segments; measure it before the move with `SELECT count(DISTINCT (source_id, time_bucket('7 days', received_at))) FROM templates_other`.
   - Run it one chunk's time range at a time, with a `COMMIT` and a pause between, so WAL archiving keeps up and `PostgresWALArchiveBacklog` doesn't fire.
4. **Drop** `templates_other`, its policy, views and grants, and the `chain` type, in the same migration after a check that the rows moved equal the rows in `templates_other`. Then delete the code listed in section 3.

**Rollback:**
- Steps 1–2 are code deploys, rolled back by redeploying.
- Step 3 moves each batch in one transaction (the rows deleted from `templates_other` are the rows inserted into `templates`, checked by count and checksum), so a row is never in both tables. The collector's write-time `chain` and `reason` of every moved row are kept in `template_routing_labels`, keyed by the template's `(source_id, received_at, job_id)`. Until step 4, reverting means moving the labelled rows back.
- After step 4 the old split can't come back without a classifier. That's intended.
