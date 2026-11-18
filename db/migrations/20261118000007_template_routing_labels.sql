-- migrate:up
-- One templates table, step 3 (docs/design/one-templates-table.md): the rows of templates_other move into templates,
-- and this table keeps what the collector decided about each of them at write time, as a recorded fact: `chain`
-- (as text, since the `chain` type goes with templates_other in step 4) and `reason` (e.g. 'bch',
-- 'height_implausible', 'height_parse_failed', 'unknown_chain'). It is not a classification to read templates by:
-- which chain a row belongs to is judged at read time from stored facts. Rows are written once, by the move, and
-- found again by their template's (source_id, received_at, job_id).
CREATE TABLE template_routing_labels (
    source_id   integer     NOT NULL REFERENCES sources (id),
    received_at timestamptz NOT NULL,
    height      integer     NOT NULL,
    job_id      text        NOT NULL,
    chain       text        NOT NULL,
    reason      text        NOT NULL,
    moved_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX template_routing_labels_key ON template_routing_labels (source_id, received_at);
COMMENT ON TABLE template_routing_labels IS
    'The collector''s write-time chain classification of each row moved from templates_other into templates (one '
    'templates table, step 3). A recorded fact, not how reads classify.';
GRANT SELECT ON template_routing_labels TO stratum_backend, stratum_web;

-- migrate:down
DROP TABLE template_routing_labels;
