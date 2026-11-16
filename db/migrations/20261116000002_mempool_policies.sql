-- migrate:up transaction:false
-- Background jobs for the mempool tables (procedures, so outside dbmate's transaction).
-- mempool_txs: columnstore once rows are past the default -mempoolexpiry (see the previous migration). Kept forever.
CALL add_columnstore_policy('mempool_txs', after => INTERVAL '15 days');
-- mempool_tx_inputs: columnstore after 2 days, dropped after 30 days (the recorder needs inputs only while a tx is
-- in the mempool; the resolver gets the last 30 days).
CALL add_columnstore_policy('mempool_tx_inputs', after => INTERVAL '2 days');
SELECT add_retention_policy('mempool_tx_inputs', drop_after => INTERVAL '30 days');
-- mempool_tx_raw (only filled with --store-raw): compressed after 1 day, dropped after 14 days.
CALL add_columnstore_policy('mempool_tx_raw', after => INTERVAL '1 day');
SELECT add_retention_policy('mempool_tx_raw', drop_after => INTERVAL '14 days');

-- migrate:down transaction:false
SELECT remove_retention_policy('mempool_tx_raw', if_exists => true);
CALL remove_columnstore_policy('mempool_tx_raw', if_exists => true);
SELECT remove_retention_policy('mempool_tx_inputs', if_exists => true);
CALL remove_columnstore_policy('mempool_tx_inputs', if_exists => true);
CALL remove_columnstore_policy('mempool_txs', if_exists => true);
