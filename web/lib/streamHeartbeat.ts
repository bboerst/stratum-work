// An SSE comment line (ignored by EventSource) that /api/stream sends this often, so a quiet stream never looks idle to a
// proxy or CDN in front of the web app (Cloudflare closes an origin response that sends nothing for 125 s). Templates
// normally arrive every few seconds, so this only matters when every pool is quiet.
export const HEARTBEAT_MS = 30_000;
export const HEARTBEAT = ': keepalive\n\n';
