-- migrate:up
-- Two more collector facts in ingest_events (same table, same isolated write path as bursts and overflows):
--   start   : a collector process started. started_at = ended_at = that time, templates 0,
--             detail {"node": the machine whose clock stamps its received_at (NULL if not configured), "version"}.
--             A pod may land on another node after every restart, and sources.replica doesn't say which, so a
--             template's node = the node of the latest start of its source at or before its received_at.
--   session : one pool connection. started_at = TCP connected, ended_at = disconnected, templates = templates
--             received, detail {"subscribed_at": when the subscribe succeeded (NULL: never; relay: the miner's
--             handshake), "end": "shutdown" or the error, "relay": true for miner-relay connections}.
--             Written when the connection ends; a killed process leaves no row for its last connection (the next
--             start bounds it).
ALTER TABLE ingest_events DROP CONSTRAINT ingest_events_kind_check;
ALTER TABLE ingest_events ADD CONSTRAINT ingest_events_kind_check
    CHECK (kind IN ('burst', 'sink_overflow', 'start', 'session'));

-- migrate:down
-- Removes the start/session rows: the old constraint can't hold them.
DELETE FROM ingest_events WHERE kind IN ('start', 'session');
ALTER TABLE ingest_events DROP CONSTRAINT ingest_events_kind_check;
ALTER TABLE ingest_events ADD CONSTRAINT ingest_events_kind_check CHECK (kind IN ('burst', 'sink_overflow'));
