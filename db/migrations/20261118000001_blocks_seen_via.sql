-- migrate:up
-- How blocks.seen_at was taken. Until now seen_at was the time the backend saved the block (after getblock and the
-- analyses), so it ran late, and blocks the best-chain reconciliation found looked the same as announced ones.
--   zmq       : seen_at is when the backend received the node's ZMQ hashblock announcement.
--   reconcile : found by the reconciliation (not announced, e.g. after a reorg or an outage); seen_at is when the
--               backend detected it, so it's an upper bound on the arrival.
--   NULL      : seen_at is NULL (not seen live: gap fill, backfill), or it was set before this column existed
--               (time of the DB save, either way).
ALTER TABLE blocks ADD COLUMN seen_via text CHECK (seen_via IN ('zmq', 'reconcile'));
COMMENT ON COLUMN blocks.seen_via IS
    'How seen_at was taken: zmq = ZMQ hashblock receipt; reconcile = detection time of a block the reconciliation found; NULL = not seen live, or set before this column (DB save time).';

-- migrate:down
ALTER TABLE blocks DROP COLUMN seen_via;
