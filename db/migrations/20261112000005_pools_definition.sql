-- migrate:up
-- Keep each pool's full mempool/mining-pools definition (pools-v2.json entry), so pool identification can rely on
-- every field it uses, not only the modeled columns.
ALTER TABLE pools ADD COLUMN definition jsonb NOT NULL DEFAULT '{}';

-- migrate:down
ALTER TABLE pools DROP COLUMN definition;
