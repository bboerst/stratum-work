-- migrate:up
-- "Interesting blocks" (R3, the web's findings list) are blocks with an analysis finding: analysis.flags. The old
-- predicate, "any analysis besides pool_identification", also matched blocks whose only extra key is the coinbase
-- parse record (analysis.coinbase_parse, stratum-work #255): a diagnostic of our own data, not a finding.
DROP INDEX blocks_interesting;
CREATE INDEX blocks_interesting ON blocks (height DESC) WHERE analysis ? 'flags';

-- migrate:down
DROP INDEX blocks_interesting;
CREATE INDEX blocks_interesting ON blocks (height DESC) WHERE (analysis - 'pool_identification') <> '{}'::jsonb;
