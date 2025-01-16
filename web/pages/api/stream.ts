import type { NextApiRequest, NextApiResponse } from 'next';
import { createRabbitmqChannel, RABBITMQ_EXCHANGE } from '../../lib/rabbitmq';

export const config = {
  api: {
    bodyParser: false, // we do not need to parse the incoming body
  },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  
  // Create a channel and declare an exclusive, auto-delete queue
  const { connection, channel } = await createRabbitmqChannel();
  const qok = await channel.assertQueue('', { exclusive: true, autoDelete: true });
  const queueName = qok.queue;
  await channel.bindQueue(queueName, RABBITMQ_EXCHANGE, '');

  // Consumer: on every message, send an SSE event to the client.
  channel.consume(queueName, (msg) => {
    if (msg) {
      const data = msg.content.toString();
      // Send an SSE event (each message preceded by "data:")
      res.write(`data: ${data}\n\n`);
      channel.ack(msg);
    }
  });

  // Clean up when client disconnects
  req.on('close', async () => {
    try {
      await channel.deleteQueue(queueName);
      await channel.close();
      await connection.close();
    } catch (err) {
      console.error('Error during RabbitMQ cleanup', err);
    }
  });
}