# How the data is measured

Words as defined in the [glossary](glossary.md).

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
- [What changed between templates](#what-changed-between-templates)
- [Blocks](#blocks)
- [Forks](#forks)
- [Template providers](#template-providers)
- [First transaction fee rate](#first-transaction-fee-rate)
- [Reported hashrate](#reported-hashrate)
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
- **The unknown- and stale-parents summaries** (`unknown_parent_pools`, `stale_parent_pools`) are kept up to date
  after each block and rebuilt from the templates with `python -m unknown_parents --backfill` and
  `python -m stale_parents --backfill`.

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
- Each template carries the `extranonce1` and `extranonce2_length` in force on its connection when it arrived, so its
  coinbase can be rebuilt as `coinbase1 + extranonce1 + extranonce2 + coinbase2`. They come from the subscribe in the
  handshake; a later `mining.set_extranonce` replaces them for the templates after it (invalid values are ignored).
  Every change is an `extranonce` event with the old and new values. A response to the collector's own re-subscribe
  (latency probe, keep-alive) with other values is recorded the same way but not applied: the first subscription is
  assumed to stay in force, and these events check that assumption. Some pools answer every re-subscribe with the
  same other values, so a response that repeats the last one recorded on the connection is not recorded again.

## Arrival times

A template's time (`received_at`) is when its bytes arrived at the collector (**observed**). It is the operating system
kernel's receive timestamp for the network data that carried it (`SO_TIMESTAMPNS`), stored to the microsecond. A kernel
stamp is meant not to be delayed by what the collector program happens to be doing, so busy moments shouldn't shift
it; this is not yet checked against an independent stamp.

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

On the collector machines that bound has a median of about 6 ms per machine and a 99th percentile of up to about 16 ms;
the largest measured so far is under 20 ms. The clocks are measured continuously.

Since 18 November 2026 the data also records which machine received each template: each collector process writes an
`ingest_events` `start` row with its machine, and a template's machine is the one in the latest `start` row of its
source at or before its `received_at`. So a timing comparison between two templates can be tied to the clocks behind
it. Two templates stamped by the same machine share its clock, so its error largely cancels out of the difference
between them, unless the clock was stepped between them.

Limits: across different machines, differences smaller than the two clocks' error bounds added together (typically
about 11 ms, up to about 36 ms) aren't meaningful.

## Latency adjustment

A template arrives some time after the pool sent it. The timing views can subtract an estimate of that delay (the
**Latency adjusted** setting, on by default, per view), so pools at different network distances can be compared
(**modelled**). Tested on the same template's copies received at two network distances, for most testable pools the
adjustment moved the copies closer together, but brought them within the clock error for only a few, and many pools
couldn't be tested. The stored `received_at` is never changed; the adjustment is applied when the data is shown.

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
- A template shown at its first-seen time (the earliest of its exact copies on the pool's connections, see below) is
  adjusted with the estimate of the connection that received that copy, never another connection's. If that copy has
  no estimate, the template is shown unadjusted.

## Which templates belong to a height

A template's height alone doesn't make it part of that height's race. A pool's stuck feed can re-send an old job
hours later at its old height, and another chain's heights can pass through a height Bitcoin had long ago. What a
template's **receive time** does say: work for height h is received after the block at h - 1 arrives and before
the block at h arrives. So reads of the templates at a height keep only the rows received in that window, from our
stored blocks: from the arrival of the block at h - 1 to the arrival of the block at h, widened by 2 hours on each
side (a margin borrowed from the consensus limit on how far ahead a block header's time may run; not measured for
template arrival). At a height without a stored block the
nearest stored ones are used, so the window widens but never opens; at the height being mined now it is open-ended.

The window is a judgement made at read time from stored facts: nothing is moved or deleted, and the template details
page still shows every row at a height, whenever it was received.

## Several connections per pool

Each pool can be collected over more than one connection, from separate machines, so a dropped connection or a
restart doesn't leave a gap. Some pools send every connection its own job stream, so showing all of them would double
that pool's templates. The views show one connection's stream per pool, and another connection's templates only while
that one had nothing, for example during a reconnect.

"Had nothing" means no template from that connection in the previous 90 seconds. Some pools go longer than 90
seconds between templates, and one template often reaches our connections at different times: for many pools by more
than the clock error, for some by over 100 ms. That a quiet pool is quiet on all our connections together is
inferred, not measured. Measured over 545 blocks, all 45 filled-in templates fell during a disconnect or a restart of
the shown connection; a small rate of wrong fills can't be excluded.

A template is treated as a duplicate only when it matches exactly, with no tolerance, on its height, pool,
`prev_hash`, `merkle_branches`, `version`, `nbits` and `ntime`. An empty template has no transaction set to compare,
so two exact copies of one can be two templates built independently (for example by two of a pool's servers); first
seen takes the earliest. Nothing is deleted: every hidden template is kept and classified with the reason it was
hidden, and a pool's "first seen" time is the earliest arrival over all its exact copies: when the earliest of our
connections got it, not when the pool sent it. Since 21 November 2026 our connections are at two sites, so first seen
can come from either; `site_first_seen` keeps each site's own. The rules are in `db/migrations/20261116200001_one_stream_per_pool.sql`.

## What changed between templates

The timing chart labels each template with what changed since the pool's previous template. It is a judgement made
when the data is read, from the **observed** bytes: two templates are compared field by field.

What is compared:

- **Every `mining.notify` field** except the job id. Fields are first normalised the way the collector stores them (hex
  case, `clean_jobs` truthiness), so a live template compares equal to the same template read back from history.
- **The coinbase, field by field,** from its byte map (the parser behind the template details):
  - the transaction's version, sequence, locktime and witness;
  - the scriptSig's merge-mining commitment, text tag, pushed time, other pushed data and push layout;
  - every output's value and script;
  - every OP_RETURN, including ones whose protocol isn't known. A protocol that appears twice is compared copy by copy,
    and a change of order is a change of output structure.
- **Not the scriptSig's classification.** If the scriptSig's bytes are equal, nothing in it is reported, even if the
  parser files a byte differently in the next template (for example a pushed time that leaves the window around nTime).
- **A coinbase that doesn't parse,** on either side, is compared as a whole and reported only as "other coinbase
  change". No field value is guessed.
- **Not the extranonce bytes.** They belong to our connection and the miner, not to the template. A new `extranonce1` is
  reported on its own, as a new connection session (a reconnect).

Templates are compared in each pool's own receive order (for history reads, the shown connection's receive time, not
the first-seen time of a copy). Latency-adjusted time is not used: adjusting each copy by its own latency estimate
could swap two templates the pool sent in sequence.

`clean_jobs` is false on most templates: 1–8% of each pool's templates set it, over 4 hours of production data. Every
template that sets it is marked, including two in a row. Going back to false is not a change.

When a template shows no change:

- **Not compared:** these templates are not compared; hover one to see which case it is.
  - a pool's first template since the chart started;
  - a template after templates may have been missed, until a history read covers it: the live stream skipped part
    of a burst, the page was paused or hidden, the stream reconnected, or it is the first live template after the
    history loaded at page load. Two neighbouring templates are compared only when one continuous observation saw
    both: one run of the live stream, or one history read. Two assumptions, not yet recorded facts (#312): each
    collector writes a connection's templates in receive order, so a read that has a template has every one before it;
    and the live stream has every template between the gaps it reports (under overload the collector's publisher can
    drop messages without the page knowing). A new stream connection starts with the
    templates the server's consumer received in the last 20 seconds (plus each pool's one before), so at page load
    the stream overlaps the history read, which is a few seconds behind. After a gap the page reads history again a
    few times over the next 45 seconds, which fills in what was missed and proves the rest; a gap older than that
    read covers stays unproven;
  - a template from another of our connections than the pool's previous one: some pools give each connection its own
    jobs, so the difference would be between connections;
  - a template received out of order.
- **Compared:** only when the content is identical, or when `clean_jobs` went back to false.

Over 2 hours of production templates (27,132 consecutive pairs), every pair whose content differed reported a change,
and no identical pair did. Some changes happen on almost every template and are left off the bars (hover for them):
nTime, output values, the witness commitment, the text tag, the scriptSig's pushed time and other data, and the `OCB1`
OP_RETURN. Most pools write a fresh nonce or clock value into every job; the `OCB1` output, which one pool writes after the
extranonce, changes on every job too.

The rules are in `web/utils/templateChangeDetection.ts`, tested in `web/utils/__tests__/templateChangePrecision.test.ts`.

## Pools excluded from the live site

A pool can be excluded from the live site (`POOL_BLACKLIST`): its live work is not served. That is the realtime stream,
the realtime pre-fill, every template above our tip (the work being handed out right now) on any route, and the
height page's template table at any height (each template in full, as the realtime table shows them). Its history is:
at heights at or below our tip, every analysis view includes it like any other pool (the height page's first seen and
fork timeline, Forks, template providers, the blocks it mined, stale blocks). The boundary is per template
height against our tip (`filterBlacklistedAboveTip`, `web/lib/poolBlacklist.ts`); while the tip is unknown,
the pool is left out of every height (fail closed). The web's Postgres tests check it over every API route
(`pgExclusionInvariant.test.ts`): no live work of an excluded pool in any response, and every place its history appears
listed with its reason.

## Blocks

A block's seen time (`blocks.seen_at`) is when our Bitcoin node announced it to the backend, taken the moment the ZMQ
announcement arrived (**observed**, `seen_via = 'zmq'`).

- A block our node didn't announce, but which was found later when the stored chain was checked against the node's
  (after a reorganisation or an outage), is marked `seen_via = 'reconcile'`. Its time is only when it was found.
- Blocks loaded from older history, or filled in later, have no seen time.
- The block stored as "the block at a height" must be the one on our node's active chain. Recent heights are checked
  after every block; every height in the stored history is checked once a day, because a history backfill can carry
  a block that lost a race (it was briefly the tip where it was recorded) while the active chain's block is missing. A block that
  replaces such a block is stored without a seen time: it was found long after it arrived, so the detection time
  would pass for an arrival time. The replaced block stays stored and is marked stale, not deleted.
- Before 18 November 2026 the seen time was taken when the block had been processed and saved, about 1 s after
  it arrived (median 0.84 s in one sample). Those rows have `seen_via` NULL and run late by about that much.

A block's header time is set by the miner and can be minutes off, so it isn't used as an arrival time.

A block's mining pool is identified when the block is stored, from its coinbase against the public pool list of that
time (**inferred**: a pool's addresses and tags are its claim, not proof). The name stays as identified: a later list
that renames a pool, or moves an address to another pool, doesn't rewrite it, because the name is the attribution at
the time. Only a block still "Unknown" is filled in when a newer list identifies it (for example a pool tag added to
the list later).

A block's header facts (transaction count, size, weight, version, merkle root, bits, nonce, difficulty) are what our
Bitcoin node reports for it (**observed**): from the full block when the backend stores it, or, for blocks stored
before these were recorded, from the node's block header. A header has no size or weight, so those stay empty for
older blocks whose full data the node no longer keeps.

To link a block to the work it was built from, the backend also stores the block's coinbase merkle path (the same
shape as a template's `merkle_branches`), its coinbase txid and its coinbase transaction. Blocks stored before these
were recorded get them from the node, which prunes old blocks; a pruned block can be downloaded again from peers
(`getblockfrompeer`) and checked the same way. Blocks not filled yet have none of them, or only the path and txid. All of these are self-checked against the node's data before they are stored: the path must hash the
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
  because they lost before reaching it or are older than stale-block tracking, can still be found through the templates:
  pools built on them. A previous block we don't know is stored only when the public dataset has it and it passes the
  checks below. Several pools building on it doesn't by itself prove it was a block (work has been seen on parents
  that are not blocks): a parent that templates from at least two pools build on but the dataset doesn't have is only
  reported, not stored. The [stale-blocks dataset](https://github.com/bitcoin-data/stale-blocks)
  (public domain, CC0; [doi:10.5281/zenodo.22667157](https://doi.org/10.5281/zenodo.22667157)) collects stale
  headers and blocks observed on the Bitcoin network. Its headers are proven here by commitment: the templates name
  the block's hash, and the header must hash to it. A header from it is stored only if every check passes: it
  hashes to the dataset's hash and to the hash the templates built on; the hash meets the proof of work its `bits`
  claim, within Bitcoin's limit, and those `bits` equal the active chain's block's at the same height (where we have them); it
  builds on the active chain's block at the height below; its height is the templates' height minus one; and the
  active chain's block at that height is a different block. A full block from the dataset must parse exactly, carry that header, and its
  transactions must hash to the header's merkle root; its coinbase, size, weight and pool are then filled like our
  node's. A parent seen from only one pool is treated the same way. Such a
  row has status `not-in-node` (no status of our node applies), is never `was_active`, and its `first_seen` is the
  earliest template built on it: when we first had evidence of the block. A dataset entry that fails a check is
  reported and not stored. The importer is `backend/stale_import.py`; every candidate and every rejection is in its
  summary.

## Forks

Some pools serve other chains (for example Bitcoin Cash) on the same connections. The collector stores every template
it receives in `templates`, without judging which chain it belongs to. That judgement used to be made at receipt,
against our node's tip at that moment, and it went wrong whenever the tip was stale or our block index had a gap; a
misfiled row then needed a data migration. It's now made when templates are read, from stored facts only: whether a
template's previous block hash is one of our stored blocks, and whether it arrived within its height's time window
(derived from when the blocks at that height and the one below arrived). That way another chain's template, or an old
job re-sent long after its block, isn't shown as a current Bitcoin template, and the judgement corrects itself when
the stored facts improve ([design](design/one-templates-table.md)). The templates filed under the old rule were moved
back into `templates`; what the old rule decided for each of them is kept as a fact in `template_routing_labels`.

The "Forks" page shows every template built on a parent other than the active chain's block, over the last 6 or 26 difficulty
epochs (12,096 or 52,416 blocks) or all history, grouped by that parent into **episodes**: one parent, the height its
templates build, the pools that built on it and on which of their connections (labelled a, b, … in each pool's (site,
replica) order, so a letter always names the same connection), when the first and last template arrived, and how many
templates (a template seen on several of a pool's connections counts once, and only as an exact copy). A parent is
either a **stale block we recorded** (in `stale_blocks` and not reorged back in; kind `stale`, a fact) or **no block
we know** (neither in `blocks` nor in `stale_blocks`; its kind is inferred, below).

Templates on a recorded stale block are counted per block: the templates at its height + 1 whose previous block is
that block and that arrived inside that height's time window, de-duplicated like the rest (their merge-mining template share
isn't counted: it would mean reading every coinbase). The backend keeps these counts in `stale_parent_pools`, the
twin of the unknown parents' summary below (`backend/stale_parents.py`): one row per stale block and pool, counted
facts only, recomputed whole from the stored templates (never added to) for every stale block whose height window
overlaps the last hours (new templates can only arrive inside it, and its window moves when blocks at its heights
arrive) or that has no row yet (a block recorded since, also from the public dataset or by the active-chain check);
`python -m stale_parents --backfill` recomputes every stale block, also after a block stored late at an old height
(the gap fill) has moved an old window. Whether a block is still stale
is checked each time the page is read, so a block reorged back in drops out with no cleanup. The web's Postgres tests
compare the table field for field with the direct read of templates, which the page uses while the table is empty.
Its episode shows the block's height, how its header reached us and, when identified, its miner (also when that pool
is excluded from the site: which pool mined a block is history, not realtime work).

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
two hours is meant to keep all its templates. History before that, or after a longer outage, comes from the backfill
(`python -m unknown_parents --backfill`, in 7-day chunks). The ranges are counted in Bitcoin time, in blocks below
our tip (the highest active-chain block), not in days: an episode is in a range when its last template arrived at or
after the active-chain block N blocks below the tip did (`coalesce(seen_at, block_time)`); it is shown with all its
templates even if it began before the range. The strip above the list is in block heights too. Another chain's templates
carry that chain's heights, so an episode is placed by our tip when its first and last templates arrived (the
heights being mined then), read per episode as `tip_at_first` and `tip_at_last`; dates are only shown on hover.
Until the table has rows, the default view reads templates directly, over the last 90 days, as it did before.

What each unknown parent is gets **inferred** when the page is read, never stored, from these facts
(`web/lib/parentKind.ts`):

- **Bitcoin's difficulty**: whether the templates' `nbits` equal the `bits` of our active-chain block at height − 1
  (at a difficulty retarget height, the block at the height itself, since the template's target is the new
  period's). Unknown when we store no Bitcoin block there.
- **Distance from our tip**: height − 1 minus the highest active-chain block that had reached us by the first template.
- **Proof of work**: the parent hash, read as a 256-bit number, is at or below the target encoded by Bitcoin's `bits`
  at height − 1 (or by the templates' own `nbits` when no Bitcoin block is stored there).

The rules, in order:

1. **Another chain**: the difficulty isn't Bitcoin's, or it is unknown and the height is more than one block from our
   tip. This comes before the proof-of-work check on purpose: another chain's block at a lower difficulty fails
   Bitcoin's target, and would otherwise look like an invalid Bitcoin parent.
2. **Unrecorded block**: Bitcoin's difficulty (or unknown difficulty right at our tip) and the hash meets the
   target. Work at Bitcoin's target can't be faked, so this is a block hash with Bitcoin-level work that our node
   never recorded. Nothing more is shown: neither a rival block nor whether it was valid. It may have lost a race, or
   never reached the network. It can also be a block mined
   seconds before the page was computed, before we stored it: the page is recomputed every 5 minutes, so such an
   episode stays listed until then. Once its header is imported from the public stale-blocks dataset (see
   [Blocks](#blocks)) the parent is a recorded stale block and the episode's kind becomes `stale`.
3. **Invalid parent**: Bitcoin's difficulty (or unknown difficulty at our tip), but the hash misses the target: not a
   valid block at all.
4. **Undetermined**: no stored block to compare with at all.

An episode that began before our first stored block (collection started part-way through that height) has no tip and
no stored block to compare with. It is left out of the page and counted in the API response (`before_first_block`).

**Rows and races.** The page lists **races** rather than episodes: a race is counted once per fork point, not once per
block, so a branch two blocks deep is one row. Episodes are joined into one race only on a recorded fact: a recorded
stale block whose parent is another episode's recorded stale block, or two recorded stale blocks at one height with
the same parent. Nothing is joined on heights or times alone, so the next block of a branch we never recorded (its
parent unknown to us) stays a row of its own. Every other episode is a row of its own. The page counts only races our
feeds built on: a stale block that no feed of ours built on isn't in it (see [Blocks](#blocks) for the public list).
Above the list, every row of all history is a square in the column of the difficulty epoch it began in; the list
below follows the chosen range.

**A row's timeline** (`/api/forks/timeline`, `web/lib/forkLanes.ts`) is the fork chart of its height, the same chart
as the height page's: every feed's templates at that height, coloured by the parent each built on, with a line where
each block at height − 1 and at the height reached our node. Where that wasn't recorded (blocks from before the
node's arrival times were, and a stale block known only from the stale-block records, whose time is when it was first
recorded), the line is dashed and drawn where our feeds first built on the block: its first template as a parent, at
the height for a block at height − 1 and at the next height for a block at the height. Not the header time: the miner
sets it, and it can be minutes off (at 971,187 it was 89 s after our feeds were already building on the block). The
compressed axis never folds over a block's line.
The row reads it thin: one stream per pool (the de-duplicated templates), as runs, each starting where a pool's
parent changes, its work turns invalid or valid, or its templates turn empty or full. An **empty template** (no
merkle branches: the coinbase only) is drawn as a thin bar; it is a fact about the template, not about the block it
builds on, so it says nothing about why the pool sent it (invalid work, always empty, keeps its full rose bar). The
read covers the height's time window widened to the row's episodes, since a feed can stay on a losing parent for
hours. Each pool's last run ends when that pool first worked on the next height, or at its own last template when we
saw none there: silence isn't drawn as work. These ends, like the switches, are what the chart's compressed time axis
keeps in view. Each block of the race is listed with the pools whose first work at that height was on it, and an
arrow on a pool that also built on another block; a block no pool started on is still listed, with the pools that
built on it for a while, and so is one none of our feeds sent a template on, marked as such (often the active chain's block, mined
on first by its own pool, whose feed we may not collect). Pools that share a template provider in the row's epoch
(the rule of the template providers page) are grouped together.

**Going back to the block before.** A pool's run on a parent at the height normally lasts until its next template
at the height, so a pool that builds on a block at height − 1 and then returns to work at height − 1 itself, on the
block before (the active chain's block at height − 2), would look as if it stayed. The row also reads, for each pool, the
templates at height − 1 on that block that one of its connections sent right after a template of its own at the
height: a fact per connection, from the raw templates, since the de-duplicated stream takes each template's first
copy across connections and a connection still sending its last height − 1 jobs while another has moved on would
look like a return. One connection per pool, the one the de-duplicated stream ranks first, so the return is drawn on
the same stream as the rest of the lane; it is a neutral grey run, not hatched (it isn't a parent at the height),
and lasts until the pool's next template at the height. The read stays between that connection's first and last
template at the height, inside the row's window, at most 5,000 rows, so a stuck feed re-sending an old job after it
moved on isn't read. Without a stored active-chain block at height − 2 there is no such read. The row then says how many of
the pools that built on a parent other than the active chain's block went back to the block before. The block before is the
active chain's block at height − 2, not read from the parent's header (we have none for a block we never recorded).

**A soft fork's chain isn't shown.** A deployment with a mandatory-signalling window (`web/lib/softForks.ts`; BIP-110:
version bit 4, blocks 961,632 to 963,647) makes a node that enforces it reject every block in the window that doesn't
signal, so its chain can split from Bitcoin's (BIP-110's did at 961,632). Work on that chain isn't a race on Bitcoin's
chain, so the Forks page leaves it out and the summary counts it (`soft_fork_chains`). An episode is left out when its
parent is a block at height − 1 inside the window, the active chain's block there doesn't signal, and every template on the
parent signals. All three are recorded facts; nothing about the parent block itself needs to be known (at 961,634 it's
a block we never recorded).

Opening a row shows the chart at full size; a row's evidence (the checks its kind rests on and the templates around its minutes, each
labelled by the parent it built on) is behind a toggle there.

**Invalid coinbase**: the backend's analysis flags a block whose height had templates paying more than the subsidy
with no transactions to pay fees from (`invalid_coinbase_no_merkle` in `blocks.analysis`, one entry per template).
Each episode at that height that was at our tip (within one block of it, and not another chain's) carries it as a
badge: the pools and what they paid against the subsidy. A finding at a height where nothing forked is a row of its
own (kind `invalid_coinbase`), so no finding is lost. A pool excluded from the live site is in the badge too: a finding
on a block of the active chain is history.
The page's "Invalid" filter takes all invalid work, work that could never make a valid block: invalid parents and
invalid coinbases. On a row's timeline a template is marked invalid only where the finding names its pool at that
height, by the finding's own rule: empty, and its coinbase pays more than the subsidy, reassembled with the stored
extranonce2 length or the one other length that parses. So the marks agree with the finding, on whichever block the
work was (it can be the block that stayed).

**Providers per episode** (**modelled**; in the API's `providers`, no longer on the page). Several pools on one parent can be one template provider sending the same
work under different names, or several independent ones reacting to the same thing at once. Each episode counts the
[template providers](#template-providers) among its pools, with the template providers of the difficulty epoch our tip was in
when its first template arrived (not the templates' height, which for another chain is that chain's): the 80% rule
on identical transaction sets in that epoch. A pool's provider is that of its node with the most sets; a pool with
fewer than 5 sets in the epoch, or none, has an unknown provider and isn't counted as one. An epoch with no counted
heights gives no count, never another epoch's: older episodes have none until the history is counted. Like the
providers themselves, a shared provider says the pools received the same work, not that they share an owner.

**Pools excluded from the live site** follow the [site-wide rule](#pools-excluded-from-the-live-site): an excluded pool's
work at or below our tip is shown like any other pool's (its tiles, its lanes, its templates in a row's evidence, its
offenders in a finding, its template provider), and its templates above our tip are left out of every Forks read (the
next height's, while a race at the tip is still open). Forks fails closed in one more case: an excluded pool is always
left out of another chain's work, whose heights aren't Bitcoin's. The tip used is the one the summary was read at (at
most five minutes old): never ahead of ours, so it can only leave out more.

## Template providers

"Who builds the templates" on the home page groups our feeds by **template provider**: whatever chooses the
transactions. A pool brand doesn't say who that is. Several feeds can carry identical transaction sets, built by one
template provider and sent under different names. When that provider has a problem, every feed it serves has it at
about the same time.

**What is counted** (**observed**, by the backend, `template_set_*`). A height is counted once its receive window has
closed, two hours after its block, so no template for it can still arrive. Its non-empty templates are counted if they
arrived in the window ([Which templates belong to a height](#which-templates-belong-to-a-height)) and build on the
Bitcoin block at h − 1 that we know. Templates for other chains and work on parents we never recorded are not counted.

- **Node.** A template belongs to a node: its feed, plus the pool its coinbase pays or names. The pool is identified
  as a block's is: the first pool in the pool list that owns any of the coinbase's output addresses, then its
  scriptSig against the pools' tags ([Blocks](#blocks)). A coinbase that matches no pool, or doesn't parse, is an unidentified
  node, named by its feed.
- **Transaction set.** A set is the template's merkle branches, compared exactly (`sha256` of the bytes, not stored).
- **Counts.** Per height, each node gets its distinct sets and templates. Each pair of nodes gets the sets both
  received.
- **Connections.** A feed's connections count as one feed.
- **Unit.** A set at one height is a different unit from the same set at another, so counts add up exactly over any
  range of heights.
- **Empty templates are never counted.** Every pool sends the same empty set right after a block, so they would match
  anything.
- **Known limits.**
  - A pool is identified when the height is counted, so a later change to the pool list needs a backfill run.
  - History is counted in the background, downward from the newest counted height, one chunk of heights at a time
    (`TEMPLATE_SETS_BACKFILL`). Until it reaches our first stored block, the columns and the "All" pie start at the
    first counted epoch, and an epoch the walk is still inside is grouped from the heights counted so far. The API's
    `from_height` and `heights_counted` say how far it got.
  - A coinbase whose extranonce2 length doesn't reassemble is repaired as for the invalid-coinbase check: one other
    length that parses. Otherwise it is unidentified.

**What is derived** (**modelled**, when the page is read, per difficulty epoch of 2,016 blocks):

- **Sharing a provider.** Two nodes share a template provider when the sets both received are at least 80% of the
  smaller node's sets, and each has at least 5.
- **Providers.** The providers are the connected components of these links: every pair at or above the bar is a link.
  Nodes on one provider overlap almost completely. A feed can't join two separate providers: 80% of its sets on each
  would need most of its sets to be in both. Independent builders match on a few tenths of a percent of their sets, and
  no independent pair has reached 5% in any epoch. A feed that alternates between two providers overlaps each only
  partly and joins neither.
- **Which feeds a provider lists.** A feed is listed under one provider: the provider of its node with the most sets
  in that epoch, when that node has at least 5. A feed's smaller node can sit in another provider (a few of its
  templates paying another pool, sharing that pool's transaction sets) without listing the feed there.
- **Which blocks count for a provider.** A block counts for the provider of its pool's node with the most sets in
  that epoch (an unidentified block is "unidentified"). It is "not on our feeds" when none of our feeds pays its pool.
- **Miner-built.** A block whose coinbase names a DATUM template creator is miner-built, a kind of its own, split by
  creator. Creators that are the pool's own template servers are the exception (`POOL_OWN_TEMPLATE_CREATORS`, name
  prefixes, none by default): their blocks count for the pool.
- **Per epoch.** Each block counts with its own epoch's template providers. A new epoch whose first heights aren't counted yet
  uses the last counted epoch's providers. Columns are epochs; the pies are the last 144, 2,016, 12,096 and 52,416 blocks
  and all blocks from the first counted epoch, exact by height.
- **Pools excluded from the live site** are counted like any other ([the rule](#pools-excluded-from-the-live-site)): the
  counts are per height once its receive window has closed, so they are history.

**What it does not claim:**

- **Not ownership.** A shared template provider is not shared ownership or control. Feeds may buy templates from the
  same service, run the same software against the same node, or front another pool. We see only that the sets match
  ([glossary](glossary.md): template provider, operator, proxy pool).
- **Only our feeds.** A pool's blocks are attributed through the feeds we collect. Its other endpoints may be built
  differently, and a pool we don't collect from could share a provider we can't see.
- **The threshold is a choice.** It is 80% of the smaller node's sets, with at least 5 sets each. It is not a measured
  boundary. The counts behind every pair are stored, so another threshold can be applied to the same data. The rule
  says "these feeds received the same work", not why.
- **The epoch window was tested, and it blurs a change of provider.** In a pre-registered test, grouping per 144 blocks
  instead of per epoch credited 0.2% of blocks to a different provider, against a pass bar of 1%. Those blocks belong
  to the few pools whose feeds move between providers within an epoch. The epoch credits such a pool's blocks to one
  provider for the whole epoch, or to neither if it splits about evenly. Changing the 5-set minimum to anything from 2
  to 20 changed no block.
- **Timing isn't part of the rule.** Matching sets are counted whenever they arrived within the height.

## First transaction fee rate

The fee rate shown for a template's first transaction is that transaction's own fee divided by its size
(**observed**), from our Bitcoin node's record of its mempool.

When another transaction spends it and pays a higher rate (child pays for parent), a `+child` marker appears; hover it
for the child's combined rate (**modelled**). That number assumes the pool selected transactions the way Bitcoin Core
does and saw the same mempool our node saw, so it's shown beside the own rate rather than instead of it.

Only the first transaction can be identified from a template: the merkle path reveals its id and commits to the rest
without revealing them. See [first_transaction](first_transaction.md).

## Reported hashrate

`reported_hashrate` holds each pool's hashrate **as the pool reports it**, collected once a day from a third-party
pool-statistics site (`python -m reported_hashrate`, off unless configured). It is neither observed nor verified: it
is a claim the pool publishes about itself, and nothing here checks it. Summed over all pools, the claims exceed the
site's own network estimate (about 104% in one unpublished sample), so they can't all be right.

It is kept apart from block shares, which are measured from the blocks our node sees: the two are never merged into
one figure. Each row is one hour of the site's hourly series for one pool (the site's hourly average, floored to the
hour), stored with the site's network estimate at fetch time. It is the one table rewritten by design: a later fetch
overwrites the hours it covers again with the site's latest values, and `fetched_at` says which fetch a row is from.
Hours without a value have no row. A file that fails its sanity checks (too few pools, no network estimate, a series
that doesn't reconstruct to the site's own last-hour average) is not written at all, nor is anything when the site's
page names no `last_time` token (the data file is fetched with it).

## Older history

Templates recorded before mid-November 2026 came from an earlier collector (`collector/`, Python, since removed):

- Their times were taken by that program right after reading from the network, not by the kernel.
- Before January 2025 they were taken slightly later still, after the message was parsed.

They were converted as recorded, in UTC, and checked for time-zone shifts; none were found. Treat millisecond-level
differences in that period with care.

**Extranonce values before January 2025 can be stale.**
- **The cause.** That collector took `extranonce1` and `extranonce2_length` only from the response to its first request (JSON-RPC id 1). Whenever it reconnected without restarting (keep-alive reconnects and retries, from June 2024 on), the new subscribe had a different id. Templates from the new connection kept the previous connection's values. This was fixed in January 2025 (#26).
- **The effect.** When the new connection's extranonce sizes differed, `coinbase1 + extranonce1 + extranonce2 + coinbase2` no longer forms a valid transaction. A scan of every feed, sampling the first 15 s of each hour from June 2024 to November 2026, found this for a few feeds from July 2024 until the fix in January 2025, and only for isolated templates after that. One feed's mismatches in late January to early February 2025, after the fix, aren't explained by this defect. When the sizes matched, the stored `extranonce1` is simply the old connection's, and nothing in the data reveals it.
- **What it doesn't affect.** The coinbase outputs sit in `coinbase2` and are unaffected.
- **How the analysis handles it.** Every template's coinbase is reassembled and parsed strictly: exactly one input spending nothing, at least one output, no bytes missing or left over. If the stored `extranonce2_length` doesn't produce such a transaction, every other length from 0 to 16 is tried, and the coinbase is used only if exactly one length works. Nothing is inferred beyond that. Each block's analysis records, per pool, how many templates needed another length (`coinbase_parse.repaired`) and how many parsed with none (`coinbase_parse.unparsed`, not checked further), so these cases stay visible instead of being dropped.
