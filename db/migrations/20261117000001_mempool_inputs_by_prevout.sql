-- migrate:up
-- Children of a transaction: inputs spending it, looked up by prevout_txid (web /api/tx, CPFP: a child paying for
-- its parent raises the parent's effective fee rate). The table's only index is by its own txid, so without this an
-- uncompressed daily chunk (about a million inputs) is scanned per lookup. Compressed chunks (older than 2 days)
-- don't carry B-tree indexes; their bloom(prevout_txid) sparse index serves the same lookup.
CREATE INDEX mempool_tx_inputs_prevout ON mempool_tx_inputs (prevout_txid, first_seen);

-- migrate:down
DROP INDEX mempool_tx_inputs_prevout;
