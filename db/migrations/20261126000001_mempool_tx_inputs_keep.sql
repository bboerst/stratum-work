-- migrate:up transaction:false
-- Keep mempool_tx_inputs forever, like mempool_txs (#329). Decoding a template's positions past its first transaction
-- needs each transaction's parent links, and analyses over earlier heights need them on the earliest data too.
SELECT remove_retention_policy('mempool_tx_inputs', if_exists => true);

-- migrate:down transaction:false
-- Back to the 30-day window. The next run of the retention job drops every chunk older than 30 days.
SELECT add_retention_policy('mempool_tx_inputs', drop_after => INTERVAL '30 days', if_not_exists => true);
