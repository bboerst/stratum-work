/**
 * Every pool's connections (sources) with their rank by (site, replica): 1 = a, 2 = b (lib/parentKind.ts
 * connectionLabel), the ranking the views use (db/migrations/20261116200001_one_stream_per_pool.sql). Excluded pools
 * (POOL_BLACKLIST) aren't read.
 */
import { getPgPool } from './pg';
import { blacklistedPoolNames } from '../poolBlacklist';

export interface SourceRankSql { name: string; site: string; replica: string; conn: number }

export async function getSourceRanks(): Promise<SourceRankSql[]> {
  const { rows } = await getPgPool().query<SourceRankSql>(
    `SELECT name, site, replica,
            dense_rank() OVER (PARTITION BY name ORDER BY site COLLATE "C", replica COLLATE "C")::int AS conn
       FROM sources WHERE NOT (name = ANY($1::text[]))`, [blacklistedPoolNames()]);
  return rows;
}
