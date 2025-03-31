import { PrismaClient } from '@prisma/client';

// PrismaClient is attached to the `global` object in development to prevent
// exhausting your database connection limit.
// Learn more: https://pris.ly/d/help/next-js-best-practices

// Get the database URL from environment variable with a fallback
const databaseUrl = process.env.DATABASE_URL || 'mongodb://mongouser:mongopassword@localhost:27017/stratum-logger?authSource=admin';

// Log the connection URL (without credentials) for debugging
const sanitizedUrl = databaseUrl.replace(/\/\/[^@]*@/, '//***:***@');
console.log(`Connecting to MongoDB with URL: ${sanitizedUrl}`);

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Add error handling for connection issues
prisma.$connect()
  .then(() => {
    console.log('Successfully connected to MongoDB');
  })
  .catch((error) => {
    console.error('Failed to connect to MongoDB:', error);
    // More detailed error logging
    if (error.message && error.message.includes('Authentication failed')) {
      console.error('Authentication error: Check your MongoDB credentials in DATABASE_URL');
    } else if (error.message && error.message.includes('ECONNREFUSED')) {
      console.error('Connection refused: Make sure MongoDB is running at the specified host and port');
    } else if (error.message && error.message.includes('topology was destroyed')) {
      console.error('Database connection was closed: Trying to reconnect...');
      // Try to reconnect after a delay
      setTimeout(() => {
        prisma.$connect()
          .then(() => console.log('Successfully reconnected to MongoDB'))
          .catch(e => console.error('Reconnection failed:', e));
      }, 5000);
    }
  });

export default prisma; 