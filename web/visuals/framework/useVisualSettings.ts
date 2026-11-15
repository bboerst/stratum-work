"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { SettingsOf, SettingsSchema } from "./types";
import { queryKey, resolve, toQuery } from "./settings";

// A visual instance's settings: defaults < browser storage (the viewer's last choice) < URL (a shared link).
// Changes go to both, so a link always reproduces what's on screen. Storage can be unavailable (private windows,
// blocked site data): every access is guarded and the visual still works from defaults and the URL.

function readStored(key: string): Record<string, unknown> {
  try {
    const raw = window.localStorage.getItem(key);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeStored(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore: storage is a convenience
  }
}

export function useVisualSettings<S extends SettingsSchema>(
  visualId: string,
  schema: S,
  /** null on the visual's own page; a unique prefix per instance when several share a page. */
  queryPrefix: string | null
) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const storageKey = `visual:${visualId}:settings`;
  // Read once on mount. The /v/ route renders on the client (it reads the URL), so there's no server/client mismatch.
  const [stored, setStored] = useState<Record<string, unknown>>(() =>
    typeof window === "undefined" ? {} : readStored(storageKey)
  );

  const fromUrl = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(schema)) {
      const v = search?.get(queryKey(queryPrefix, key));
      if (v !== null && v !== undefined) out[key] = v;
    }
    return out;
  }, [search, schema, queryPrefix]);

  const settings = useMemo(() => resolve(schema, stored, fromUrl), [schema, stored, fromUrl]);

  const update = useCallback(
    (patch: Partial<SettingsOf<S>>) => {
      const next = resolve(schema, settings as Record<string, unknown>, patch as Record<string, unknown>);
      setStored(next as Record<string, unknown>);
      writeStored(storageKey, next);
      const params = new URLSearchParams(search?.toString() ?? "");
      for (const key of Object.keys(schema)) params.delete(queryKey(queryPrefix, key));
      for (const [key, value] of Object.entries(toQuery(schema, next))) params.set(queryKey(queryPrefix, key), value);
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [schema, settings, storageKey, search, queryPrefix, router, pathname]
  );

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey);
    } catch {
      // ignore
    }
    setStored({});
    const params = new URLSearchParams(search?.toString() ?? "");
    for (const key of Object.keys(schema)) params.delete(queryKey(queryPrefix, key));
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [storageKey, search, schema, queryPrefix, router, pathname]);

  return { settings, update, reset };
}
