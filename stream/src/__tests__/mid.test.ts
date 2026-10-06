import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { computeMid } from '../mid.js';

describe('computeMid', () => {
  it('is the first 16 bytes of sha256 of the body in hex', () => {
    const body = Buffer.from('{"pool_name":"A"}');
    expect(computeMid(body)).toBe(createHash('sha256').update(body).digest('hex').slice(0, 32));
  });
  it('differs for different bytes', () => {
    expect(computeMid(Buffer.from('a'))).not.toBe(computeMid(Buffer.from('b')));
  });
});
