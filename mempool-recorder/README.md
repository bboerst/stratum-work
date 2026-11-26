# mempool-recorder

Follows a Bitcoin Core node's mempool and records every transaction it accepts, with first-seen time and how it left, in Postgres/TimescaleDB (#180). This is the data a template's `merkle_branches` are resolved against: `merkle_branches[0]` is the txid of the template's first non-coinbase transaction, and deeper levels need a mempool snapshot at the template's receive time.

## What it records
| Table | Rows |
|---|---|
| `mempool_txs` | One per stay in the mempool: `first_seen` (receipt of the ZMQ `A` event, UTC µs), txid and wtxid (`bytea`, **internal byte order**, the same order as `merkle_branches`; `hash_display()` gives the usual hex), size/vsize/weight, fee and modified fee, ancestor/descendant count, size and fees (from `getmempoolentry`, as of first seen), input count, then `removed_at`, `removal` and `replaced_by` / `block_hash` / `block_height`. |
| `mempool_tx_inputs` | One per input (prevout txid + vout) of each row, **kept forever** like the rows (30 days until #329): the recorder needs them for replacement/conflict detection (a tx stays at most 14 days) and the restart reload; the resolver and analyses need every transaction's parent links. |
| `mempool_blocks` | Every block connect and disconnect seen on the feed, with how many of its transactions came from our mempool and how many didn't. |
| `mempool_offmempool` | Per block, the transactions that were never in our mempool (no row in the lookback window), with their position in the block. |
| `mempool_tx_raw` | Raw transactions, only with `--store-raw` (~300 MB/day on mainnet; dropped after 14 days). |

Schema: [`db/migrations/20261116000001_mempool.sql`](../db/migrations/20261116000001_mempool.sql). Useful queries:
```sql
-- a template's first transaction (merkle_branches[0])
SELECT * FROM mempool_txs WHERE txid = substring(t.merkle_branches from 1 for 32);
-- the mempool at time t (uncompressed chunks: GiST index; older ones: bounded by first_seen)
SELECT * FROM mempool_txs WHERE tstzrange(first_seen, removed_at, '[)') @> $t
  AND first_seen > $t - interval '15 days';
```

## How removals are classified
ZMQ `R` messages carry no reason, and mined transactions get no `R` at all (the block's `C` implies them). The recorder infers the reason from Core 32's event order:

| Reason | How it's determined | Limits |
|---|---|---|
| `mined` | in a block connected while the tx was tracked (`getblock <hash> 0`, parsed) | |
| `replaced` | an `A` right after the `R` spends one of its inputs (RBF, also package RBF); descendants removed with it inherit it. `replaced_by` = the replacement | |
| `conflict` | a connected block spends one of its inputs; `replaced_by` = the block's tx | |
| `reorg` | removed between a `D` and the next `C` | heuristic |
| `expired` | older than `--mempool-expiry-hours` (the node's `-mempoolexpiry`) when removed, or descends from one | needs the setting to match the node's |
| `evicted` | the node's `mempoolminfee` is above `minrelaytxfee` (it has been trimming to size) | can't tell trimming from other non-replacement removals while the mempool is full |
| `unknown` | anything else, and transactions found gone at a resync that no recent block mined (`removed_src = 'resync'`) | |

## Sync
Subscribe to `sequence` and `rawtx` first, then `getrawmempool false true` (txids with the mempool sequence `N`), entries via batched `getmempoolentry`, then apply the buffered `A`/`R` events with sequence `N` or more. A gap in a topic's ZMQ message counter (the 4-byte third frame) on `sequence`, a block that can't be fetched, or a tracked set that keeps differing from `getmempoolinfo.size` triggers the same resync. After a restart, rows still open in the database are the previous state: transactions still in the mempool keep their row, departed ones are closed (`mined` if a block since the last recorded one has them).

## Configuration
Flags with environment fallbacks (`-h` lists all). Passwords come from the environment only.

| Env | Default | |
|---|---|---|
| `BITCOIN_RPC_HOST`, `_PORT`, `_USER`, `_PASSWORD`, `_SCHEME`, `_CA_FILE`, `_TIMEOUT` | `localhost`, `8332`, -, -, `http`, -, `30` | RPC login (see below) |
| `BITCOIN_ZMQ_SEQUENCE`, `BITCOIN_ZMQ_RAWTX` | `tcp://localhost:28334`, `:28335` | the node's `-zmqpubsequence` / `-zmqpubrawtx` |
| `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD`, `PG_SSLMODE` | -, `5432`, `stratum`, -, -, `prefer` | a login granted `stratum_mempool` |
| `MEMPOOL_STORE_RAW` | `false` | also store raw transactions |
| `MEMPOOL_EXPIRY_HOURS` | `336` | the node's `-mempoolexpiry` |
| `MEMPOOL_HTTP_PORT` | `0` (off) | `/livez`, `/readyz`, `/metrics` |

The RPC login needs only these methods (`-rpcwhitelist`): `getrawmempool,getmempoolentry,getmempoolinfo,getrawtransaction,getblock,getblockheader,getblockhash,getblockcount`. The node needs `-zmqpubsequence` and `-zmqpubrawtx` (high-water marks of 10000 or more), and transaction relay on; `-txindex` isn't needed. On a pruned node, keep enough blocks for `--resync-max-blocks` (default 144).

## Test
```bash
go test ./...                                          # parsing (mainnet vectors), state machine, pipeline
MEMPOOL_MEMORY_TEST=1 go test -run TestMemory150k -v   # RSS with a synthetic 150k-tx mempool
./test-e2e.sh                                          # regtest node + TimescaleDB + this image (Docker)
```
