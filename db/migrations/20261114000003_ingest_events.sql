-- migrate:up
-- Ingest events (#105, part 2): episodes worth analyzing that aren't a single template. Written by collector-go:
--   kind 'burst'          a pool sent templates far faster than normal: started_at..ended_at, templates in the
--                         episode, peak_per_second; detail: threshold, distinct job ids / prev hashes, clean_jobs,
--                         first/last job id, per-second counts, segment / continued (long floods are written in
--                         segments of 10 minutes). The templates themselves are stored as usual.
--   kind 'sink_overflow'  the collector's Postgres queue was full and dropped templates (data loss): templates = the
--                         number dropped between started_at and ended_at.
CREATE TABLE ingest_events (
    source_id       smallint    NOT NULL REFERENCES sources (id),
    kind            text        NOT NULL CHECK (kind IN ('burst', 'sink_overflow')),
    started_at      timestamptz NOT NULL,
    ended_at        timestamptz NOT NULL CHECK (ended_at >= started_at),
    templates       integer     NOT NULL CHECK (templates >= 0),
    peak_per_second integer     NOT NULL DEFAULT 0,
    detail          jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX ingest_events_source_time ON ingest_events (source_id, started_at);
CREATE INDEX ingest_events_kind_time ON ingest_events (kind, started_at);

GRANT INSERT ON ingest_events TO stratum_collector;
GRANT SELECT ON ingest_events TO stratum_backend;

-- migrate:down
DROP TABLE ingest_events;
