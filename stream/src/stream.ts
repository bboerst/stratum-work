import amqp from 'amqplib';
import pg from 'pg';
import { config } from './config.js';
import { createBlacklist } from './blacklist.js';
import { StreamState, createServer } from './server.js';
import { LiveGate, safeWarmUp } from './warmup.js';

let ready = false; let draining = false;

async function main() {
  const state = new StreamState({ historyMinutes: config.historyMinutes, blacklist: createBlacklist(config.blacklist) });
  const server = createServer(state, {
    replayOverlapMs: config.replayOverlapMs, maxBufferBytes: config.clientBufferBytes, heartbeatMs: config.heartbeatMs,
    isReady: () => ready && !draining, sseGzip: config.sseGzip,
  });
  let conn: Awaited<ReturnType<typeof amqp.connect>> | undefined;

  // Registered first: as PID 1 without a handler, node would ignore SIGTERM until SIGKILL.
  process.once('SIGTERM', async () => {
    if (!ready) process.exit(0);
    draining = true;
    await server.drain(config.drainMs);
    server.close();
    await conn?.close().catch(() => {});
    process.exit(0);
  });

  server.listen(config.port);

  conn = await amqp.connect(config.amqpUrl);
  conn.on('close', () => { if (!draining) process.exit(1); });
  const ch = await conn.createChannel();
  ch.on('close', () => { if (!draining) process.exit(1); });
  const q = await ch.assertQueue('', { exclusive: true, autoDelete: true });
  for (const ex of [config.templateExchange, config.blocksExchange]) {
    await ch.assertExchange(ex, 'fanout', { durable: true });
    await ch.bindQueue(q.queue, ex, '');
  }

  // Bound before the DB snapshot so nothing published during warm-up is missed. Once prefetch is
  // exhausted the rest waits in the broker queue.
  const gate = new LiveGate(state, { skipWindowMs: 60_000 });
  await ch.prefetch(200);
  await ch.consume(q.queue, (msg) => { if (msg) gate.deliver(msg.content, () => ch.ack(msg)); });

  let warmMids = new Set<string>();
  if (config.databaseUrl) {
    const db = new pg.Pool({
      connectionString: config.databaseUrl, max: 2,
      connectionTimeoutMillis: Math.min(10_000, config.warmupTimeoutMs), statement_timeout: config.warmupTimeoutMs,
    });
    db.on('error', (e) => console.error(`stream: warm-up db error: ${e.message}`));
    warmMids = await safeWarmUp(db, state, Date.now() - config.historyMinutes * 60_000, config.warmupTimeoutMs);
    db.end().catch(() => {});
  }
  gate.release(warmMids);
  ready = true;
  console.log(`stream: ready on :${config.port} (warm-up ${warmMids.size} messages)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
