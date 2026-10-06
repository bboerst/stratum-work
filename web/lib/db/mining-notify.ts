import { LRUCache } from 'lru-cache';
import { getPool } from './pg';
import { MiningNotifyDoc, TemplateRow, templateRowToDoc } from './rows';

// Read environment variable and convert to boolean
// Default to true if the variable is not set
const enableHistoricalData = (process.env.ENABLE_HISTORICAL_DATA ?? 'true').toLowerCase() === 'true';

export const MAX_TEMPLATE_RANGE_MS = 2 * 60 * 60 * 1000;

export interface PoolFirstSeenData {
  poolName: string;
  firstSeenTimestamp: string;
  firstSeenLatencyMs: number | null;
}

// Initialize LRU cache with a max size of 500MB
const blockCache = new LRUCache({
  maxSize: 500 * 1024 * 1024,
  sizeCalculation: (value: MiningNotifyDoc[]) => {
    return JSON.stringify(value).length;
  },
  allowStale: false,
  updateAgeOnGet: true,
});

/**
 * Get mining notifications for a specific block height
 * @param height Block height
 * @returns Array of mining notifications
 */
export async function getMiningNotifyByHeight(height: number): Promise<MiningNotifyDoc[]> {
  // Check the flag first
  if (!enableHistoricalData) {
    console.log('Historical data is disabled. Skipping fetch for mining notifications.');
    return []; // Return empty array if disabled
  }

  try {
    const cacheKey = `block_${height}`;
    const cachedRecords = blockCache.get(cacheKey);
    if (cachedRecords) {
      return cachedRecords;
    }

    const { rows } = await getPool().query<TemplateRow>(
      `SELECT * FROM templates WHERE height = $1 AND chain_family IS NULL AND mode = 'observe' ORDER BY ts`,
      [height],
    );
    const records = rows.map(templateRowToDoc);

    blockCache.set(cacheKey, records);

    return records;
  } catch (error) {
    console.error('Error fetching mining notifications:', error);
    throw error;
  }
}

/**
 * Every observe-mode template at a height, including alt-chain (chain_family) rows
 * @param height Block height
 */
export async function getObserveTemplatesAtHeight(height: number): Promise<MiningNotifyDoc[]> {
  const { rows } = await getPool().query<TemplateRow>(
    `SELECT * FROM templates WHERE height = $1 AND mode = 'observe' ORDER BY ts`,
    [height],
  );
  return rows.map(templateRowToDoc);
}

/**
 * Earliest template per pool at a height, ordered by first-seen time
 * @param height Block height
 */
export async function getBlockPoolFirstSeen(height: number): Promise<PoolFirstSeenData[]> {
  const { rows } = await getPool().query<{ pool: string; ts_ns: string; lat_ms: number | null }>(
    `SELECT DISTINCT ON (pool) pool, ts_ns, lat_ms FROM templates
     WHERE height = $1 AND chain_family IS NULL AND mode = 'observe' AND pool <> ''
     ORDER BY pool, ts_ns`,
    [height],
  );
  return rows
    .map(r => ({ ns: BigInt(r.ts_ns), r }))
    .sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0))
    .map(({ ns, r }) => ({ poolName: r.pool, firstSeenTimestamp: ns.toString(16), firstSeenLatencyMs: r.lat_ms }));
}

/**
 * All templates (every mode and chain) received in [fromMs, toMs)
 * @throws RangeError when the span is empty, non-finite or longer than MAX_TEMPLATE_RANGE_MS
 */
export async function getTemplatesInRange(fromMs: number, toMs: number): Promise<MiningNotifyDoc[]> {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs - fromMs > MAX_TEMPLATE_RANGE_MS) {
    throw new RangeError('from/to must be ms timestamps spanning at most 2 hours');
  }
  const { rows } = await getPool().query<TemplateRow>(
    'SELECT * FROM templates WHERE ts >= to_timestamp($1/1000.0) AND ts < to_timestamp($2/1000.0) ORDER BY ts',
    [fromMs, toMs],
  );
  return rows.map(templateRowToDoc);
}
