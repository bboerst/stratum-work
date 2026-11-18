-- migrate:up transaction:false
-- clock_samples: columnstore after 7 days (a procedure, so outside dbmate's transaction). Kept forever: about a
-- million rows a year per node at a 30 s scrape, small once compressed, and the evidence behind every timestamp's
-- error bound.
CALL add_columnstore_policy('clock_samples', after => INTERVAL '7 days');

-- migrate:down transaction:false
CALL remove_columnstore_policy('clock_samples', if_exists => true);
