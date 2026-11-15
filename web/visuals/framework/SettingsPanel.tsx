"use client";

import React from "react";
import type { SettingsOf, SettingsSchema } from "./types";

// Controls generated from a visual's settings schema. Visuals never build their own settings UI.

interface Props<S extends SettingsSchema> {
  schema: S;
  values: SettingsOf<S>;
  onChange: (patch: Partial<SettingsOf<S>>) => void;
  onReset: () => void;
  idPrefix: string;
}

export function SettingsPanel<S extends SettingsSchema>({ schema, values, onChange, onReset, idPrefix }: Props<S>) {
  const v = values as Record<string, unknown>;
  const set = (key: string, value: unknown) => onChange({ [key]: value } as Partial<SettingsOf<S>>);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
      {Object.entries(schema).map(([key, spec]) => {
        const id = `${idPrefix}-${key}`;
        return (
          <div key={key} className="flex flex-col gap-1">
            <label htmlFor={id} className="font-medium text-foreground" title={spec.help}>
              {spec.label}
            </label>
            {spec.type === "boolean" && (
              <input
                id={id}
                type="checkbox"
                className="h-4 w-4 accent-current"
                checked={Boolean(v[key])}
                onChange={(e) => set(key, e.target.checked)}
              />
            )}
            {spec.type === "number" && (
              <div className="flex items-center gap-2">
                <input
                  id={id}
                  type="range"
                  min={spec.min}
                  max={spec.max}
                  step={spec.step ?? 1}
                  value={Number(v[key])}
                  onChange={(e) => set(key, Number(e.target.value))}
                  className="flex-1"
                />
                <span className="tabular-nums w-16 text-right">
                  {String(v[key])}
                  {spec.unit ? ` ${spec.unit}` : ""}
                </span>
              </div>
            )}
            {spec.type === "enum" && (
              <select
                id={id}
                value={String(v[key])}
                onChange={(e) => set(key, e.target.value)}
                className="rounded border bg-background px-2 py-1"
              >
                {spec.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            )}
            {spec.help && <span className="text-muted-foreground">{spec.help}</span>}
          </div>
        );
      })}
      <div className="flex items-end">
        <button type="button" onClick={onReset} className="rounded border px-2 py-1 text-muted-foreground hover:text-foreground">
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
