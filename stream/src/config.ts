function num(name: string, def: number): number {
  const v = process.env[name]; return v === undefined || v === '' ? def : Number(v);
}

export const config = {
  port: num('PORT', 8080),
  amqpUrl: process.env.AMQP_URL ?? 'amqp://guest:guest@localhost:5672',
  templateExchange: process.env.TEMPLATE_EXCHANGE ?? 'mining_notify_exchange',
  blocksExchange: process.env.BLOCKS_EXCHANGE ?? 'blocks',
  ingestQueue: process.env.INGEST_QUEUE ?? 'ingest',
  databaseUrl: process.env.DATABASE_URL ?? '',
  historyMinutes: num('HISTORY_MINUTES', 60),
  clientBufferBytes: num('CLIENT_BUFFER_BYTES', 2 * 1024 * 1024),
  heartbeatMs: num('HEARTBEAT_MS', 15000),
  replayOverlapMs: num('REPLAY_OVERLAP_MS', 5000),
  drainMs: num('DRAIN_MS', 20000),
  sseGzip: process.env.SSE_GZIP === 'true',
  warmupTimeoutMs: num('WARMUP_TIMEOUT_MS', 30000),
  blacklist: process.env.POOL_BLACKLIST,
  batchSize: num('INGEST_BATCH_SIZE', 500),
  batchMs: num('INGEST_BATCH_MS', 250),
};
