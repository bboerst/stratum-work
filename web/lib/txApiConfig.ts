/**
 * Where the browser gets transaction fee rates from (#198), served to it by /api/runtime-config:
 *
 *   TX_API_SOURCE                  auto (default) | local | mempool.space
 *                                  auto: local (/api/tx, this deployment's mempool data) in Postgres mode with history
 *                                  enabled, else mempool.space (the previous behavior, so MongoDB deployments are
 *                                  unchanged)
 *   TX_API_MEMPOOL_SPACE_FALLBACK  false (default) | true: with the local source, ask mempool.space for a txid when
 *                                  /api/tx fails or isn't supported. Transactions our node never saw are shown as
 *                                  such, not looked up elsewhere.
 */
import { dbBackend } from './db/backend';

export type TxApiSource = 'local' | 'mempool.space';

export interface TxApiConfig {
  source: TxApiSource;
  mempoolSpaceFallback: boolean;
}

/** The previous behavior: what the browser uses when the runtime config doesn't say. */
export const LEGACY_TX_API: TxApiConfig = { source: 'mempool.space', mempoolSpaceFallback: false };

export function txApiConfigFromEnv(env: Record<string, string | undefined> = process.env): TxApiConfig {
  const raw = (env.TX_API_SOURCE ?? 'auto').trim().toLowerCase() || 'auto';
  let source: TxApiSource;
  if (raw === 'local' || raw === 'mempool.space') {
    source = raw;
  } else {
    if (raw !== 'auto') console.warn(`TX_API_SOURCE must be auto, local or mempool.space (got '${raw}'); using auto`);
    const historical = (env.ENABLE_HISTORICAL_DATA ?? 'true').toLowerCase() === 'true';
    let postgres = false;
    try {
      postgres = dbBackend(env) === 'postgres';
    } catch {
      // an invalid DB_BACKEND fails elsewhere; keep the previous behavior here
    }
    source = postgres && historical ? 'local' : 'mempool.space';
  }
  const mempoolSpaceFallback = (env.TX_API_MEMPOOL_SPACE_FALLBACK ?? 'false').trim().toLowerCase() === 'true';
  return { source, mempoolSpaceFallback };
}
