-- migrate:up transaction:false
-- Columnstore (compression) background jobs. Procedures, so they run outside dbmate's transaction.
CALL add_columnstore_policy('templates', after => INTERVAL '2 days');
CALL add_columnstore_policy('templates_other', after => INTERVAL '2 days');

-- migrate:down transaction:false
CALL remove_columnstore_policy('templates_other', if_exists => true);
CALL remove_columnstore_policy('templates', if_exists => true);
