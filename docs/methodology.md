# How the data is measured

stratum.work connects to mining pools as a miner would and records every block template a pool sends (its Stratum
`mining.notify` messages). People draw conclusions about how pools build blocks from this data, so this page explains
what each value is, how it was taken, and where its limits are.

It describes the current code: the collector (`collector-go/`), the backend, the mempool recorder
and the web app. Changes to how something is recorded, stored or shown update this page in the same change. Field-level
details are in the other files in [`docs/`](./).

- [Kinds of values](#kinds-of-values)
- [What is recorded](#what-is-recorded)
- [Arrival times](#arrival-times)
- [Clocks](#clocks)
- [Latency adjustment](#latency-adjustment)
- [Which templates belong to a height](#which-templates-belong-to-a-height)
- [Several connections per pool](#several-connections-per-pool)
- [Blocks](#blocks)
- [Unknown parents](#unknown-parents)
- [First transaction fee rate](#first-transaction-fee-rate)
- [Older history](#older-history)

## Kinds of values

Every value is one of three kinds:

- **Observed:** recorded as received. The bytes a pool sent, the time they arrived, a fact our Bitcoin node reports
  (for example a transaction's fee and size).
- **Verified:** reconstructed and proven by a commitment. For example, a list of transactions that reproduces a
  template's merkle path is that template's transaction list, not a guess.
- **Modelled:** depends on an assumption, which is stated wherever the value is shown. For example, the latency
  adjustment assumes the network path is equally fast in both directions.

Stored data is never rewritten. Judgements such as "which pool was first" or "is this a duplicate" are made when the
data is read, from the stored facts, so they can be recomputed and checked.

Two derived results are stored, for speed, and recomputed rather than trusted:
- **Per-block analyses** (`blocks.analysis`: the fork and invalid-coinbase flags, and the coinbase parse record) are
  computed when a block is stored. When a check changes, they are recomputed over every stored block
  (`python -m coinbase_reanalysis` for the coinbase checks). History converted from the earlier database has no fork
  flag, so a block without one is not evidence that there was no fork; the fork view reads the templates themselves.
- **The unknown-parents summary** (`unknown_parent_pools`) is kept up to date after each block and rebuilt from
  the templates with `python -m unknown_parents --backfill`.

Both are made only from stored facts, so recomputing them gives the same answer from the same data.

## What is recorded

- Every `mining.notify` is stored losslessly: the hex fields as bytes, the numbers as numbers, so re-encoding gives
  back what the pool sent. Re-sends are kept too.
- A message that can't be stored as a template (malformed JSON, missing fields, oversized lines) is kept in a
  quarantine (`templates_rejected`) with the reason, not dropped.
- Unusual moments are recorded as events (`ingest_events`): bursts of templates, any template the collector had to
  drop because storage fell behind, each time a collector starts, and every connection to a pool (when it connected
  and subscribed, how many templates it delivered, and why it ended). So a gap in the data can be told apart from a
  pool that sent nothing.

## Arrival times

A template's time (`received_at`) is when its bytes arrived at the collector (**observed**). It is the operating system
kernel's receive timestamp for the network data that carried it (`SO_TIMESTAMPNS`), stored to the microsecond. A kernel
stamp isn't delayed by what the collector program happens to be doing, so busy moments don't shift it.

Limits:

- When several templates arrive in one read, they share that read's timestamp.
- Where kernel timestamps aren't available, the collector falls back to its own clock right after the read. Which of
  the two a template got isn't yet recorded with it.

## Clocks

An arrival time is only as good as the clock that took it. The collector machines keep their clocks in step with
nearby stratum-1 time servers using chrony, which also reports how far off the clock might be. The worst-case error is

```text
|offset| + root dispersion + root delay / 2
```

On the collector machines that bound is typically around 5 ms, and the clocks are measured continuously.

Since 18 November 2026 the data also records which machine received each template: each collector process writes an
`ingest_events` `start` row with its machine, and a template's machine is the one in the latest `start` row of its
source at or before its `received_at`. So a timing comparison between two templates can be tied to the clocks behind
it. Two templates stamped by the same machine share its clock, so its error cancels out of the difference between
them.

Limits: across different machines, differences smaller than the clocks' error bounds (a few milliseconds) aren't
meaningful.

## Latency adjustment

A template arrives some time after the pool sent it. The timing views can subtract an estimate of that delay (the
**Latency adjusted** setting, on by default, per view), so pools at different network distances can be compared
(**modelled**). The stored `received_at` is never changed; the adjustment is applied when the data is shown.

The estimate (`latency_ms`) is half the connection's round-trip time as measured by the kernel (`tcp`), or by timing
Stratum requests on proxied connections (`app`); see [latency_tracking](latency_tracking.md). Halving it assumes the path
is equally fast both ways, which can't be checked from one end. What is certain is a window:

```text
received_at - round trip  <=  when the pool sent it  <=  received_at      (give or take the clock error)
```

Half the round trip is the middle of that window, so the adjusted time can be off by up to half the round trip.

Limits:

- The round trip is measured to whatever ends the connection on the pool's side, which may be a proxy rather than the
  server that builds the job.
- It is refreshed about once a minute, not per template.
- Templates without an estimate are shown unadjusted. Turn the setting off to see arrival times exactly as recorded.

## Which templates belong to a height

A template's height alone doesn't make it part of that height's race. A pool's stuck feed can re-send an old job
hours later at its old height, and another chain's heights can pass through a height Bitcoin had long ago. What a
template's **receive time** does say: work for height h is received after the block at h - 1 arrives and before
the block at h arrives. So reads of the templates at a height keep only the rows received in that window, from our
stored blocks: from the arrival of the block at h - 1 to the arrival of the block at h, widened by 2 hours on each
side (the consensus limit on how far ahead a block header's time may run). At a height without a stored block the
nearest stored ones are used, so the window widens but never opens; at the height being mined now it is open-ended.

The window is a judgement made at read time from stored facts: nothing is moved or deleted, and the template details
page still shows every row at a height, whenever it was received.

## Several connections per pool

Each pool can be collected over more than one connection, from separate machines, so a dropped connection or a
restart doesn't leave a gap. Some pools send every connection its own job stream, so showing all of them would double
that pool's templates. The views show one connection's stream per pool, and another connection's templates only while
that one had nothing, for example during a reconnect.

A template is treated as a duplicate only when it matches exactly, field for field, with no tolerance. Nothing is
deleted: every hidden template is kept and classified with the reason it was hidden, and a pool's "first seen" time is
the earliest arrival over all its exact copies. The rules are in `db/migrations/20261116200001_one_stream_per_pool.sql`.

## Blocks

A block's seen time (`blocks.seen_at`) is when our Bitcoin node announced it to the backend, taken the moment the ZMQ
announcement arrived (**observed**, `seen_via = 'zmq'`).

- A block our node didn't announce, but which was found later when the stored chain was checked against the node's
  (after a reorganisation or an outage), is marked `seen_via = 'reconcile'`. Its time is only when it was found.
- Blocks loaded from older history, or filled in later, have no seen time.
- The block stored as "the block at a height" must be the one on our node's best chain. Recent heights are checked
  after every block; every height in the stored history is checked once a day, because a history backfill can carry
  a block that lost a race (it was briefly the tip where it was recorded) while the winner is missing. A block that
  replaces such a block is stored without a seen time: it was found long after it arrived, so the detection time
  would pass for an arrival time. The replaced block stays stored and is marked stale, not deleted.
- Before 18 November 2026 the seen time was taken when the block had been processed and saved, typically 0.6 to 1
  second after it arrived (median 0.84 s). Those rows have `seen_via` NULL and run late by about that much.

A block's header time is set by the miner and can be minutes off, so it isn't used as an arrival time.

A block's header facts (transaction count, size, weight, version, merkle root, bits, nonce, difficulty) are what our
Bitcoin node reports for it (**observed**): from the full block when the backend stores it, or, for blocks stored
before these were recorded, from the node's block header. A header has no size or weight, so those stay empty for
older blocks whose full data the node no longer keeps.

To link a block to the work it was built from, the backend also stores the block's coinbase merkle path (the same
shape as a template's `merkle_branches`), its coinbase txid and, for blocks it stores from now on, its coinbase
transaction. All of these are self-checked against the node's data before they are stored: the path must hash the
coinbase txid to the block's merkle root, and the coinbase must hash to its txid. `block_template_matches(h_from, h_to)`
compares them with the stored templates at read time:

- **Full match (verified):** every branch equal. The template carried exactly the block's transactions, in order.
  It identifies the job's transaction set, not who mined it: pools that build from the same mempool in the same way
  can send identical sets, so every matching pool is listed next to the block's own identification.
- **Coinbase checks:** whether the block's coinbase starts with the template's `coinbase1` and ends with its
  `coinbase2`, and whether the bytes between them are exactly the template's extranonce length (the pool's own
  coinbase layout). Many pools put per-connection bytes into the coinbase, so these mark how close the match is
  rather than being required.
- **Partial match (match depth k):** the first k branches agree, so the first 2^k - 1 transactions after the
  coinbase are identical; a similarity, not proof.
- An empty block has no branches, so every empty template "matches" it: that proves nothing. A block without a
  stored path is unknown, and one whose path no stored template shares had its job never sent to our connections (or
  sent after the last one we stored).

Stale blocks (blocks that lost a race, `stale_blocks`) are known two ways, and each row records which
(`header_source`):

- **From our node** (`node`, **observed**): every branch our node's `getchaintips` reports besides the active chain,
  walked back to where it forks, with the node's header for each block and, when the node downloaded it, the full
  block. A block our node had as its tip until a reorganisation is marked `was_active` and linked to the reorg.
- **From the public stale-blocks dataset** (`bitcoin-data/stale-blocks`, **verified**): blocks our node never had,
  because they lost before reaching it or are older than stale-block tracking, can still be proved by the templates:
  pools built on them. When templates from at least two pools at one height build on a previous block we don't know,
  that is a Bitcoin block we never stored. The [stale-blocks dataset](https://github.com/bitcoin-data/stale-blocks)
  (public domain, CC0; [doi:10.5281/zenodo.22667157](https://doi.org/10.5281/zenodo.22667157)) collects stale
  headers and blocks observed on the Bitcoin network. Its headers are proven here by commitment: the templates name
  the block's hash, and the header must hash to it. A header from it is stored only if every check passes: it
  hashes to the dataset's hash and to the hash the templates built on; the hash meets the proof of work its `bits`
  claim, within Bitcoin's limit, and those `bits` equal our best block's at the same height (where we have them); it
  builds on our best block at the height below; its height is the templates' height minus one; and our best block
  at that height is a different block. A full block from the dataset must parse exactly, carry that header, and its
  transactions must hash to the header's merkle root; its coinbase, size, weight and pool are then filled like our
  node's. A parent seen from only one pool is accepted only when the dataset has it, under the same checks. Such a
  row has status `not-in-node` (no status of our node applies), is never `was_active`, and its `first_seen` is the
  earliest template built on it: when we first had evidence of the block. A dataset entry that fails a check is
  reported and not stored. The importer is `backend/stale_import.py`; every candidate and every rejection is in its
  summary.

## Unknown parents

Some pools serve other chains (for example Bitcoin Cash) on the same connections. The collector stores every template
it receives in `templates`, without judging which chain it belongs to. That judgement used to be made at receipt,
against our node's tip at that moment, and it went wrong whenever the tip was stale or our block index had a gap; a
misfiled row then needed a data migration. It's now made when templates are read, from stored facts only: whether a
template's previous block hash is one of our stored blocks, and whether it arrived within its height's time window
(derived from when the blocks at that height and the one below arrived). That way another chain's template, or an old
job re-sent long after its block, isn't shown as a current Bitcoin template, and the judgement corrects itself when
the stored facts improve ([design](design/one-templates-table.md)). The templates filed under the old rule were moved
back into `templates`; what the old rule decided for each of them is kept as a fact in `template_routing_labels`.

The "Unknown parents" view looks at templates whose previous block is no block we know (neither in `blocks` nor
recorded in `stale_blocks`), over the last 6 or 26 difficulty epochs (12,096 or 52,416 blocks) or all history. It
groups them by that parent into
**episodes**: one unknown parent, the
height its templates build, the pools that built on it and on which of their connections (labelled a, b, … in each
pool's (site, replica) order, so a letter always names the same connection), when the first and last template
arrived, and how many templates (a template seen on several of a pool's connections counts once, and only as an exact
copy). Work on a stale Bitcoin block we recorded is Bitcoin work and is shown with the stale blocks, not here.

Counting that per request would mean reading months of templates (all history takes about a minute), so the backend
keeps a summary, `unknown_parent_pools`: one row per unknown parent and pool with **counted facts only**, the
de-duplicated template count, the first and last receive time, how many carry a merge-mining commitment, which
connections received them, and the templates per height and per `nbits`. It never stores a kind or any other
judgement. Whether a parent is still unknown is checked each time the table is read, so a parent that is later
recorded as a block or a stale block (for example from the public stale-blocks dataset) drops out of the page with no
cleanup, while its row stays as true as the templates it counts. Each row is recomputed from all of the parent's
stored templates, never added to, so it can always be checked against `templates`; the web's Postgres tests compare
it field for field with the live read of templates that the page used before the table existed.

After each new block (once the block is stored) the backend recomputes every unknown parent of the last two hours'
templates, starting where its previous run ended if that was longer ago, and once over the last seven days after
the startup sync (`backend/unknown_parents.py`). Each parent is read whole: the read covers the heights and receive
times of its templates seen now plus those already in the table, an hour wider, so a parent that lasts longer than
two hours keeps all its templates. History before that, or after a longer outage, comes from the backfill
(`python -m unknown_parents --backfill`, in 7-day chunks). The ranges are counted in Bitcoin time, in blocks below
our tip (the highest best-chain block), not in days: an episode is in a range when its last template arrived at or
after the best-chain block N blocks below the tip did (`coalesce(seen_at, block_time)`); it is shown with all its
templates even if it began before the range. The timeline's axis is block heights too. Another chain's templates
carry that chain's heights, so an episode is placed by our tip when its first and last templates arrived (the
heights being mined then), read per episode as `tip_at_first` and `tip_at_last`; dates are only shown on hover.
Until the table has rows, the default view reads templates directly, over the last 90 days, as it did before.

What each parent is gets **inferred** when the page is read, never stored, from these facts (`web/lib/parentKind.ts`):

- **Bitcoin's difficulty**: whether the templates' `nbits` equal the `bits` of our best-chain block at height − 1
  (at a difficulty retarget height, the block at the height itself, since the template's target is the new
  period's). Unknown when we store no Bitcoin block there.
- **Distance from our tip**: height − 1 minus the highest best-chain block that had reached us by the first template.
- **Proof of work**: the parent hash, read as a 256-bit number, is at or below the target encoded by Bitcoin's `bits`
  at height − 1 (or by the templates' own `nbits` when no Bitcoin block is stored there).

The rules, in order:

1. **Another chain**: the difficulty isn't Bitcoin's, or it is unknown and the height is more than one block from our
   tip. This comes before the proof-of-work check on purpose: another chain's block at a lower difficulty fails
   Bitcoin's target, and would otherwise look like an invalid Bitcoin parent.
2. **Unrecorded Bitcoin block**: Bitcoin's difficulty (or unknown difficulty right at our tip) and the hash meets the
   target. Work at Bitcoin's target can't be faked, so this is a real block our node never recorded: a block that
   lost a race (many pools for a few minutes) or a pool's own block that lost (one pool). It can also be a block mined
   seconds before the page was computed, before we stored it: the page is recomputed every 5 minutes, so such an
   episode stays listed until then. Once its header is imported from the public stale-blocks dataset (see
   [Blocks](#blocks)) the parent is a known block and the episode leaves this view.
3. **Invalid parent**: Bitcoin's difficulty (or unknown difficulty at our tip), but the hash misses the target: not a
   valid block at all.
4. **Undetermined**: no stored block to compare with at all.

Each episode on the page shows these facts next to the inferred kind, and its details show every template from its
pools around its minutes, each labelled by the parent it built on (our best chain, a stale block, this unknown parent,
or another one), with the arrival of the blocks at height − 1 and at the height.

## First transaction fee rate

The fee rate shown for a template's first transaction is that transaction's own fee divided by its size
(**observed**), from our Bitcoin node's record of its mempool.

When another transaction spends it and pays a higher rate (child pays for parent), a `+child` marker appears; hover it
for the child's combined rate (**modelled**). That number assumes the pool selected transactions the way Bitcoin Core
does and saw the same mempool our node saw, so it's shown beside the own rate rather than instead of it.

Only the first transaction can be identified from a template: the merkle path reveals its id and commits to the rest
without revealing them. See [first_transaction](first_transaction.md).

## Older history

Templates recorded before mid-November 2026 came from an earlier collector (`collector/`, Python, since removed):

- Their times were taken by that program right after reading from the network, not by the kernel.
- Before January 2025 they were taken slightly later still, after the message was parsed.

They were converted as recorded, in UTC, and checked for time-zone shifts; none were found. Treat millisecond-level
differences in that period with care.

**Extranonce values before January 2025 can be stale.**
- **The cause.** That collector took `extranonce1` and `extranonce2_length` only from the response to its first request (JSON-RPC id 1). Whenever it reconnected without restarting (keep-alive reconnects and retries, from June 2024 on), the new subscribe had a different id. Templates from the new connection kept the previous connection's values. This was fixed in January 2025 (#26).
- **The effect.** When the new connection's extranonce sizes differed, `coinbase1 + extranonce1 + extranonce2 + coinbase2` no longer forms a valid transaction. A scan of every feed, sampling the first 15 s of each hour from June 2024 to November 2026, found this for a few feeds between July 2024 and February 2025, and only for isolated templates after that. When the sizes matched, the stored `extranonce1` is simply the old connection's, and nothing in the data reveals it.
- **What it doesn't affect.** The coinbase outputs sit in `coinbase2` and are unaffected.
- **How the analysis handles it.** Every template's coinbase is reassembled and parsed strictly: exactly one input spending nothing, at least one output, no bytes missing or left over. If the stored `extranonce2_length` doesn't produce such a transaction, every other length from 0 to 16 is tried, and the coinbase is used only if exactly one length works. Nothing is inferred beyond that. Each block's analysis records, per pool, how many templates needed another length (`coinbase_parse.repaired`) and how many parsed with none (`coinbase_parse.unparsed`, not checked further), so these cases stay visible instead of being dropped.
