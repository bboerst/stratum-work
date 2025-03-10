import { getBlocks as getPrismaBlocks } from './db/blocks';

export async function getBlocks(n: number, before?: number) {
  // Use the Prisma-based implementation instead of calling the backend
  return getPrismaBlocks(n, before);
} 