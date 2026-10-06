import client from 'prom-client';
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
const c = (name: string, help: string, labelNames: string[] = []) => new client.Counter({ name, help, labelNames, registers: [registry] });
const g = (name: string, help: string, labelNames: string[] = []) => new client.Gauge({ name, help, labelNames, registers: [registry] });
export const m = {
  ingestWritten: c('ingest_written_total', 'Rows written', ['kind']),
  ingestDuplicates: c('ingest_duplicates_total', 'Duplicate rows ignored', ['kind']),
  ingestErrors: c('ingest_write_errors_total', 'Batch write failures'),
  ingestDropped: c('ingest_dropped_total', 'Messages acked without writing because they were unparseable, unsupported or invalid', ['reason']),
  ingestBatchSeconds: new client.Histogram({ name: 'ingest_batch_seconds', help: 'Batch write duration', buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] }),
  activeConnections: g('stream_active_connections', 'Open SSE connections'),
  messages: c('stream_messages_total', 'Messages ingested, by source (broker or warmup)', ['kind', 'source']),
  replayResyncs: c('stream_replay_resyncs_total', 'Replays too large for the client buffer, answered with a resync event'),
  warmupFailures: c('stream_warmup_failures_total', 'Warm-ups that failed or timed out (pod started cold)'),
  disconnects: c('stream_client_disconnects_total', 'Client disconnects', ['reason']),
  ringItems: g('stream_ring_items', 'Items in ring buffer'),
  ringOldestAge: g('stream_ring_oldest_age_seconds', 'Age of oldest ring item'),
  publisherAge: g('stream_publisher_last_message_age_seconds', 'Seconds since last template per site', ['site']),
};
