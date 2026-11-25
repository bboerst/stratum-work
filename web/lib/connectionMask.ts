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

let processKeyValue: Buffer | string | null = null;
let defaultMasker: Masker | null = null;

/** The process-wide key: EXTRANONCE1_MASK_KEY, or a random key per process (with one warning) when unset. */
function processKey(): Buffer | string {
  if (processKeyValue === null) {
    const configured = process.env.EXTRANONCE1_MASK_KEY;
    if (configured && configured.trim() !== '') {
      processKeyValue = configured.trim();
    } else {
      console.warn(
        'EXTRANONCE1_MASK_KEY is not set: extranonce1 and template ids are masked with a random per-process key, so ' +
          'they change on restart and differ between replicas. Set it (e.g. `openssl rand -hex 32`) for stable values.',
      );
      processKeyValue = randomBytes(32);
    }
  }
  return processKeyValue;
}

function processMasker(): Masker {
  if (!defaultMasker) defaultMasker = createMasker(processKey());
  return defaultMasker;
}

/** For tests: forget the process-wide key so the next call reads the environment again. */
export function resetConnectionMaskForTests(): void {
  processKeyValue = null;
  defaultMasker = null;
}

/** Pseudonym for an extranonce1 value of a pool (see the module comment). */
export function maskExtranonce1(poolName: string | null | undefined, value: unknown): unknown {
  return processMasker()(poolName, value);
}

/**
 * A copy of a template with `extranonce1` masked; anything else is returned as is. Works on the API's template shape
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
 * A live-stream message (JSON text from RabbitMQ) with `extranonce1` masked and job ids dropped (stripJobIds).
 * Messages without either pass unchanged (same text). A message that can't be parsed but mentions extranonce1 is dropped (null) rather than
 * forwarded raw.
 */
export function maskStreamMessage(data: string, masker: Masker = maskExtranonce1): string | null {
  if (!data.includes('extranonce1') && !data.includes('job_id')) return data;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const stripped = stripJobIds(parsed);
  const masked = Object.prototype.hasOwnProperty.call(stripped, 'extranonce1') ? maskTemplate(stripped, masker) : stripped;
  // Mentions the words only elsewhere (e.g. inside the coinbase text): nothing to change, the same text.
  return masked === parsed ? data : JSON.stringify(masked);
}

/**
 * Job ids are assigned by the pool per connection, like extranonce1, so the raw values can identify the collector's
 * session to the pool. The web never serves them: `job_id` and `sample_job_id` keys are dropped at any depth (stream
 * messages, block analysis). Returns the same object when there is nothing to drop.
 */
export function stripJobIds<T>(value: T): T {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(v => { const s = stripJobIds(v); if (s !== v) changed = true; return s; });
    return (changed ? out : value) as T;
  }
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'job_id' || k === 'sample_job_id') { changed = true; continue; }
    const s = stripJobIds(v);
    if (s !== v) changed = true;
    out[k] = s;
  }
  return (changed ? out : value) as T;
}

/**
 * The last part of a served template id (`<source_id>-<µs>-<this>`): it tells apart templates of one source received
 * in the same µs (one socket read), without the raw job id. Keyed (domain-separated from the extranonce1 pseudonyms)
 * and over the receive time too, so equal job ids at other times don't give equal values.
 */
export function templateIdSuffix(sourceId: number | string, receivedUs: string | number, jobId: string, key: Buffer | string = processKey()): string {
  return createHmac('sha256', key).update(`template-id\0${sourceId}\0${receivedUs}\0${jobId}`).digest('hex').slice(0, 12);
}
