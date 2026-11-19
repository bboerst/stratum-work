-- migrate:up
-- Hashrate as pools report it, collected from a third-party pool-statistics site by the backend's reported_hashrate
-- CLI (backend/reported_hashrate.py), once a day. Kept apart from everything measured here: it is a claim each pool
-- makes about itself (summed, pools claim more than the network has), never an observation of ours. See
-- docs/methodology.md "Reported hashrate".
--
-- One row per (source, pool, hour): the site's hourly series for a pool, reconstructed from its delta encoding. A
-- later fetch overwrites the hours it covers again with its values (the site's latest), so re-runs are harmless.
-- Hours the site has no value for have no row (never a zero).
CREATE TABLE reported_hashrate (
    source           text             NOT NULL,  -- the site the figures come from (REPORTED_HASHRATE_SOURCE)
    pool_key         text             NOT NULL,  -- the site's own stable id for the pool
    at               timestamptz      NOT NULL,  -- the hour of the point: the site's point time, floored to the hour
    pool_url         text,                       -- the pool's url as the site lists it, as of fetched_at
    hashrate         double precision NOT NULL,  -- H/s, as reported (the site's hourly average)
    network_hashrate double precision NOT NULL,  -- H/s, the site's network estimate when this row was fetched
    fetched_at       timestamptz      NOT NULL,  -- when this row was last written
    PRIMARY KEY (source, pool_key, at)
);
COMMENT ON TABLE reported_hashrate IS
    'Hashrate as reported by a third-party pool-statistics site; a claim, not a measurement.';

GRANT SELECT, INSERT, UPDATE ON reported_hashrate TO stratum_backend;
GRANT SELECT ON reported_hashrate TO stratum_web;

-- migrate:down
REVOKE ALL ON reported_hashrate FROM stratum_backend, stratum_web;
DROP TABLE IF EXISTS reported_hashrate;
