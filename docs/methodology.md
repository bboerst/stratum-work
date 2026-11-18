# How the data is measured

stratum.work connects to mining pools as a miner would and records every block template a pool sends (its Stratum
`mining.notify` messages). People draw conclusions about how pools build blocks from this data, so this page explains
what each value is, how it was taken, and where its limits are.

It describes the current code in Postgres mode: the Go collector (`collector-go/`), the backend, the mempool recorder
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
- [Other chains](#other-chains)
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

## Other chains

Some pools serve other chains (for example Bitcoin Cash) on the same connections. The collector stores every template
it receives in `templates`, without judging which chain it belongs to. That judgement used to be made at receipt,
against our node's tip at that moment, and it went wrong whenever the tip was stale or our block index had a gap; a
misfiled row then needed a data migration. It's now made when templates are read, from stored facts only: whether a
template's previous block hash is one of our stored blocks, and whether it arrived within its height's time window
(derived from when the blocks at that height and the one below arrived). That way another chain's template, or an old
job re-sent long after its block, isn't shown as a current Bitcoin template, and the judgement corrects itself when
the stored facts improve ([design](design/one-templates-table.md)). Templates filed under the old rule are in
`templates_other` until they're moved back.

## First transaction fee rate

The fee rate shown for a template's first transaction is that transaction's own fee divided by its size
(**observed**), from our Bitcoin node's record of its mempool.

When another transaction spends it and pays a higher rate (child pays for parent), a `+child` marker appears; hover it
for the child's combined rate (**modelled**). That number assumes the pool selected transactions the way Bitcoin Core
does and saw the same mempool our node saw, so it's shown beside the own rate rather than instead of it.

Only the first transaction can be identified from a template: the merkle path reveals its id and commits to the rest
without revealing them. See [first_transaction](first_transaction.md).

## Older history

Templates recorded before mid-November 2026 came from an earlier collector (`collector/`, Python):

- Their times were taken by that program right after reading from the network, not by the kernel.
- Before January 2025 they were taken slightly later still, after the message was parsed.

They were converted as recorded, in UTC, and checked for time-zone shifts; none were found. Treat millisecond-level
differences in that period with care.
