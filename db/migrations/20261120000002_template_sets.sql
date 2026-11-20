-- migrate:up
-- Template providers (docs/methodology.md, "Template providers"; the home page's "Who builds the templates" via
-- /api/template-providers): counted facts about which feeds received the same transaction sets, per height, kept
-- by the backend (backend/template_sets.py) once a height's receive window has closed, plus a backfill. Which feeds
-- share a template provider is derived from these counts when they are read, never stored.
--
-- The unit is a transaction set AT A HEIGHT: a template's merkle branches (exact bytes; the coinbase excluded), for
-- templates of height h received inside h's window (template_height_windows), on a parent that is the Bitcoin block
-- at h - 1 we know (bitcoin_parents; other chains' templates and work on parents we never recorded aren't counted).
-- Empty templates (no branches) are never counted: every pool sends the same empty set after a block.
--
-- A NODE is (feed, pool paid): sources.name, and the pool the template's coinbase pays or names, identified the way
-- the backend identifies a block's pool (its output addresses against pools.addresses, else its scriptSig against
-- pools' tags; backend/analytics/pool_identification.py) when the height is filled. pool_id NULL = no pool matched
-- (or the coinbase didn't parse). A feed's connections (a, b) count as one feed: a set received on both counts once.
--
-- Per height the counts are exact and additive: a range's distinct sets per node is the sum of its heights' `sets`,
-- and the sets two nodes share the sum of their `shared`, because a set at one height is a different unit from the
-- same set at another. Rows are recomputed whole per height (delete + insert): idempotent.

-- The heights filled, with when: what has been counted (a height with no non-empty template has a row here and no
-- other rows).
CREATE TABLE template_set_heights (
    height    integer     PRIMARY KEY,
    templates integer     NOT NULL,   -- non-empty templates counted at this height (all feeds, all connections)
    filled_at timestamptz NOT NULL DEFAULT now()
);

-- Per (height, feed, pool paid): its distinct non-empty transaction sets and templates.
CREATE TABLE template_set_feeds (
    height         integer     NOT NULL,
    feed           text        NOT NULL,   -- sources.name
    pool_id        integer,                -- pools.id when filled (no FK: the pool list changes); NULL = unidentified
    sets           integer     NOT NULL,   -- distinct transaction sets
    templates      integer     NOT NULL,   -- templates carrying them, over the feed's connections
    first_received timestamptz NOT NULL,
    last_received  timestamptz NOT NULL,
    CONSTRAINT template_set_feeds_key UNIQUE NULLS NOT DISTINCT (height, feed, pool_id)
);

-- Per (height, node a, node b): the transaction sets both received, for every pair sharing at least one. a < b in
-- (feed, pool_id) order, with NULL (unidentified) first.
CREATE TABLE template_set_pairs (
    height  integer NOT NULL,
    feed_a  text    NOT NULL,
    pool_a  integer,
    feed_b  text    NOT NULL,
    pool_b  integer,
    shared  integer NOT NULL CHECK (shared > 0),
    CONSTRAINT template_set_pairs_key UNIQUE NULLS NOT DISTINCT (height, feed_a, pool_a, feed_b, pool_b)
);

COMMENT ON TABLE template_set_feeds IS
    'Per (height, feed, pool paid): distinct non-empty transaction sets and templates (backend/template_sets.py). Template providers are derived at read time.';
COMMENT ON TABLE template_set_pairs IS
    'Per (height, node a, node b): transaction sets both received (backend/template_sets.py). Template providers are derived at read time.';

GRANT SELECT, INSERT, UPDATE, DELETE ON template_set_heights, template_set_feeds, template_set_pairs TO stratum_backend;
GRANT SELECT ON template_set_heights, template_set_feeds, template_set_pairs TO stratum_web;

-- migrate:down
DROP TABLE template_set_pairs;
DROP TABLE template_set_feeds;
DROP TABLE template_set_heights;
