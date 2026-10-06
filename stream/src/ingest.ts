import http from 'node:http';
import amqp from 'amqplib';
import pg from 'pg';
import { config } from './config.js';
import type { RawMessage } from './message.js';
import { Batcher, insertRouting, insertShares, insertTemplates, prepareDelivery, type IngestItem } from './db.js';
import type { TemplateRow } from './serialize.js';
import { m, registry } from './metrics.js';

async function main() {
  const db = new pg.Pool({ connectionString: config.databaseUrl, max: 4 });
  const flush = async (items: IngestItem[]) => {
    const templates: TemplateRow[] = [], shares: RawMessage[] = [], routing: RawMessage[] = [];
    for (const it of items) {
      if (it.kind === 'template') templates.push(it.row);
      else if (it.kind === 'share') shares.push(it.msg);
      else routing.push(it.msg);
    }
    const end = m.ingestBatchSeconds.startTimer();
    try {
      const t = await insertTemplates(db, templates);
      const s = await insertShares(db, shares);
      const r = await insertRouting(db, routing);
      for (const [kind, n, total] of [['template', t, templates.length], ['share', s, shares.length], ['routing', r, routing.length]] as const) {
        m.ingestWritten.inc({ kind }, n); m.ingestDuplicates.inc({ kind }, total - n);
      }
    } catch (e) { m.ingestErrors.inc(); console.error('ingest: batch write failed', e); throw e; }
    finally { end(); }
  };
  const batcher = new Batcher<IngestItem>({ maxItems: config.batchSize, maxMs: config.batchMs, flush });

  const conn = await amqp.connect(config.amqpUrl);
  conn.on('close', () => process.exit(1));
  const ch = await conn.createChannel();
  ch.on('close', () => process.exit(1));
  await ch.assertExchange(config.templateExchange, 'fanout', { durable: true });
  await ch.assertQueue(config.ingestQueue, { durable: true });
  await ch.bindQueue(config.ingestQueue, config.templateExchange, '');
  await ch.prefetch(config.batchSize * 2);
  await ch.consume(config.ingestQueue, (msg) => {
    if (!msg) return;
    const d = prepareDelivery(msg.content, Date.now());
    if ('drop' in d) {
      m.ingestDropped.inc({ reason: d.drop });
      if (d.drop !== 'unsupported_kind') console.warn(`ingest: dropping message mid=${d.mid} reason=${d.drop} detail=${d.detail}`);
      ch.ack(msg);
      return;
    }
    batcher.add(d.item).then(
      () => ch.ack(msg),
      () => setTimeout(() => { try { ch.nack(msg, false, true); } catch { /* channel gone; broker redelivers */ } }, 5000),
    );
  });

  http.createServer(async (req, res) => {
    if (req.url === '/metrics') { res.setHeader('Content-Type', registry.contentType); res.end(await registry.metrics()); return; }
    if (req.url?.startsWith('/healthz')) { res.end('ok'); return; }
    res.statusCode = 404; res.end();
  }).listen(config.port);
}
main().catch((e) => { console.error(e); process.exit(1); });
