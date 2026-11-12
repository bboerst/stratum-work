-- migrate:up
-- Least-privilege group roles (design doc section 2: "Database users and credentials"). NOLOGIN: environments create
-- login users (production: CNPG-managed roles with Secrets) and GRANT them one of these. Applications never use the
-- owner/superuser. Roles are cluster-wide, so creation is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stratum_collector') THEN CREATE ROLE stratum_collector NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stratum_backend')   THEN CREATE ROLE stratum_backend   NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stratum_web')       THEN CREATE ROLE stratum_web       NOLOGIN; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO stratum_collector, stratum_backend, stratum_web;

-- collector: writes templates, registers itself in sources
GRANT INSERT ON templates, templates_other TO stratum_collector;
GRANT SELECT, INSERT, UPDATE ON sources TO stratum_collector;
GRANT USAGE ON SEQUENCE sources_id_seq TO stratum_collector;

-- backend: reads templates for analytics, owns blocks and pools
GRANT SELECT ON templates, templates_other, sources TO stratum_backend;
GRANT SELECT, INSERT, UPDATE, DELETE ON blocks, pools TO stratum_backend;

-- web: read-only
GRANT SELECT ON templates, templates_other, sources, blocks, pools TO stratum_web;

-- migrate:down
REVOKE ALL ON templates, templates_other, sources, blocks, pools FROM stratum_collector, stratum_backend, stratum_web;
REVOKE ALL ON SEQUENCE sources_id_seq FROM stratum_collector;
REVOKE USAGE ON SCHEMA public FROM stratum_collector, stratum_backend, stratum_web;
DROP ROLE IF EXISTS stratum_web;
DROP ROLE IF EXISTS stratum_backend;
DROP ROLE IF EXISTS stratum_collector;
