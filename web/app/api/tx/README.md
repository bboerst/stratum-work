# Transaction API (`/api/tx`)

A transaction as this deployment's Bitcoin node saw it, from the mempool recorder's tables (`mempool_txs`,
`mempool_offmempool`; [mempool-recorder](../../../../mempool-recorder/README.md)). It replaces the browser's lookups at
mempool.space for the realtime table's first-transaction fee rate (#198).

**What the table shows:** `fee_rate`, the transaction's own rate, an observed property of the transaction. A child
paying for it (CPFP) is shown next to it as a `+child` marker, with `child` in the tooltip (which transaction, when our
node saw it, the package rate, and whether both were mined in the same block). The package rate isn't shown as the
value: which transactions a pool includes, and why, isn't in the template (it reveals only the first txid), so it would
be a model of the pool's block assembly, not an observation. For a template's first transaction the own rate is also
its ancestor-package rate: in a valid block it can't have unconfirmed parents. Read-only; **Postgres deployments only**.

## Endpoints

```
GET /api/tx/<txid>[?at=<ms>]
GET /api/tx?txids=<txid>,<txid>,...[&at=<ms>]
```

| Parameter | Description |
|---|---|
| `txid` / `txids` | Display-order hex (as in RPC and block explorers), case-insensitive. At most **100** per request; duplicates are answered once. |
| `at` | Optional. When the transactions were pending, in ms since the epoch (e.g. a template's receive time). Default: now. See [Time window](#time-window). |

Responses:

```jsonc
// GET /api/tx?txids=...
{ "enabled": true, "supported": true, "txs": [ /* one per txid, in request order */ ] }
// GET /api/tx/<txid>
{ "enabled": true, "supported": true, "tx": { /* ... */ } }
// ENABLE_HISTORICAL_DATA=false: no database is touched
{ "enabled": false, "supported": false, "txs": [] }      // or "tx": null
```

`400` for a malformed txid, more than 100 txids, or a bad `at`; `500` if the database read fails.

## Fields

| Field | Meaning |
|---|---|
| `txid` | As requested (lower-case) |
| `found` | `false`: our node never saw it, neither in its mempool (within the time window) nor in a block. Only `txid` and `status: "not_seen"` follow. For a template's first transaction this is a finding in itself: the pool included something our node hadn't received (its own, out-of-band or not yet propagated). |
| `status` | `in_mempool`, `mined`, `replaced`, `conflict`, `reorg`, `expired`, `evicted`, `unknown` (how its latest stay ended, see the [recorder](../../../../mempool-recorder/README.md#how-removals-are-classified)), `off_mempool` (mined without being in our mempool at the time), `not_seen` |
| `fee` | Satoshis (`null` if it left before the recorder could ask the node) |
| `vsize`, `weight`, `size` | Virtual bytes, weight units, serialized bytes |
| `fee_rate` | `fee / vsize`, sat/vB, unrounded |
| `ancestor_fee_rate` | `ancestor_fees / ancestor_vsize`, sat/vB: with its unconfirmed ancestors, **as of first seen** |
| `child_package_fee_rate` | The highest ancestor-package rate (`ancestor_fees / ancestor_vsize`, as of the child's first seen) among its direct children first seen during its stay and by `at`; `null` without one. That package includes this transaction, so it's the rate a child paying for it (CPFP) gets it mined at |
| `child` | `null`, or the child behind `child_package_fee_rate`: `{ txid, first_seen, package_fee_rate, block_hash, same_block }`. `first_seen`: when our node first saw the child (ms). `block_hash`: the block that mined the child, as our node saw it. `same_block`: once this transaction is mined, whether the child was in the same block; `null` before |
| `effective_fee_rate` | The rate under a model of ancestor-package block assembly; see below. Not what the table shows |
| `ancestor_count`, `ancestor_vsize`, `ancestor_fees` | Including itself, as of first seen (Core's `getmempoolentry`: modified fees, sigop-adjusted vsize) |
| `descendant_count`, `descendant_vsize`, `descendant_fees` | Including itself, as of first seen (usually 1: children arrive later) |
| `first_seen` | ms since the epoch, start of the latest stay in our mempool |
| `first_seen_src` | `zmq` (µs receipt of the node's notification) or `mempool` (already in the mempool at a recorder sync; the node's entry time, whole seconds) |
| `removal` | `null` while in the mempool, else `{ at, reason, source, replaced_by, block_hash, block_height }`. `source: "resync"`: found gone at a sync, `at` is an upper bound. `replaced_by`: the replacement (`replaced`) or the block transaction that spent its input (`conflict`). |
| `offmempool` | `null`, or `{ block_hash, height, seen_at, position }`: a block that mined it while it wasn't in our mempool (`position` 1 = first after the coinbase) |

Hashes are display-order hex. Times are ms since the epoch.

## Effective fee rate vs mempool.space

`effective_fee_rate` is the rate a miner selecting by **ancestor package** (Bitcoin Core's block assembly) gets for the
transaction, computed from what our node reported when the transaction entered its mempool:

- no unconfirmed ancestors: `fee_rate`;
- with ancestors: `min(fee_rate, ancestor_fee_rate)`. Low-fee parents pull a child down to the package rate, and
  high-fee parents are mined on their own first, leaving the child at its own rate;
- then raised to `child_package_fee_rate` when that is higher: a child paying for the transaction (CPFP) gets it mined
  as part of the child's package. A template's first transaction is often exactly such a parent: 1 sat/vB on its own,
  ~200 sat/vB with the child that pays for it.

Children come from the recorder's inputs (`mempool_tx_inputs`), kept as long as the transactions (they were dropped
after 30 days before #329): where a transaction's children have no inputs stored, `child_package_fee_rate` is `null`.
Only direct children count, each with its own ancestor package as our node reported it when the child arrived;
grandchildren aren't followed. Only children seen by `at` count (`at` is rounded up to the hour, so a child seen up to
an hour after a template can be included).

mempool.space's `effectiveFeePerVsize` (its `/api/v1/cpfp/<txid>`, what the table showed before) is computed over the
transaction's **current cluster, descendants included**. The two numbers can still differ when:

- **the cluster is deeper or wider**: grandchildren, or a child's other descendants, aren't followed here;
- **ancestors confirm or change after first seen**: ours stays as of first seen, theirs is recalculated;
- **`prioritisetransaction`** on our node: ancestor fees are modified fees;
- **sigop-heavy transactions**: the ancestor vsize is sigop-adjusted, `vsize` isn't;
- their node saw the transaction and ours didn't (or the other way round).

## Time window

A transaction pending at time `at` entered the mempool at most `-mempoolexpiry` (14 days) before, so only mempool stays
first seen in `[at - 15 days, at + 1 hour)` are searched; `at` is rounded up to the hour. Without the window, a txid we
never saw would be looked for in every daily chunk ever written, and each compressed chunk costs a bloom-filter scan of
its batches plus decompressing false positives. Off-mempool records are always searched (one index lookup).

Asking about an old transaction without `at` therefore answers `found: false` unless it was mined off-mempool. The
historical block view passes each template's receive time.

## Caching

`Cache-Control: public, max-age=N`, the shortest of the answers': **10 s** if one wasn't seen (it may still arrive),
**30 s** if one is still in the mempool (it will leave), else **3600 s** (settled, short of a reorg). Errors are
`no-store`. The server also keeps each answer in memory for the same time, shared by all visitors, so the database
sees each txid about once per period. The browser (`web/lib/txFeeRates.ts`) batches every txid it needs within 250 ms
into one request and keeps fee rates per txid for the page's lifetime (unseen ones are asked again after 30 s).

## Settings

`TX_API_SOURCE` (`auto` | `local` | `mempool.space`) and `TX_API_MEMPOOL_SPACE_FALLBACK` choose where the browser gets
fee rates from (`web/lib/txApiConfig.ts`, served by `/api/runtime-config`). `auto` uses this API when historical data
is enabled and mempool.space otherwise. The local compose stack runs no mempool recorder, so it sets
`TX_API_SOURCE=mempool.space` by default.

## Performance

Measured on synthetic data (TimescaleDB 2.30, 2.4M transactions over 40 days, older than 15 days compressed), 100 txids
per request, warm cache, as the `stratum_web` role: recently seen 9 ms; never seen 15 ms; 38 days old with a matching
`at` (window entirely compressed) 95 ms. Before the time window, 100 never-seen txids took 870 ms, growing with
history. Real chunks are larger (mainnet relays several hundred thousand transactions a day), so the compressed case
scales with batches per chunk.
