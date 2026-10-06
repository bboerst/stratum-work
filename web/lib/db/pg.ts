import pg from 'pg';

const globalForPg = globalThis as unknown as { pgPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForPg.pgPool) {
    globalForPg.pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgresql://stratum:stratum@localhost:5432/stratum',
      max: 5,
    });
    globalForPg.pgPool.on('error', err => console.error('Postgres pool error:', err));
  }
  return globalForPg.pgPool;
}
