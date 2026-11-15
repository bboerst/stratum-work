import type { SettingSpec, SettingsOf, SettingsSchema } from "./types";

// Settings values are parsed and validated against the schema, never trusted: they come from URLs people share
// and from browser storage.

export function defaults<S extends SettingsSchema>(schema: S): SettingsOf<S> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema)) out[key] = spec.default;
  return out as SettingsOf<S>;
}

/** One raw value (string from a URL, or anything from storage) → a valid value for the spec, or undefined. */
export function parseValue(spec: SettingSpec, raw: unknown): boolean | number | string | undefined {
  if (raw === undefined || raw === null) return undefined;
  switch (spec.type) {
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === "1" || raw === "true") return true;
      if (raw === "0" || raw === "false") return false;
      return undefined;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return undefined;
      return Math.min(spec.max, Math.max(spec.min, n));
    }
    case "enum": {
      const s = String(raw);
      return spec.options.some((o) => o.value === s) ? s : undefined;
    }
  }
}

/** Merge layers (later wins) over the defaults, keeping only valid values. */
export function resolve<S extends SettingsSchema>(schema: S, ...layers: Record<string, unknown>[]): SettingsOf<S> {
  const out: Record<string, unknown> = { ...defaults(schema) };
  for (const layer of layers) {
    for (const [key, spec] of Object.entries(schema)) {
      const v = parseValue(spec, layer[key]);
      if (v !== undefined) out[key] = v;
    }
  }
  return out as SettingsOf<S>;
}

/** URL query values for the settings that differ from the defaults (so shared links stay short). */
export function toQuery<S extends SettingsSchema>(schema: S, values: SettingsOf<S>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, spec] of Object.entries(schema)) {
    const v = (values as Record<string, unknown>)[key];
    if (v === spec.default) continue;
    out[key] = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  }
  return out;
}

/** Query keys of one visual instance: `<prefix>.<setting>` when embedded, plain `<setting>` on its own page. */
export function queryKey(prefix: string | null, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}
