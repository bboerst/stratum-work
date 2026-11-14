-- migrate:up
-- Quarantine (#105): what a pool sent that the collector couldn't store as a template, kept for triage instead
-- of being dropped. One row per rejected message, written by collector-go (quarantine.go):
--   stage 'line'   no newline within the line cap          'json'  undecodable, or over a decoding limit
--         'notify' mining.notify without usable params      'row'   not storable losslessly (non-hex, out of range)
--         'suppressed' the per-source budget was spent: a marker row, then one row with the count (suppressed)
-- Odd but storable templates are NOT here: they're in templates / templates_other as usual.
-- raw holds the message as received, at most 256 KiB (raw_truncated); later rows in a budget window keep only a
-- short prefix. raw_length and raw_sha256 always describe the full message, so identical floods group by hash.
CREATE TABLE templates_rejected (
    received_at   timestamptz NOT NULL,
    source_id     smallint    NOT NULL REFERENCES sources (id),
    stage         text        NOT NULL CHECK (stage IN ('line', 'json', 'notify', 'row', 'suppressed')),
    reason        text        NOT NULL,
    raw_length    integer     NOT NULL CHECK (raw_length >= 0),
    raw_sha256    bytea,
    raw           bytea,
    raw_truncated boolean     NOT NULL DEFAULT false,
    suppressed    integer     NOT NULL DEFAULT 0 CHECK (suppressed >= 0)
);
CREATE INDEX templates_rejected_source_time ON templates_rejected (source_id, received_at);

-- Collectors only append; the backend may read it for analysis. Not exposed to the web role: raw is unvalidated
-- third-party input.
GRANT INSERT ON templates_rejected TO stratum_collector;
GRANT SELECT ON templates_rejected TO stratum_backend;

-- migrate:down
DROP TABLE templates_rejected;
