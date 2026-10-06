import { createHash } from 'node:crypto';

export function computeMid(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}
