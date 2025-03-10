import amqplib from 'amqplib';

const RABBITMQ_HOST = process.env.RABBITMQ_HOST || 'rabbitmq';
const RABBITMQ_PORT = process.env.RABBITMQ_PORT || '5672';
const RABBITMQ_USERNAME = process.env.RABBITMQ_USERNAME || 'mquser';
const RABBITMQ_PASSWORD = process.env.RABBITMQ_PASSWORD || 'mqpassword';
export const RABBITMQ_EXCHANGES = (process.env.RABBITMQ_EXCHANGES || 'mining_notify_exchange,blocks').split(',');

/**
 * Construct the RabbitMQ connection URL from individual environment variables.
 * Include connection options for better reliability.
 */
const RABBITMQ_URL = `amqp://${RABBITMQ_USERNAME}:${RABBITMQ_PASSWORD}@${RABBITMQ_HOST}:${RABBITMQ_PORT}`;

// Connection options for better reliability
const CONNECTION_OPTIONS = {
  heartbeat: 60, // Increased heartbeat interval (seconds)
  timeout: 30000, // Connection timeout (milliseconds)
  connectionRetries: 5, // Number of connection retries
  connectionRetryDelay: 2000, // Delay between retries (milliseconds)
};

export interface RabbitMQConnection {
  connection: {
    close(): Promise<void>;
  };
  channel: amqplib.Channel;
}

/**
 * Create a connection and channel to RabbitMQ with retry logic.
 */
export async function createRabbitmqChannel(): Promise<RabbitMQConnection> {
  let lastError: Error | null = null;
  // Use a more generic type to avoid type errors
  let conn = null;
  
  // Try to connect with retries
  for (let attempt = 1; attempt <= CONNECTION_OPTIONS.connectionRetries; attempt++) {
    try {
      // Connect with heartbeat and timeout options
      conn = await amqplib.connect(RABBITMQ_URL, {
        heartbeat: CONNECTION_OPTIONS.heartbeat,
        timeout: CONNECTION_OPTIONS.timeout,
      });
      
      break; // Connection successful, exit retry loop
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`Failed to connect to RabbitMQ (attempt ${attempt}/${CONNECTION_OPTIONS.connectionRetries}):`, lastError.message);
      
      // If this is the last attempt, throw the error
      if (attempt === CONNECTION_OPTIONS.connectionRetries) {
        throw new Error(`Failed to connect to RabbitMQ after ${CONNECTION_OPTIONS.connectionRetries} attempts: ${lastError.message}`);
      }
      
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, CONNECTION_OPTIONS.connectionRetryDelay));
    }
  }
  
  if (!conn) {
    throw new Error('Failed to establish RabbitMQ connection');
  }
  
  // Set up error handlers for the connection
  conn.on('error', (err: Error) => {
    console.error('RabbitMQ connection error:', err.message);
  });
  
  conn.on('close', () => {
    console.log('RabbitMQ connection closed');
  });
  
  // Create channel with prefetch
  const channel = await conn.createChannel();
  channel.prefetch(1); // Set prefetch to 1 to avoid overwhelming the channel
  
  // Set up error handlers for the channel
  channel.on('error', (err: Error) => {
    console.error('RabbitMQ channel error:', err.message);
  });
  
  channel.on('close', () => {
    console.log('RabbitMQ channel closed');
  });
  
  // Assert all exchanges
  for (const exchange of RABBITMQ_EXCHANGES) {
    await channel.assertExchange(exchange, 'fanout', { durable: true });
  }
  
  return { 
    connection: {
      close: async () => {
        if (conn) {
          return conn.close();
        }
        return Promise.resolve();
      }
    },
    channel 
  };
}