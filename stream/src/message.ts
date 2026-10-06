import { computeMid } from './mid.js';

export type MessageKind = 'template' | 'block' | 'share' | 'routing' | 'other';
export interface RawMessage {
  mid: string; rx: number; kind: MessageKind; body: string; json: Record<string, any>;
  pool?: string; connectionId?: string; mode?: 'observe' | 'work'; site?: string;
}

export const LEGACY_SITE = 'us-ash-legacy';

export function classify(json: Record<string, any>): MessageKind {
  if (json.type === 'block') return 'block';
  if (json.type === 'share') return 'share';
  if (json.type === 'routing') return 'routing';
  if (typeof json.pool_name === 'string' && typeof json.prev_hash === 'string') return 'template';
  return 'other';
}

export function toRawMessage(body: Buffer, rx: number): RawMessage | null {
  let json: Record<string, any>;
  try { json = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (json === null || typeof json !== 'object') return null;
  const kind = classify(json);
  const msg: RawMessage = { mid: computeMid(body), rx, kind, body: body.toString('utf8'), json };
  if (kind === 'template' || kind === 'share') {
    msg.pool = json.pool_name ?? json.pool;
    msg.connectionId = json.connection_id ?? msg.pool;
    msg.site = json.site ?? LEGACY_SITE;
    msg.mode = json.mode === 'work' ? 'work' : 'observe';
  }
  return msg;
}
