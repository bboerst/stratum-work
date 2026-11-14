-- migrate:up
-- Redundant collection (several collectors per pool and site, e.g. on separate nodes): each collector registers its
-- own source, identified by `replica` ('a', 'b', ...). Their rows are separate observations (job ids and coinbases
-- differ per connection), so reads that need one row per job group across replicas. Existing sources become 'a'.
ALTER TABLE sources ADD COLUMN replica text NOT NULL DEFAULT 'a' CHECK (replica <> '');
ALTER TABLE sources DROP CONSTRAINT sources_name_site_key;
ALTER TABLE sources ADD CONSTRAINT sources_name_site_replica_key UNIQUE (name, site, replica);

-- migrate:down
-- Fails (on purpose) while a pool has more than one replica at a site: merging them would conflate observations.
ALTER TABLE sources DROP CONSTRAINT sources_name_site_replica_key;
ALTER TABLE sources ADD CONSTRAINT sources_name_site_key UNIQUE (name, site);
ALTER TABLE sources DROP COLUMN replica;
