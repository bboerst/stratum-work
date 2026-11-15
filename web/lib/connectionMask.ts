/**
 * Masks per-connection identifiers in everything the web serves (#105, "Connection identifiers"). Server-only: it
 * reads EXTRANONCE1_MASK_KEY and uses node:crypto, so never import it from client components.
 *
 * `extranonce1` is assigned by the pool to the collector's connection, so it identifies the collector's session (and
 * account) to the pool. The database and the collectors keep the real value; the web replaces it at its output
 * boundary (API routes and the live stream) with a pseudonym:
 *
 *   HMAC-SHA256(key, pool_name + "\0" + lower-case hex), as lower-case hex, cut to the original length.
 *
 * That keeps what the analysis needs: the length (it shapes the coinbase: extranonce1 + extranonce2 sizes), and
 * equality within a pool (the same session gives the same pseudonym, so reconnects and session changes still show),
 * without linking values across pools. Values are only stable across restarts and replicas when the key is set.
 */
import { createHmac, randomBytes } from 'node:crypto';

export type Masker = (poolName: string | null | undefined, value: unknown) => unknown;

const HEX = /^[0-9a-fA-F]*$/;

/** Hex of `length` characters from HMAC-SHA256(key, input), extended with a counter beyond 64 characters. */
function hmacHex(key: Buffer | string, input: string, length: number): string {
  let out = createHmac('sha256', key).update(input).digest('hex');
  for (let i = 1; out.length < length; i++) {
    out += createHmac('sha256', key).update(`${i}\0${input}`).digest('hex');
  }
  return out.slice(0, length);
}

/**
 * A masker with a fixed key. Never throws:
 *  - null, undefined and "" pass through unchanged;
 *  - a hex string (any case, even an odd length) → lower-case hex of the same length;
 *  - any other string → hex of the same number of characters (its real value isn't kept anywhere);
 *  - a Buffer (a raw Postgres row) → hex of the same byte length;
 *  - anything else (a pool sending a number or an object) → the masked form of its JSON text.
 */
export function createMasker(key: Buffer | string): Masker {
  return (poolName, value) => {
    if (value === null || value === undefined || value === '') return value;
    try {
      let text: string;
      if (typeof value === 'string') text = value;
      else if (Buffer.isBuffer(value)) text = value.toString('hex');
      else text = JSON.stringify(value) ?? String(value);
      const normalized = HEX.test(text) ? text.toLowerCase() : text;
      return hmacHex(key, `${poolName ?? ''}\0${normalized}`, text.length);
    } catch {
      return '';
    }
  };
}

let defaultMasker: Masker | null = null;

/** The process-wide masker: EXTRANONCE1_MASK_KEY, or a random key per process (with one warning) when unset. */
function processMasker(): Masker {
  if (!defaultMasker) {
    const configured = process.env.EXTRANONCE1_MASK_KEY;
    if (configured && configured.trim() !== '') {
      defaultMasker = createMasker(configured.trim());
    } else {
      console.warn(
        'EXTRANONCE1_MASK_KEY is not set: extranonce1 is masked with a random per-process key, so pseudonyms change ' +
          'on restart and differ between replicas. Set it (e.g. `openssl rand -hex 32`) for stable values.',
      );
      defaultMasker = createMasker(randomBytes(32));
    }
  }
  return defaultMasker;
}

/** For tests: forget the process-wide key so the next call reads the environment again. */
export function resetConnectionMaskForTests(): void {
  defaultMasker = null;
}

/** Pseudonym for an extranonce1 value of a pool (see the module comment). */
export function maskExtranonce1(poolName: string | null | undefined, value: unknown): unknown {
  return processMasker()(poolName, value);
}

/**
 * A copy of a template with `extranonce1` masked; anything else is returned as is. Works on the MongoDB/Prisma shape
 * and the stream messages (`pool_name`) and on raw Postgres rows (`source_name`, bytea Buffer).
 */
export function maskTemplate<T>(template: T, masker: Masker = maskExtranonce1): T {
  if (!template || typeof template !== 'object' || Array.isArray(template)) return template;
  if (!Object.prototype.hasOwnProperty.call(template, 'extranonce1')) return template;
  const t = template as Record<string, unknown>;
  const pool = typeof t.pool_name === 'string' ? t.pool_name : typeof t.source_name === 'string' ? t.source_name : '';
  return { ...t, extranonce1: masker(pool, t.extranonce1) } as T;
}

export function maskTemplates<T>(templates: T[], masker: Masker = maskExtranonce1): T[] {
  return templates.map(t => maskTemplate(t, masker));
}

/**
 * A live-stream message (JSON text from RabbitMQ) with `extranonce1` masked. Messages without the field pass
 * unchanged (same text). A message that can't be parsed but mentions extranonce1 is dropped (null) rather than
 * forwarded raw.
 */
export function maskStreamMessage(data: string, masker: Masker = maskExtranonce1): string | null {
  if (!data.includes('extranonce1')) return data;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (!Object.prototype.hasOwnProperty.call(parsed, 'extranonce1')) {
    // Mentions the word somewhere else (e.g. inside the coinbase text): nothing at the top level to mask.
    return data;
  }
  return JSON.stringify(maskTemplate(parsed, masker));
}
