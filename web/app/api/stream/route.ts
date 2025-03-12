import { NextRequest } from 'next/server';
import { createRabbitmqChannel, RABBITMQ_EXCHANGES, type RabbitMQConnection } from '../../../lib/rabbitmq';
import type { Channel, ConsumeMessage, Replies } from 'amqplib';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let isControllerClosed = false;
  let cleanupInitiated = false;
  let lastError: Error | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      let rabbitConnection: RabbitMQConnection | undefined;
      let channel: Channel | undefined;
      let consumer: Replies.Consume | undefined;
      let queueName = '';

      // Clean up function
      const cleanup = async () => {
        if (cleanupInitiated) return; // Prevent multiple cleanup attempts
        cleanupInitiated = true;

        try {
          if (consumer?.consumerTag && channel) {
            await channel.cancel(consumer.consumerTag).catch(() => {});
          }
          if (queueName && channel) {
            await channel.deleteQueue(queueName).catch(() => {});
          }
          if (channel) {
            await channel.close().catch(() => {});
          }
          if (rabbitConnection?.connection) {
            await rabbitConnection.connection.close().catch(() => {});
          }

          // Only close the controller if it hasn't been closed yet
          if (!isControllerClosed) {
            isControllerClosed = true;
            try {
              controller.close();
            } catch (err) {
              // Ignore all controller-related errors during cleanup
              if (!(err instanceof Error)) return;
              lastError = err;
            }
          }
        } catch (err) {
          console.error('Error during cleanup:', err);
          if (err instanceof Error) {
            lastError = err;
          }
        }
      };

      try {
        // Create a channel and declare an exclusive, auto-delete queue
        rabbitConnection = await createRabbitmqChannel();
        channel = rabbitConnection.channel;
        
        const qok = await channel.assertQueue('', { 
          exclusive: true, 
          autoDelete: true,
          arguments: {
            'x-expires': 60000 // Queue will be deleted after 60 seconds of inactivity
          }
        });
        queueName = qok.queue;
        
        // Bind to all exchanges
        for (const exchange of RABBITMQ_EXCHANGES) {
          await channel.bindQueue(queueName, exchange, '');
        }

        // Consumer: on every message, send an SSE event to the client.
        consumer = await channel.consume(queueName, (msg: ConsumeMessage | null) => {
          if (!msg || isControllerClosed || cleanupInitiated) {
            return;
          }

          try {
            const data = msg.content.toString();
            // Send an SSE event (each message preceded by "data:")
            controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            channel?.ack(msg);
          } catch (err) {
            console.error('Error processing message:', err);
            if (err instanceof Error) {
              lastError = err;
              if (err.message.includes('Controller is already closed') || 
                  err.message.includes('Invalid state')) {
                cleanup();
              }
            }
            // Always try to acknowledge the message to prevent it from being requeued
            channel?.ack(msg);
          }
        });

        // Clean up when client disconnects
        request.signal.addEventListener('abort', () => {
          console.log('Client disconnected, cleaning up...');
          cleanup();
        });

        // Send an initial message to confirm connection
        controller.enqueue(encoder.encode('data: {"type":"connection","status":"connected"}\n\n'));
      } catch (err) {
        console.error('Error setting up stream:', err);
        if (err instanceof Error) {
          lastError = err;
        }
        cleanup();
      }
    },
    cancel() {
      // This is called when the stream is cancelled (e.g., client disconnects)
      isControllerClosed = true;
      if (lastError) {
        console.error('Stream cancelled due to error:', lastError);
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
} 