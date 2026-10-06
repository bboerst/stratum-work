const trim = (s: string) => s.replace(/\/+$/, '');

export interface RuntimeEndpoints { streamEndpoint?: string; templatesEndpoint?: string }

/** Links to the raw endpoints the browser reads. */
export function rawDataLinks(cfg: RuntimeEndpoints, sinceMs: number): { templates: string | null; stream: string | null } {
  const t = cfg.templatesEndpoint?.trim();
  const s = cfg.streamEndpoint?.trim();
  return {
    templates: t ? `${trim(t)}/templates?since=${sinceMs}` : null,
    stream: s ? `${trim(s)}/stream` : null,
  };
}

export function formatFigures(summary: { k: number; effectiveNumber: number } | null): { k: string; effectiveNumber: string } {
  if (!summary) return { k: 'unavailable', effectiveNumber: 'unavailable' };
  return { k: String(summary.k), effectiveNumber: summary.effectiveNumber.toFixed(1) };
}
