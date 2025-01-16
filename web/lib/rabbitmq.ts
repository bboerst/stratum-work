import amqplib from 'amqplib';

const RABBITMQ_HOST = process.env.RABBITMQ_HOST || 'rabbitmq';
const RABBITMQ_PORT = process.env.RABBITMQ_PORT || '5672';
const RABBITMQ_USERNAME = process.env.RABBITMQ_USERNAME || 'mquser';
const RABBITMQ_PASSWORD = process.env.RABBITMQ_PASSWORD || 'mqpassword';
export const RABBITMQ_EXCHANGE = process.env.RABBITMQ_EXCHANGE || 'mining_notify_exchange';

/**
 * Construct the RabbitMQ connection URL from individual environment variables.
 */
const RABBITMQ_URL = `amqp://${RABBITMQ_USERNAME}:${RABBITMQ_PASSWORD}@${RABBITMQ_HOST}:${RABBITMQ_PORT}`;

/**
 * Create a connection and channel to RabbitMQ.
 */
export async function createRabbitmqChannel() {
  const connection = await amqplib.connect(RABBITMQ_URL);
  const channel = await connection.createChannel();
  await channel.assertExchange(RABBITMQ_EXCHANGE, 'fanout', { durable: true });
  return { connection, channel };
}