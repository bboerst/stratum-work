import { readFileSync } from 'fs';
import type { ConnectionOptions } from 'tls';
import { Pool, type PoolConfig } from 'pg';

/**
 * Postgres connection for the web app (DB_BACKEND=postgres, #113). Connects as a read-only user (a member of the
 * `stratum_web` role, see db/migrations). Configuration comes from separate fields, never a connection URL, so
 * errors and logs can't print the password:
 *
 *   PG_HOST (postgres), PG_PORT (5432), PG_DATABASE (stratum), PG_USER (web), PG_PASSWORD,
 *   PG_SSLMODE (disable | require | verify-ca | verify-full; default disable), PG_SSLROOTCERT (CA file, optional)
 *
 * PG_SSLMODE follows libpq's meaning. `prefer` and `allow` aren't supported: node-postgres can't fall back from TLS
 * to plain text, so they're rejected rather than silently treated as one or the other.
 */
type Env = Record<string, string | undefined>;

export function pgSslFromEnv(env: Env, readFile: (path: string) => string = p => readFileSync(p, 'utf8')): PoolConfig['ssl'] {
  const mode = (env.PG_SSLMODE ?? 'disable').trim().toLowerCase() || 'disable';
  const ca = env.PG_SSLROOTCERT ? readFile(env.PG_SSLROOTCERT) : undefined;
  switch (mode) {
    case 'disable':
      return false;
    case 'require':
      // libpq: encrypt; verify the server only if a root certificate is given.
      return ca ? { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined } : { rejectUnauthorized: false };
    case 'verify-ca': {
      const ssl: ConnectionOptions = { rejectUnauthorized: true, checkServerIdentity: () => undefined };
      if (ca) ssl.ca = ca;
      return ssl;
    }
    case 'verify-full':
      return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true };
    default:
      throw new Error(`PG_SSLMODE must be disable, require, verify-ca or verify-full (got '${mode}')`);
  }
}

export function pgConfigFromEnv(env: Env = process.env): PoolConfig {
  const port = parseInt(env.PG_PORT ?? '5432', 10);
  if (!Number.isInteger(port) || port <= 0) throw new Error('PG_PORT must be a port number');
  return {
    host: env.PG_HOST || 'postgres',
    port,
    database: env.PG_DATABASE || 'stratum',
    user: env.PG_USER || 'web',
    password: env.PG_PASSWORD || undefined,
    ssl: pgSslFromEnv(env),
    application_name: 'stratum-work-web',
    max: 5,                          // small pool: every query is a short indexed lookup
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  };
}

const globalForPg = global as unknown as { stratumPgPool?: Pool };

/** The shared pool, created on first use (so MongoDB deployments never touch Postgres settings). */
export function getPgPool(): Pool {
  if (!globalForPg.stratumPgPool) {
    const config = pgConfigFromEnv();
    console.log(`Postgres: ${config.host}:${config.port}/${config.database} as ${config.user}`);
    const pool = new Pool(config);
    // An idle client losing its connection must not crash the server; the pool replaces it.
    pool.on('error', err => console.error('Postgres pool error:', err.message));
    globalForPg.stratumPgPool = pool;
  }
  return globalForPg.stratumPgPool;
}
