# Glossary

One word per idea, used the same way on the site, in the docs, in issues and in analyses. Where Bitcoin Core, the
Stratum protocols or other public research already have a word, we use theirs. Each entry says what decides it and,
where it matters, what it does **not** claim: several of these are inferences from templates, and the words must not
promise more than the data shows. How each is measured is in [methodology.md](methodology.md).

Examples use made-up names (Pool A, Pool B).

## Who is who

Four words for four kinds of evidence. Mixing them up is how a guess turns into a claim.

| Term | Meaning | Decided by | Does not claim |
|---|---|---|---|
| **feed** | The templates we collect from one pool endpoint, under our own label for it ("the Pool A feed"). | Our collector configuration (`sources.name`). | That the pool built them. |
| **pool** | The mining pool a block or template pays or names: its payout address or coinbase tag. | The coinbase, matched against known addresses and tags (`pools`, `blocks.mining_pool`). | That the pool chose the transactions. |
| **template provider** | Whatever chooses a template's transactions. We see one when several feeds receive the same transaction sets at the same time; the verb is *builds* ("who builds the templates"). The word comes from the Stratum V2 role. | Identical transaction sets across feeds, per difficulty epoch: two nodes (feed, pool paid) share a template provider when the sets both received are at least 80% of the smaller node's distinct non-empty sets (at least 5 each), each node linking only to its strongest partner ([methodology](methodology.md#template-providers)). | Who runs it. Shared transactions with different merge-mining commitments still count as one template provider. |
| **operator** | The company or people running a pool or template provider. | Never our data: only outside sources (announcements, filings, public research). | Anything we measured. Sharing a template provider is not evidence of shared ownership, and the site never names an operator from template data. |
| **proxy pool** (also *front*) | A pool that hands its miners another pool's templates: the feed's templates pay or name a different pool than the feed's own. The term is from public research on template similarity. | The coinbase of the feed's own templates. | Why: a business arrangement, white-labelling or a rental is not distinguished. |
| **miner-built template** | A template whose transactions the miner chose, not the pool (as with DATUM). The **template creator** is the miner the block names as having built it. | The block's coinbase (`mining_pool.datum_template_creator`). | — |

## What we collect

| Term | Meaning | In the data |
|---|---|---|
| **template** | One unit of work a pool sends its miners: a Stratum `mining.notify` message. Bitcoin Core calls the node's version a *block template*; Stratum calls the message a *job* (we use *job* only for `job_id`). | `templates` |
| **transaction set** | The transactions a template commits to, identified by its merkle branches (the coinbase excluded). Two templates with the same branches carry the same transactions. | `templates.merkle_branches` |
| **empty template** | A template with no transactions besides the coinbase. Common for a few seconds after a block, while a pool mines on the new block before it has validated it (*SPV mining* or *headers-first mining*). Not the same as an **empty block**, a mined block with only its coinbase. | no merkle branches |
| **connection** | One collector link to a feed. A feed has one or more (labelled a, b), so a template can arrive more than once; exact copies count once. | `sources` row |
| **session** | One connect-to-disconnect of a connection. | `ingest_events` (`kind = 'session'`) |
| **node** | Our Bitcoin node. A machine running our software is a **host**. | `blocks` is written from the node |

## The chain

These follow Bitcoin Core's words.

| Term | Meaning | In the data |
|---|---|---|
| **active chain** | Our node's best chain; "our chain" on the site. | `blocks_best` |
| **tip** | The latest block of the active chain at a given moment. | `blocks` |
| **parent** | The block a template builds on (its previous-block hash). | `templates.prev_hash` |
| **stale block** | A valid block that is not on the active chain ("orphan" is an old, imprecise word for it). | `stale_blocks` |
| **reorg** | Our node switching its active chain to another branch. | `chain_reorgs` |

## What we find

| Term | Meaning | In the data |
|---|---|---|
| **finding** | The stored result of one check on one block (for example, an invalid coinbase). Facts, written when the block arrives or re-checked later. | `blocks.analysis.flags` |
| **episode** | A stretch of templates that departs from the normal state, worked out at read time from stored facts. Every episode has exactly one **kind**. | derived; not stored |
| **fork** | An episode in which feeds build on a parent other than the active chain's block. Its kinds, with the closest status Bitcoin Core's `getchaintips` would give the parent: | Forks page |
| · **race** | the parent is a stale block we recorded: two valid blocks at one height (Core: *valid-fork*, or *headers-only* when we hold only its header). | `stale_blocks` |
| · **unrecorded block** | the parent is a block hash with proof of work at Bitcoin's difficulty that our node never recorded (so Core lists nothing). Neither a rival block nor validity is shown: it may have lost a race, or never reached the network. | inferred |
| · **other chain** | the parent belongs to another chain mined on the same endpoint. | inferred |
| · **invalid parent** | the parent can't be a valid Bitcoin block (closest: *invalid*). | inferred |
| **invalid coinbase** | An episode, not a fork: templates whose coinbase pays more than the block can (an empty template paying more than the subsidy). | finding |
| **incident** | A written-up investigation of one or more episodes, with its evidence. Kept outside this repository. | — |

## Time

Bitcoin's own clock comes first: axes, buckets and ranges are in block heights; dates appear only on hover.

| Term | Meaning |
|---|---|
| **height** | A block's position in the chain. A template's height is the block it works on: one above its parent. |
| **epoch** | A difficulty epoch: the 2,016 blocks between difficulty adjustments (Core: *difficulty adjustment period*). Ranges are written in blocks ("12,096 blocks"), not in epochs. |
| **height window** | When work for a height can arrive: from the block at height − 1 to the block at height h, widened by 2 hours each side (`height_window()`). Reads use it to drop a stuck feed's old jobs and other chains' heights. |
| **refresh period** | How often a feed sends fresh work within one block. |
| **block-reset** / **free-running** | Whether a feed's refresh timer restarts at each new block or keeps its own schedule. Many restart, so independent feeds with similar periods line up just after a block; aligned updates alone are not evidence of a shared template provider. |
| **delivery spread** | How far apart in time one template reaches our different connections. |

## Words we avoid

| Word | Why | Say instead |
|---|---|---|
| backend (for a template provider) | It is also our `backend/` service. | template provider |
| group, family, stream (for a template provider) | Vague; "stream" is the site's live data stream. | template provider |
| canonical, winner, best chain | Several words for one thing. | active chain, tip |
| interesting block | Says nothing about why. | a block with findings |
| shares (for proportions) | Miners submit *shares* of work to pools. | block share, template share |
| hidden (for pools) | Three meanings. | **excluded** (left out by the server's configuration), **filtered** (the viewer's Pools menu), **duplicate** (the same template on two connections) |
