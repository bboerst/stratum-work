/**
 * Where the browser gets transaction fee rates from (#198), served to it by /api/runtime-config:
 *
 *   TX_API_SOURCE                  auto (default) | local | mempool.space
 *                                  auto: local (/api/tx, this deployment's mempool data) with historical data
 *                                  enabled, else mempool.space
 *   TX_API_MEMPOOL_SPACE_FALLBACK  false (default) | true: with the local source, ask mempool.space for a txid when
 *                                  /api/tx fails or isn't supported. Transactions our node never saw are shown as
 *                                  such, not looked up elsewhere.
 */
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
    source = historical ? 'local' : 'mempool.space';
  }
  const mempoolSpaceFallback = (env.TX_API_MEMPOOL_SPACE_FALLBACK ?? 'false').trim().toLowerCase() === 'true';
  return { source, mempoolSpaceFallback };
}
