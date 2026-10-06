import type { Identity, PoolDef } from './types';

const NONE: Identity = { id: null, name: 'Unknown', method: 'none' };
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function parsePoolDefs(json: unknown): PoolDef[] {
  if (!Array.isArray(json)) return [];
  return json.filter(p => p && typeof p === 'object' && 'name' in p).map((p: Record<string, unknown>) => {
    const d: PoolDef = { id: String(p.id), name: String(p.name), tags: strArr(p.tags), regexes: strArr(p.regexes), addresses: strArr(p.addresses) };
    if (typeof p.slug === 'string') d.slug = p.slug;
    if (typeof p.link === 'string') d.link = p.link;
    return d;
  });
}

function hexBytes(hex: string): number[] | null {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** Python: bytes.fromhex(s).decode('utf-8', errors='replace').replace('\n', '') */
function coinbaseText(hex: string): string | null {
  const b = hexBytes(hex);
  if (!b) return null;
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(b)).replace(/\n/g, '');
}

/** Port of _parse_datum_template_creator_names. Stops at the first invalid hex pair like the Python. */
function datumNames(hex: string): string[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    const chunk = hex.slice(i, i + 2);
    if (!/^[0-9a-fA-F]{1,2}$/.test(chunk)) break;
    bytes.push(parseInt(chunk, 16));
  }
  if (!bytes.length) return [];
  let idx = 1 + bytes[0];
  if (idx >= bytes.length) return [];
  let len = bytes[idx];
  if (len === 0x4c) { idx += 1; if (idx >= bytes.length) return []; len = bytes[idx]; }
  const start = idx + 1;
  if (start >= bytes.length) return [];
  const end = Math.min(start + len, bytes.length);
  const s = String.fromCharCode(...bytes.slice(start, end)).replace(/\x00/g, '');
  return s.split('\x0f').map(p => p.replace(/[^a-zA-Z0-9 ]/g, '').trim()).filter(Boolean);
}

const isOcean = (p: PoolDef) => [p.name, p.slug ?? '', p.id].some(s => s.toLowerCase() === 'ocean');

function withDatum(pool: PoolDef, method: 'address' | 'tag', scriptHex: string): Identity {
  const id: Identity = { id: pool.id, name: pool.name, method };
  if (isOcean(pool)) {
    const names = datumNames(scriptHex);
    for (let i = names.length - 1; i >= 0; i--) {
      const low = names[i].toLowerCase();
      if (low && !low.includes('ocean') && !low.includes('datum')) { id.datumTemplateCreator = names[i]; break; }
    }
  }
  return id;
}

function byTag(pools: PoolDef[], scriptHex: string): PoolDef | null {
  if (!scriptHex) return null;
  const text = coinbaseText(scriptHex);
  if (text === null) return null;
  for (const p of pools) {
    if (p.tags.some(t => text.includes(t))) return p;
    for (const r of p.regexes) {
      try { if (new RegExp(r, 'i').test(text)) return p; } catch { /* Python-only regex syntax: skip */ }
    }
  }
  return null;
}

export function identifyPool(pools: PoolDef[], scriptHex: string, addresses: string[]): Identity {
  if (addresses.length) {
    for (const p of pools) if (addresses.some(a => p.addresses.includes(a))) return withDatum(p, 'address', scriptHex);
  }
  const t = byTag(pools, scriptHex);
  return t ? withDatum(t, 'tag', scriptHex) : NONE;
}

export function makeIdentifier(pools: PoolDef[]) {
  const byAddr = new Map<string, PoolDef>();
  // First pool in list order wins, matching the Python loop order.
  for (const p of pools) for (const a of p.addresses) if (!byAddr.has(a)) byAddr.set(a, p);
  const order = new Map(pools.map((p, i) => [p, i] as const));
  const cache = new Map<string, Identity>();
  return (scriptHex: string, addresses: string[]): Identity => {
    const key = scriptHex + '|' + addresses.join(',');
    const hit = cache.get(key);
    if (hit) return hit;
    let best: PoolDef | undefined;
    for (const a of addresses) { const p = byAddr.get(a); if (p && (!best || order.get(p)! < order.get(best)!)) best = p; }
    let r: Identity;
    if (best) r = withDatum(best, 'address', scriptHex);
    else { const t = byTag(pools, scriptHex); r = t ? withDatum(t, 'tag', scriptHex) : NONE; }
    if (cache.size > 5000) cache.clear();
    cache.set(key, r);
    return r;
  };
}
