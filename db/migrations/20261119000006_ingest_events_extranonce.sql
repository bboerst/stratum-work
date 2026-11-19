-- migrate:up
-- One more collector fact in ingest_events (#263):
--   extranonce : a connection's extranonce values changed, or a pool sent other ones. started_at = ended_at = when
--                the message was received, templates 0, detail {"cause", "applied", "old", "new"}:
--                  cause "set_extranonce": a mining.set_extranonce. applied true: valid, so later templates of the
--                    connection carry "new" ({"extranonce1", "extranonce2_length"}); applied false: invalid params,
--                    ignored (detail has "error" and the "params" as sent instead of "new").
--                  cause "resubscribe": a response to the collector's own re-subscribe (latency probe, keep-alive)
--                    with values other than those in force. Recorded only, never applied (applied false).
--                "old" = the values in force when it arrived. A set_extranonce or re-subscribe response with the
--                values in force is not recorded.
ALTER TABLE ingest_events DROP CONSTRAINT ingest_events_kind_check;
ALTER TABLE ingest_events ADD CONSTRAINT ingest_events_kind_check
    CHECK (kind IN ('burst', 'sink_overflow', 'start', 'session', 'extranonce'));

-- migrate:down
-- Removes the extranonce rows: the old constraint can't hold them.
DELETE FROM ingest_events WHERE kind = 'extranonce';
ALTER TABLE ingest_events DROP CONSTRAINT ingest_events_kind_check;
ALTER TABLE ingest_events ADD CONSTRAINT ingest_events_kind_check
    CHECK (kind IN ('burst', 'sink_overflow', 'start', 'session'));
