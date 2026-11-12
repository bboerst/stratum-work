/**
 * Which database the web data layer reads from (#113): DB_BACKEND = "mongodb" (default) | "postgres".
 *
 * Read on every call (it's cheap), so the read-parity script can call both implementations in one process.
 */
export type DbBackend = 'mongodb' | 'postgres';

export function dbBackend(env: Record<string, string | undefined> = process.env): DbBackend {
  const value = (env.DB_BACKEND ?? 'mongodb').trim().toLowerCase() || 'mongodb';
  if (value !== 'mongodb' && value !== 'postgres') {
    throw new Error(`DB_BACKEND must be 'mongodb' or 'postgres', got '${value}'`);
  }
  return value;
}

export function isPostgres(): boolean {
  return dbBackend() === 'postgres';
}
