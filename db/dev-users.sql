-- LOCAL DEVELOPMENT ONLY (docker compose --profile postgres): per-service login users with throwaway passwords,
-- granted the least-privilege roles from the migrations. Production users are CNPG-managed, with Secrets.
DO $$
DECLARE u record;
BEGIN
  FOR u IN SELECT * FROM (VALUES ('collector', 'stratum_collector'), ('backend', 'stratum_backend'), ('web', 'stratum_web')) AS t(name, role) LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = u.name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', u.name, u.name);
    END IF;
    EXECUTE format('GRANT %I TO %I', u.role, u.name);
  END LOOP;
END $$;
